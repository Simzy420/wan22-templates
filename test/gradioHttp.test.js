import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createGradioHttpClient,
  outcomeFromMessage,
  positionalArgs,
  takeSseEvents,
} from "../server/gradioHttp.js";

describe("gradio http protocol", () => {
  it("splits SSE data frames and keeps a partial tail", () => {
    const parsed = takeSseEvents(
      'data: {"msg":"estimation","rank":0}\n\n' + 'data: {"msg":"process_completed","success":false,"output":{"error":null},"title":"Error"}\n\n' + "data: {partial"
    );
    assert.equal(parsed.events.length, 2);
    assert.equal(parsed.events[0].msg, "estimation");
    assert.equal(parsed.rest.includes("partial"), true);
  });

  it("keeps a degenerate-clip error string for the JSON response", () => {
    const outcome = outcomeFromMessage({
      msg: "process_completed",
      success: false,
      output: {
        error:
          "Animate returned color noise instead of a subject, so that clip was not saved. Wait 10–15 minutes and try once.",
      },
      title: "Error",
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /color noise/);
    assert.equal(outcome.data, undefined);
  });

  it("turns a null Space error into an honest failure", () => {
    const outcome = outcomeFromMessage({
      msg: "process_completed",
      success: false,
      output: { error: null },
      title: "Error",
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /failed before returning a video/i);
  });

  it("requires the still image parameter", () => {
    const parameters = [
      { parameter_name: "template_id", parameter_has_default: false },
      { parameter_name: "image", parameter_has_default: false },
      { parameter_name: "prompt", parameter_has_default: true, parameter_default: "a person" },
    ];
    assert.throws(() => positionalArgs(parameters, { template_id: "demo-wave" }), /image/);
    const file = { path: "/tmp/photo.jpg", meta: { _type: "gradio.FileData" } };
    assert.deepEqual(positionalArgs(parameters, { template_id: "demo-wave", image: file }), [
      "demo-wave",
      file,
      "a person",
    ]);
  });

  it("uploads the still and returns the queue result without @gradio/client", async () => {
    const calls = [];
    const sse = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"msg":"process_completed","success":true,"output":{"data":[{"url":"/tmp/out.mp4"},null,"ok",null,"sess-1"]}}\n\n'
          )
        );
        controller.close();
      },
    });
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url, method: init.method || "GET", body: init.body });
      if (String(url).endsWith("/config")) {
        return new Response(JSON.stringify({ dependencies: [{ api_name: "generate", id: 6 }] }), { status: 200 });
      }
      if (String(url).endsWith("/info")) {
        return new Response(
          JSON.stringify({
            named_endpoints: {
              "/generate": {
                parameters: [
                  { parameter_name: "template_id", parameter_has_default: false },
                  { parameter_name: "image", parameter_has_default: false },
                ],
              },
            },
          }),
          { status: 200 }
        );
      }
      if (String(url).endsWith("/upload")) {
        return new Response(JSON.stringify(["/tmp/gradio/photo.jpg"]), { status: 200 });
      }
      if (String(url).endsWith("/queue/join")) {
        return new Response(JSON.stringify({ event_id: "evt-1" }), { status: 200 });
      }
      if (String(url).includes("/queue/data")) {
        return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response("nope", { status: 404 });
    };
    const client = createGradioHttpClient({
      space: "https://simzy-wan-2-2-templates.hf.space",
      fetchImpl,
      config: { dependencies: [{ api_name: "generate", id: 6 }] },
      apiInfo: {
        named_endpoints: {
          "/generate": {
            parameters: [
              { parameter_name: "template_id", parameter_has_default: false },
              { parameter_name: "image", parameter_has_default: false },
            ],
          },
        },
      },
    });
    const photo = new File([Uint8Array.from([0xff, 0xd8, 0xff])], "still.jpg", { type: "image/jpeg" });
    const result = await client.predict("/generate", { template_id: "demo-walk", image: photo });
    assert.equal(result.data[4], "sess-1");
    assert.equal(result.data[0].url, "/tmp/out.mp4");
    const upload = calls.find((call) => String(call.url).endsWith("/upload"));
    assert.ok(upload);
    const join = calls.find((call) => String(call.url).endsWith("/queue/join"));
    const body = JSON.parse(join.body);
    assert.equal(body.fn_index, 6);
    assert.equal(body.data[0], "demo-walk");
    assert.equal(body.data[1].path, "/tmp/gradio/photo.jpg");
    assert.equal(body.data[1].meta._type, "gradio.FileData");
  });
});
