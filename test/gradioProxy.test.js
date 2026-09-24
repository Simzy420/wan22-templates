import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { handler } from "../netlify/functions/generate.js";
import generateRoute from "../api/generate.js";
import {
  absolutizeSpaceUrl,
  buildPredictArgs,
  fileRefUrl,
  handleGenerateRequest,
  mapPredictResult,
  normalizeApi,
} from "../server/gradioProxy.js";

const SPACE = "https://simzy-wan-2-2-templates.hf.space";

function fakeResult(sessionId = "sess-1") {
  return {
    data: [
      { video: { url: "/gradio_api/file=/tmp/out.mp4", path: "/tmp/out.mp4" } },
      { url: "https://example.com/download.mp4" },
      "**Segments:** 1  ·  session `sess-1`",
      null,
      sessionId,
    ],
  };
}

function mockConnect(calls) {
  return async () => ({
    predict: async (api, args) => {
      calls.push({ api, args });
      return fakeResult("sess-9");
    },
  });
}

describe("gradio proxy mapping", () => {
  it("unwraps Gradio video data and the session id at index 4", () => {
    const mapped = mapPredictResult(fakeResult("abc"), SPACE);
    assert.equal(mapped.video, `${SPACE}/gradio_api/file=/tmp/out.mp4`);
    assert.equal(mapped.url, mapped.video);
    assert.equal(mapped.session_id, "abc");
    assert.equal(mapped.state, "abc");
    assert.match(mapped.status, /Segments/);
  });

  it("keeps absolute file urls", () => {
    const mapped = mapPredictResult(
      { data: [{ url: "https://cdn.example/a.mp4" }, null, "ok", null, "s"] },
      SPACE
    );
    assert.equal(mapped.video, "https://cdn.example/a.mp4");
  });

  it("builds a file url from a server path", () => {
    assert.equal(
      absolutizeSpaceUrl("/tmp/gradio/a.mp4", SPACE),
      `${SPACE}/gradio_api/file=/tmp/gradio/a.mp4`
    );
    assert.equal(fileRefUrl({ video: { path: "/tmp/a.mp4" } }), "/tmp/a.mp4");
  });

  it("drops state and replaces image with the uploaded photo", () => {
    const photo = new File([Buffer.from("img")], "me.jpg", { type: "image/jpeg" });
    const args = buildPredictArgs({ template_id: "demo-wave", state: { video: "/secret" }, image: "nope" }, photo);
    assert.equal(args.template_id, "demo-wave");
    assert.equal(args.image, photo);
    assert.equal("state" in args, false);
  });

  it("allows only generate, extend, and auto_extend", () => {
    assert.equal(normalizeApi("extend"), "/extend");
    assert.throws(() => normalizeApi("/reset"), /Unsupported api/);
  });
});

describe("handleGenerateRequest", () => {
  it("rejects GET", async () => {
    const res = await handleGenerateRequest(new Request("http://local/api/generate", { method: "GET" }));
    assert.equal(res.status, 405);
    const body = await res.json();
    assert.equal(body.error, "Method not allowed");
  });

  it("posts multipart generate through the injected client and does not call the network", async () => {
    const calls = [];
    const form = new FormData();
    form.append(
      "payload",
      JSON.stringify({
        template_id: "demo-wave",
        prompt: "a person",
        session_id: "",
        state: { video: "/tmp/should-not-send" },
      })
    );
    form.append("api", "/generate");
    form.append("photo", new File([Buffer.from("jpeg-bytes")], "still.jpg", { type: "image/jpeg" }));
    const res = await handleGenerateRequest(new Request("http://local/api/generate", { method: "POST", body: form }), {
      connect: mockConnect(calls),
      env: { HF_SPACE_URL: SPACE },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.session_id, "sess-9");
    assert.equal(body.video, `${SPACE}/gradio_api/file=/tmp/out.mp4`);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].api, "/generate");
    assert.equal(calls[0].args.template_id, "demo-wave");
    assert.equal(calls[0].args.prompt, "a person");
    assert.equal("state" in calls[0].args, false);
    assert.equal(calls[0].args.image.name, "still.jpg");
    assert.ok(calls[0].args.image.size > 0);
  });

  it("posts extend and auto_extend without a photo", async () => {
    for (const api of ["/extend", "/auto_extend"]) {
      const calls = [];
      const res = await handleGenerateRequest(
        new Request("http://local/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api,
            payload: { session_id: "sess-9", prompt: "keep going", target_seconds: 12 },
          }),
        }),
        { connect: mockConnect(calls), env: {} }
      );
      assert.equal(res.status, 200);
      assert.equal(calls[0].api, api);
      assert.equal(calls[0].args.session_id, "sess-9");
      assert.equal("image" in calls[0].args, false);
      assert.equal("state" in calls[0].args, false);
    }
  });

  it("rejects an unknown api before connecting", async () => {
    let connected = false;
    const res = await handleGenerateRequest(
      new Request("http://local/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api: "/reset", payload: {} }),
      }),
      {
        connect: async () => {
          connected = true;
          return { predict: async () => ({ data: [] }) };
        },
      }
    );
    assert.equal(res.status, 400);
    assert.equal(connected, false);
    const body = await res.json();
    assert.match(body.error, /Unsupported api/);
  });

  it("returns the client error without throwing", async () => {
    const res = await handleGenerateRequest(
      new Request("http://local/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api: "/extend", payload: { session_id: "x" } }),
      }),
      {
        connect: async () => ({
          predict: async () => {
            throw { message: "Generate a clip first" };
          },
        }),
      }
    );
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error, "Generate a clip first");
  });
});

describe("platform entrypoints", () => {
  it("Vercel route fetch matches the shared handler", async () => {
    const res = await generateRoute.fetch(new Request("https://wan22-templates.vercel.app/api/generate"));
    assert.equal(res.status, 405);
  });

  it("Netlify handler decodes a base64 multipart body", async () => {
    const calls = [];
    const form = new FormData();
    form.append("api", "/generate");
    form.append("payload", JSON.stringify({ template_id: "demo-dance", session_id: "keep" }));
    form.append("photo", new File([Uint8Array.from([0xff, 0xd8, 0xff, 0x00])], "phone.jpg", { type: "image/jpeg" }));
    const request = new Request("http://local/api/generate", { method: "POST", body: form });
    const raw = Buffer.from(await request.arrayBuffer());
    const result = await handler(
      {
        httpMethod: "POST",
        headers: { "content-type": request.headers.get("content-type") },
        isBase64Encoded: true,
        body: raw.toString("base64"),
      },
      { connect: mockConnect(calls) }
    );
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.equal(body.session_id, "sess-9");
    assert.equal(calls[0].api, "/generate");
    assert.equal(calls[0].args.template_id, "demo-dance");
    assert.equal(calls[0].args.session_id, "keep");
    assert.equal(calls[0].args.image.type, "image/jpeg");
  });

  it("Netlify GET does not call the Space", async () => {
    const result = await handler({ httpMethod: "GET", headers: {} });
    assert.equal(result.statusCode, 405);
  });
});

describe("phone UI wiring", () => {
  it("ships USE_PROXY true and routes extend through the proxy", () => {
    const config = readFileSync(new URL("../public/config.js", import.meta.url), "utf8");
    const main = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
    const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
    assert.match(config, /USE_PROXY:\s*true/);
    assert.match(main, /fetch\("\/api\/generate"/);
    assert.match(main, /callSpace\(api,\s*\{\s*json:\s*args\s*\}\)/);
    assert.match(main, /callSpace\("\/generate"/);
    assert.equal(vercel.functions["api/generate.js"].maxDuration, 300);
    assert.match(vercel.functions["api/generate.js"].includeFiles, /@gradio\/client\/dist/);
    assert.equal(vercel.outputDirectory, "dist");
    assert.equal(vercel.framework, "vite");
  });
});
