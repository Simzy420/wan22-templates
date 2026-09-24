import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import videoRoute from "../api/video.js";
import { handler as netlifyVideo } from "../netlify/functions/video.js";
import { handleVideoRequest } from "../server/videoProxy.js";
import { resolveAllowedVideoUrl, rewriteSpaceVideoUrl } from "../server/videoUrl.js";

const SPACE = "https://simzy-wan-2-2-templates.hf.space";
const FILE = `${SPACE}/gradio_api/file=/tmp/out.mp4`;

function videoRequest(target, headers) {
  return new Request(`http://local/api/video?url=${encodeURIComponent(target)}`, { headers });
}

describe("video proxy allowlist", () => {
  it("rejects off-host urls without fetching", async () => {
    let called = false;
    const res = await handleVideoRequest(
      videoRequest("https://evil.example/gradio_api/file=/tmp/a.mp4"),
      {
        env: {},
        fetch: async () => {
          called = true;
          return new Response("no");
        },
      }
    );
    assert.equal(res.status, 400);
    assert.equal(called, false);
    const body = await res.json();
    assert.match(body.error, /not allowed/);
  });

  it("rejects a Space host that is not a Gradio file", async () => {
    let called = false;
    const res = await handleVideoRequest(videoRequest(`${SPACE}/config`), {
      env: {},
      fetch: async () => {
        called = true;
        return new Response("no");
      },
    });
    assert.equal(res.status, 400);
    assert.equal(called, false);
  });

  it("rejects a lookalike host", () => {
    assert.throws(
      () => resolveAllowedVideoUrl(`https://simzy-wan-2-2-templates.hf.space.evil.com/gradio_api/file=/tmp/a.mp4`, {}),
      /not allowed/
    );
  });

  it("fetches an allowlisted url and forwards Range plus HF_TOKEN", async () => {
    let seen;
    const bytes = new Uint8Array([0, 1, 2, 3]);
    const res = await handleVideoRequest(videoRequest(FILE, { Range: "bytes=0-1" }), {
      env: { HF_TOKEN: "test-token", HF_SPACE_URL: SPACE },
      fetch: async (url, init) => {
        seen = { url, range: init.headers.get("Range"), authorization: init.headers.get("Authorization") };
        return new Response(bytes, {
          status: 206,
          headers: {
            "Content-Type": "video/mp4",
            "Content-Length": "4",
            "Accept-Ranges": "bytes",
            "Content-Range": "bytes 0-1/4",
          },
        });
      },
    });
    assert.equal(res.status, 206);
    assert.equal(seen.url, FILE);
    assert.equal(seen.range, "bytes=0-1");
    assert.equal(seen.authorization, "Bearer test-token");
    assert.equal(res.headers.get("content-type"), "video/mp4");
    assert.equal(res.headers.get("content-length"), "4");
    assert.equal(res.headers.get("accept-ranges"), "bytes");
    assert.equal(res.headers.get("content-range"), "bytes 0-1/4");
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes);
  });

  it("does not send Authorization when HF_TOKEN is unset", async () => {
    let authorization = "unset";
    const res = await handleVideoRequest(videoRequest(FILE), {
      env: {},
      fetch: async (_url, init) => {
        authorization = init.headers.get("Authorization");
        return new Response(new Uint8Array([9]), {
          status: 200,
          headers: { "Content-Type": "video/mp4", "Content-Length": "1", "Accept-Ranges": "bytes" },
        });
      },
    });
    assert.equal(res.status, 200);
    assert.equal(authorization, null);
  });

  it("fetches relative Gradio file paths on the default Space", async () => {
    const seen = [];
    const fetch = async (url) => {
      seen.push(url);
      return new Response(new Uint8Array([1]), {
        status: 200,
        headers: { "Content-Type": "application/octet-stream", "Content-Length": "1" },
      });
    };
    for (const relative of ["/gradio_api/file=/tmp/out.mp4", "file=/tmp/out.mp4", "/file=/tmp/out.mp4"]) {
      const res = await handleVideoRequest(videoRequest(relative), { env: {}, fetch });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "video/mp4");
    }
    assert.deepEqual(seen, [
      `${SPACE}/gradio_api/file=/tmp/out.mp4`,
      `${SPACE}/gradio_api/file=/tmp/out.mp4`,
      `${SPACE}/file=/tmp/out.mp4`,
    ]);
  });

  it("does not follow an off-host redirect", async () => {
    const urls = [];
    const res = await handleVideoRequest(videoRequest(FILE), {
      env: {},
      fetch: async (url) => {
        urls.push(url);
        return new Response(null, { status: 302, headers: { Location: "https://evil.example/secret.mp4" } });
      },
    });
    assert.deepEqual(urls, [FILE]);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.match(body.error, /not an allowed Space file/);
  });

  it("follows a redirect that stays on an allowlisted file url", async () => {
    const next = `${SPACE}/file=/tmp/next.mp4`;
    const urls = [];
    const res = await handleVideoRequest(videoRequest(FILE), {
      env: {},
      fetch: async (url) => {
        urls.push(url);
        if (urls.length === 1) {
          return new Response(null, { status: 302, headers: { Location: next } });
        }
        return new Response(new Uint8Array([7]), { status: 200, headers: { "Content-Type": "video/mp4", "Content-Length": "1" } });
      },
    });
    assert.deepEqual(urls, [FILE, next]);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "video/mp4");
  });

  it("allows the HF_SPACE_URL host", async () => {
    const custom = "https://other-wan.hf.space";
    const target = `${custom}/gradio_api/file=/tmp/a.mp4`;
    let seen;
    const res = await handleVideoRequest(videoRequest(target), {
      env: { HF_SPACE_URL: custom },
      fetch: async (url) => {
        seen = url;
        return new Response(new Uint8Array([1]), { status: 200, headers: { "Content-Type": "video/mp4" } });
      },
    });
    assert.equal(res.status, 200);
    assert.equal(seen, target);
  });

  it("Vercel route rejects an off-host url", async () => {
    const res = await videoRoute.fetch(videoRequest("https://evil.example/gradio_api/file=/tmp/a.mp4"));
    assert.equal(res.status, 400);
  });

  it("Netlify function rejects an off-host url", async () => {
    let called = false;
    const result = await netlifyVideo(
      {
        httpMethod: "GET",
        headers: {},
        rawUrl: `https://proxy.local/api/video?url=${encodeURIComponent("https://evil.example/gradio_api/file=/tmp/a.mp4")}`,
      },
      {
        fetch: async () => {
          called = true;
          return new Response("no");
        },
      }
    );
    assert.equal(called, false);
    assert.equal(result.statusCode, 400);
    assert.equal(result.isBase64Encoded, false);
    assert.match(result.body, /not allowed/);
  });
});

describe("showResult rewrites Space URLs", () => {
  it("rewrites a Space file url for the player and the download link", () => {
    const main = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
    const show = main.slice(main.indexOf("function showResult"), main.indexOf("function statusText"));
    const rewriteAt = show.indexOf("rewriteSpaceVideoUrl(url, SPACE)");
    const srcAt = show.indexOf("resultVideo.src");
    const hrefAt = show.indexOf("btnDownload.href");
    assert.ok(rewriteAt >= 0, "showResult must rewrite the video url");
    assert.ok(srcAt > rewriteAt && hrefAt > rewriteAt);
    assert.match(show, /resultVideo\.src\s*=\s*lastResultUrl/);
    assert.match(show, /btnDownload\.href\s*=\s*lastResultUrl/);

    const absolute = `${SPACE}/gradio_api/file=/tmp/out.mp4`;
    assert.equal(rewriteSpaceVideoUrl(absolute, SPACE), `/api/video?url=${encodeURIComponent(absolute)}`);
    assert.equal(
      rewriteSpaceVideoUrl("/gradio_api/file=/tmp/out.mp4", SPACE),
      `/api/video?url=${encodeURIComponent(absolute)}`
    );
    assert.equal(rewriteSpaceVideoUrl(`/api/video?url=${encodeURIComponent(absolute)}`, SPACE), `/api/video?url=${encodeURIComponent(absolute)}`);
    assert.equal(rewriteSpaceVideoUrl("https://cdn.example/a.mp4", SPACE), "https://cdn.example/a.mp4");
  });
});

describe("status_line", () => {
  it("is Pro-aware and still names Animate and Extend", () => {
    const src = readFileSync(new URL("../space/app.py", import.meta.url), "utf8");
    const start = src.indexOf("def status_line");
    const end = src.indexOf("def do_generate");
    assert.ok(start >= 0 && end > start);
    const fn = src.slice(start, end);
    assert.match(fn, /_hf_token\(\)/);
    assert.match(fn, /ANIMATE_SPACE/);
    assert.match(fn, /EXTEND_SPACE/);
    assert.match(fn, /ZeroGPU — authenticated \(HF Pro quota when eligible\)/);
    assert.match(fn, /ZeroGPU — public queue \(set Space secret HF_TOKEN for Pro quota\)/);
    assert.doesNotMatch(fn, /free, queued\/quota-limited/);
    assert.match(src, /def _hf_token\(\)/);
    assert.match(src, /HF_TOKEN/);
    assert.match(src, /HUGGING_FACE_HUB_TOKEN/);
  });
});
