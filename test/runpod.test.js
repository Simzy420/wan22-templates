import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handler as background } from "../netlify/functions/generate-background.js";
import { handler as resultHandler } from "../netlify/functions/result.js";
import { enqueueGenerateJob, memoryJobStore, publicJob, runBackgroundJob } from "../server/jobs.js";
import { handleResultRequest } from "../server/resultVideo.js";
import {
  buildRunpodInput,
  decodeVideoBase64,
  explainRunpodFailure,
  extractRunpodVideoBase64,
  isAllowedTemplateVideoUrl,
  resolveMotionVideoUrl,
  runpodEndpoint,
  templateVideoFromCatalog,
} from "../server/runpod.js";

const MOTION =
  "https://huggingface.co/datasets/Simzy/wan22-template-clips/resolve/main/templates/demo-dance.mp4";
const ENV = {
  RUNPOD_API_KEY: "secret-key",
  RUNPOD_ENDPOINT_ID: "zrmwpir4qzs66s",
  RUNPOD_ENDPOINT_URL: "https://api.runpod.ai/v2/zrmwpir4qzs66s",
  URL: "https://swapr-casey.netlify.app",
};

function tinyMp4() {
  const bytes = Buffer.alloc(64, 0);
  bytes.writeUInt32BE(24, 0);
  bytes.write("ftyp", 4);
  bytes.write("isom", 8);
  return bytes;
}

function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

describe("Runpod Wan Animate client", () => {
  it("keeps the endpoint on api.runpod.ai and prefers the configured id", () => {
    assert.equal(runpodEndpoint(ENV), "https://api.runpod.ai/v2/zrmwpir4qzs66s");
    assert.equal(
      runpodEndpoint({
        RUNPOD_ENDPOINT_ID: "zrmwpir4qzs66s",
        RUNPOD_ENDPOINT_URL: "https://evil.example/v2/zrmwpir4qzs66s",
      }),
      "https://api.runpod.ai/v2/zrmwpir4qzs66s"
    );
    assert.equal(
      runpodEndpoint({ RUNPOD_ENDPOINT_ID: "abc", RUNPOD_ENDPOINT_URL: "https://api.runpod.ai/v2/abc/run" }),
      "https://api.runpod.ai/v2/abc"
    );
  });

  it("accepts only public Hugging Face template clips", () => {
    assert.equal(isAllowedTemplateVideoUrl(MOTION), true);
    assert.equal(isAllowedTemplateVideoUrl("http://huggingface.co/datasets/Simzy/wan22-template-clips/resolve/main/a.mp4"), false);
    assert.equal(isAllowedTemplateVideoUrl("https://evil.example/wan22-template-clips/a.mp4"), false);
    assert.equal(isAllowedTemplateVideoUrl("https://huggingface.co/datasets/other/resolve/main/a.mp4"), false);
    assert.equal(
      templateVideoFromCatalog([{ id: "demo-wave", video_path: "templates/demo-wave.mp4" }], "demo-wave"),
      "https://huggingface.co/datasets/Simzy/wan22-template-clips/resolve/main/templates/demo-wave.mp4"
    );
  });

  it("resolves a template id from the catalog when video_url is missing or not allowlisted", async () => {
    const fetchImpl = async (url) => {
      assert.match(url, /catalog\.json/);
      return {
        ok: true,
        status: 200,
        json: async () => [{ id: "demo-wave", video_path: "templates/demo-wave.mp4" }],
      };
    };
    const fromId = await resolveMotionVideoUrl({ template_id: "demo-wave" }, { fetch: fetchImpl });
    assert.match(fromId, /templates\/demo-wave\.mp4$/);
    const ignored = await resolveMotionVideoUrl(
      { template_id: "demo-wave", video_url: "https://evil.example/clip.mp4" },
      { fetch: fetchImpl }
    );
    assert.equal(ignored, fromId);
    const direct = await resolveMotionVideoUrl({ video_url: MOTION, template_id: "other" }, { fetch: fetchImpl });
    assert.equal(direct, MOTION);
  });

  it("builds a replace job with video_url and the worker defaults", () => {
    const input = buildRunpodInput({
      image_base64: "abc",
      video_url: MOTION,
      prompt: "a person",
      width: 384,
      height: 480,
      guidance: 5,
      seed: 42,
      negative: "",
    });
    assert.equal(input.video_url, MOTION);
    assert.equal("video_base64" in input, false);
    assert.equal(input.image_base64, "abc");
    assert.equal(input.width, 832);
    assert.equal(input.height, 480);
    assert.equal(input.fps, 16);
    assert.equal(input.cfg, 1);
    assert.equal(input.steps, 6);
    assert.equal(input.mode, "replace");
    assert.equal(input.seed, 42);
    assert.equal(input.negative_prompt, "blurry, low quality, distorted");
    assert.equal(input.prompt, "a person");
  });

  it("reads base64 video from output.video and from gifs", () => {
    const encoded = tinyMp4().toString("base64");
    assert.equal(extractRunpodVideoBase64({ video: encoded }), encoded);
    assert.equal(extractRunpodVideoBase64({ gifs: { "30": [encoded] } }), encoded);
    assert.ok(decodeVideoBase64(encoded));
    assert.equal(decodeVideoBase64("not-a-video"), null);
  });

  it("turns credit and auth failures into sentences", () => {
    assert.match(
      explainRunpodFailure({ httpStatus: 402, json: { error: "insufficient credits remaining" } }),
      /out of credits/
    );
    assert.match(explainRunpodFailure({ httpStatus: 401, json: { error: "Unauthorized" } }), /API key/);
    assert.equal(
      explainRunpodFailure({ json: { error: "비디오를를 찾을 수 없습니다." } }),
      "Runpod finished without a video."
    );
  });
});

describe("Generate job on Runpod", () => {
  it("does not upload the still to Hugging Face when the endpoint is configured", async () => {
    const store = memoryJobStore();
    const kicked = [];
    let uploads = 0;
    const queued = await enqueueGenerateJob(
      {
        api: "/generate",
        payload: { template_id: "demo-dance", video_url: MOTION, prompt: "a person", width: 384, seed: 42 },
        photo: new File([Uint8Array.from([9, 8, 7])], "me.jpg", { type: "image/jpeg" }),
      },
      {
        env: ENV,
        store,
        upload: async () => {
          uploads += 1;
          return { path: "/tmp/should-not-upload" };
        },
        kick: async (spec) => {
          kicked.push(spec);
        },
      }
    );
    assert.equal(uploads, 0);
    assert.equal(queued.phase, "queued");
    assert.equal(kicked.length, 1);
    assert.equal(kicked[0].backend, "runpod");
    assert.equal(kicked[0].video_url, MOTION);
    assert.equal(kicked[0].image, null);
    assert.equal(kicked[0].image_base64, Buffer.from([9, 8, 7]).toString("base64"));
    assert.equal(JSON.stringify(await store.getJSON(queued.job_id)).includes(kicked[0].image_base64), false);
  });

  it("refuses Generate when Runpod is not configured and HF fallback is off", async () => {
    let kicked = false;
    await assert.rejects(
      () =>
        enqueueGenerateJob(
          {
            api: "/generate",
            payload: { template_id: "demo-dance", video_url: MOTION },
            photo: new File([Uint8Array.from([1])], "me.jpg", { type: "image/jpeg" }),
          },
          {
            env: { URL: "https://swapr-casey.netlify.app" },
            store: memoryJobStore(),
            kick: async () => {
              kicked = true;
            },
          }
        ),
      /RUNPOD_API_KEY/
    );
    assert.equal(kicked, false);
  });

  it("polls until COMPLETED and serves a same-origin mp4", async () => {
    const store = memoryJobStore();
    const encoded = tinyMp4().toString("base64");
    const calls = [];
    let polls = 0;
    const spec = {
      job_id: "77777777-7777-4777-8777-777777777777",
      api: "/generate",
      backend: "runpod",
      payload: { template_id: "demo-dance", prompt: "a person", width: 384, seed: 7 },
      video_url: MOTION,
      image_base64: Buffer.from("still").toString("base64"),
    };
    await store.setJSON(spec.job_id, { id: spec.job_id, phase: "queued" });
    const done = await runBackgroundJob(spec, {
      store,
      env: ENV,
      intervalMs: 0,
      sleep: async () => {},
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.endsWith("/run")) {
          const body = JSON.parse(init.body);
          assert.equal(body.input.video_url, MOTION);
          assert.equal("video_base64" in body.input, false);
          assert.equal(body.input.width, 832);
          assert.equal(body.input.mode, "replace");
          assert.equal(init.headers.Authorization, "Bearer secret-key");
          return jsonRes({ id: "rp-job-1", status: "IN_QUEUE" });
        }
        polls += 1;
        if (polls === 1) return jsonRes({ id: "rp-job-1", status: "IN_PROGRESS" });
        return jsonRes({ id: "rp-job-1", status: "COMPLETED", output: { video: encoded } });
      },
    });
    assert.equal(done.phase, "done");
    assert.equal(done.video, `/api/result?id=${spec.job_id}`);
    assert.equal(done.session_id, null);
    assert.equal(JSON.stringify(done).includes("secret-key"), false);
    assert.equal(JSON.stringify(done).includes(encoded), false);
    assert.equal(publicJob(await store.getJSON(spec.job_id)).video, done.video);

    const played = await handleResultRequest(new Request(`https://swapr-casey.netlify.app/api/result?id=${spec.job_id}`), {
      store,
    });
    assert.equal(played.status, 200);
    assert.equal(played.headers.get("content-type"), "video/mp4");
    assert.equal(played.headers.get("accept-ranges"), "bytes");
    const bytes = Buffer.from(await played.arrayBuffer());
    assert.equal(bytes.subarray(4, 8).toString(), "ftyp");

    const ranged = await handleResultRequest(
      new Request(`https://swapr-casey.netlify.app/api/result?id=${spec.job_id}`, {
        headers: { Range: "bytes=0-7" },
      }),
      { store }
    );
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get("content-range"), `bytes 0-7/${tinyMp4().length}`);
    assert.equal((await ranged.arrayBuffer()).byteLength, 8);

    const netlify = await resultHandler(
      {
        httpMethod: "GET",
        headers: { host: "swapr-casey.netlify.app" },
        path: "/api/result",
        queryStringParameters: { id: spec.job_id },
        rawQuery: `id=${spec.job_id}`,
      },
      { store }
    );
    assert.equal(netlify.statusCode, 200);
    assert.equal(netlify.isBase64Encoded, true);
    assert.equal(Buffer.from(netlify.body, "base64").subarray(4, 8).toString(), "ftyp");
  });

  it("calls Runpod instead of Gradio when a generate spec was labeled hf", async () => {
    const store = memoryJobStore();
    const encoded = tinyMp4().toString("base64");
    let predicted = false;
    const spec = {
      job_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      api: "/generate",
      backend: "hf",
      payload: {
        template_id: "demo-dance",
        video_url: MOTION,
        prompt: "a person",
        width: 384,
        seed: 42,
        state: { video: "/secret" },
      },
      image: { path: "/tmp/should-not-send" },
      image_base64: Buffer.from("still").toString("base64"),
      video_url: MOTION,
    };
    await store.setJSON(spec.job_id, { id: spec.job_id, phase: "queued" });
    const done = await runBackgroundJob(spec, {
      store,
      env: ENV,
      connect: async () => ({
        predict: async () => {
          predicted = true;
          throw new Error("Gradio should not run Generate when Runpod is configured");
        },
      }),
      fetch: async (url, init) => {
        assert.match(url, /api\.runpod\.ai\/v2\/zrmwpir4qzs66s\/run$/);
        const body = JSON.parse(init.body);
        assert.equal(body.input.video_url, MOTION);
        assert.equal(body.input.image_base64, spec.image_base64);
        assert.equal("video_base64" in body.input, false);
        assert.equal(init.headers.Authorization, "Bearer secret-key");
        return jsonRes({ id: "rp-hf-label", status: "COMPLETED", output: { video: encoded } });
      },
    });
    assert.equal(predicted, false);
    assert.equal(done.phase, "done");
    assert.equal(done.video, `/api/result?id=${spec.job_id}`);
    assert.equal(JSON.stringify(done).includes("secret-key"), false);
  });

  it("does not send an unprepared generate job to Gradio when Runpod is configured", async () => {
    const store = memoryJobStore();
    let predicted = false;
    const spec = {
      job_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      api: "/generate",
      backend: "hf",
      payload: { template_id: "demo-dance", video_url: MOTION, prompt: "a person" },
      image: { path: "/tmp/gradio/me.jpg" },
    };
    await store.setJSON(spec.job_id, { id: spec.job_id, phase: "queued" });
    const failed = await runBackgroundJob(spec, {
      store,
      env: ENV,
      connect: async () => ({
        predict: async () => {
          predicted = true;
          throw new Error("Gradio should not see video_url");
        },
      }),
      fetch: async () => {
        throw new Error("Runpod should not be called without a still");
      },
    });
    assert.equal(predicted, false);
    assert.equal(failed.phase, "error");
    assert.match(failed.error, /not prepared/);
    assert.equal(failed.video, undefined);
  });

  it("stores an out-of-credits error and does not invent a video", async () => {
    const store = memoryJobStore();
    const spec = {
      job_id: "88888888-8888-4888-8888-888888888888",
      api: "/generate",
      backend: "runpod",
      payload: { prompt: "a person" },
      video_url: MOTION,
      image_base64: Buffer.from("still").toString("base64"),
    };
    const failed = await background(
      { body: JSON.stringify(spec), headers: {} },
      {
        store,
        env: ENV,
        fetch: async () => jsonRes({ error: "You have insufficient credits to run this request." }, 402),
      }
    );
    assert.equal(failed.statusCode, 202);
    const record = await store.getJSON(spec.job_id);
    assert.equal(record.phase, "error");
    assert.match(record.error, /out of credits/);
    assert.equal(record.result, undefined);
    const missing = await handleResultRequest(
      new Request(`https://swapr-casey.netlify.app/api/result?id=${spec.job_id}`),
      { store }
    );
    assert.equal(missing.status, 404);
  });

  it("surfaces a FAILED job and a completed job with no video", async () => {
    const store = memoryJobStore();
    const base = {
      api: "/generate",
      backend: "runpod",
      video_url: MOTION,
      image_base64: Buffer.from("still").toString("base64"),
      payload: { prompt: "a person" },
    };
    const failed = await runBackgroundJob(
      { ...base, job_id: "99999999-9999-4999-8999-999999999999" },
      {
        store,
        env: ENV,
        sleep: async () => {},
        intervalMs: 0,
        fetch: async (url) => {
          if (url.endsWith("/run")) return jsonRes({ id: "rp-fail", status: "IN_QUEUE" });
          return jsonRes({ id: "rp-fail", status: "FAILED", error: "worker exploded" });
        },
      }
    );
    assert.equal(failed.phase, "error");
    assert.match(failed.error, /worker exploded/);

    const empty = await runBackgroundJob(
      { ...base, job_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      {
        store,
        env: ENV,
        fetch: async () => jsonRes({ id: "rp-empty", status: "COMPLETED", output: { error: "비디오를를 찾을 수 없습니다." } }),
      }
    );
    assert.equal(empty.phase, "error");
    assert.match(empty.error, /without a video/);
    assert.equal(empty.video, undefined);
  });
});
