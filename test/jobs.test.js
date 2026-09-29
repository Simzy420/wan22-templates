import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handler as background } from "../netlify/functions/generate-background.js";
import { handler as jobHandler } from "../netlify/functions/job.js";
import { enqueueGenerateJob, kickBackground, memoryJobStore, publicJob, runBackgroundJob } from "../server/jobs.js";

const SPACE_FILE = "https://simzy-wan-2-2-templates.hf.space/gradio_api/file=/tmp/out.mp4";

function fakePredict() {
  return {
    data: [
      { url: "/tmp/out.mp4" },
      null,
      "done",
      null,
      "sess-job",
    ],
  };
}

describe("generate jobs", () => {
  it("uploads the still, stores a queued job, and kicks the worker with the file path", async () => {
    const store = memoryJobStore();
    const kicked = [];
    const queued = await enqueueGenerateJob(
      {
        api: "/generate",
        payload: { template_id: "my-clip-1", prompt: "a person" },
        photo: new File([Uint8Array.from([1, 2, 3])], "me.jpg", { type: "image/jpeg" }),
      },
      {
        env: { HF_SPACE_URL: "https://simzy-wan-2-2-templates.hf.space", URL: "https://swapr-casey.netlify.app" },
        store,
        upload: async (file) => ({
          path: "/tmp/gradio/me.jpg",
          orig_name: file.name,
          mime_type: file.type,
          size: file.size,
          meta: { _type: "gradio.FileData" },
        }),
        kick: async (spec) => {
          kicked.push(spec);
        },
      }
    );
    assert.equal(queued.phase, "queued");
    assert.equal(kicked.length, 1);
    assert.equal(kicked[0].job_id, queued.job_id);
    assert.equal(kicked[0].image.path, "/tmp/gradio/me.jpg");
    assert.equal(kicked[0].payload.template_id, "my-clip-1");
    assert.equal((await store.getJSON(queued.job_id)).phase, "queued");
  });

  it("runs the worker once and serves the result from the job endpoint", async () => {
    const store = memoryJobStore();
    const spec = {
      job_id: "22222222-2222-4222-8222-222222222222",
      api: "/generate",
      payload: { template_id: "demo-dance" },
      image: { path: "/tmp/gradio/me.jpg", meta: { _type: "gradio.FileData" }, orig_name: "me.jpg" },
    };
    await store.setJSON(spec.job_id, { id: spec.job_id, phase: "queued" });
    let predicts = 0;
    const done = await runBackgroundJob(spec, {
      store,
      connect: async () => ({
        predict: async (api, args) => {
          predicts += 1;
          assert.equal(api, "/generate");
          assert.equal(args.template_id, "demo-dance");
          assert.equal(args.image.path, "/tmp/gradio/me.jpg");
          return fakePredict();
        },
      }),
    });
    assert.equal(done.phase, "done");
    assert.equal(done.session_id, "sess-job");
    assert.match(done.video, /\/api\/video\?url=/);
    assert.match(decodeURIComponent(done.video), new RegExp(SPACE_FILE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const again = await runBackgroundJob(spec, {
      store,
      connect: async () => ({
        predict: async () => {
          predicts += 1;
          return fakePredict();
        },
      }),
    });
    assert.equal(predicts, 1);
    assert.equal(again.phase, "done");

    const polled = await jobHandler(
      { httpMethod: "GET", queryStringParameters: { id: spec.job_id }, headers: {} },
      { store }
    );
    assert.equal(polled.statusCode, 200);
    assert.equal(JSON.parse(polled.body).phase, "done");
    assert.equal(publicJob(await store.getJSON(spec.job_id)).video, done.video);
  });

  it("stores a Space failure instead of a template clip", async () => {
    const store = memoryJobStore();
    const spec = {
      job_id: "33333333-3333-4333-8333-333333333333",
      api: "/generate",
      payload: { template_id: "demo-wave" },
      image: { path: "/tmp/gradio/me.jpg", meta: { _type: "gradio.FileData" } },
    };
    const failed = await background(
      { body: JSON.stringify(spec), headers: {} },
      {
        store,
        connect: async () => ({
          predict: async () => {
            throw new Error("ZeroGPU quota exceeded");
          },
        }),
      }
    );
    assert.equal(failed.statusCode, 202);
    const record = await store.getJSON(spec.job_id);
    assert.equal(record.phase, "error");
    assert.match(record.error, /quota/);
    const polled = await jobHandler({ httpMethod: "GET", queryStringParameters: { id: spec.job_id } }, { store });
    assert.equal(JSON.parse(polled.body).phase, "error");
    assert.equal(JSON.parse(polled.body).video, undefined);
  });

  it("stops waiting if the worker does not accept the job", async () => {
    await assert.rejects(
      () =>
        kickBackground(
          { job_id: "44444444-4444-4444-8444-444444444444" },
          { URL: "https://swapr-casey.netlify.app" },
          (_url, init) =>
            new Promise((_resolve, reject) => {
              const fail = () => {
                const error = new Error("The operation was aborted");
                error.name = "TimeoutError";
                reject(error);
              };
              const timer = setTimeout(fail, 200);
              if (init.signal?.aborted) fail();
              else init.signal?.addEventListener("abort", () => {
                clearTimeout(timer);
                fail();
              });
            }),
          30
        ),
      /did not accept the job/
    );
  });

  it("treats a 202 as started and does not read a hanging body", async () => {
    let read = false;
    await kickBackground(
      { job_id: "55555555-5555-4555-8555-555555555555" },
      { URL: "https://swapr-casey.netlify.app" },
      async () => ({
        status: 202,
        ok: true,
        body: { cancel: async () => {} },
        text: async () => {
          read = true;
          return "<h1>Inactivity Timeout</h1>";
        },
      }),
      1000
    );
    assert.equal(read, false);
  });

  it("turns an HTML worker failure into a sentence", async () => {
    await assert.rejects(
      () =>
        kickBackground(
          { job_id: "66666666-6666-4666-8666-666666666666" },
          { URL: "https://swapr-casey.netlify.app" },
          async () => ({
            status: 504,
            ok: false,
            text: async () =>
              "<html><h1>Inactivity Timeout</h1><p>Description: Too much time has passed without sending any data for document.</p></html>",
          }),
          1000
        ),
      /Leave this tab open/
    );
  });
});
