/**
 * POST /api/generate
 *
 * Synchronous Netlify functions stop at 60s, and Wan Animate takes longer.
 * This function stores the still, returns a job id, and starts
 * generate-background.js. That worker polls Runpod when RUNPOD_API_KEY and
 * RUNPOD_ENDPOINT_ID are set. Poll GET /api/job?id= and play GET /api/result.
 *
 * Always queue. Do not gate on process.env.NETLIFY: that variable is set
 * during the build and is absent in the deployed function, which previously
 * fell through to the Space and rejected video_url.
 *
 * A missing still is a JSON 400. Runpod and Gradio failures are JSON too —
 * the function must not exit 1.
 *
 * Env (site settings, not committed):
 *   RUNPOD_API_KEY       server-side only; required for Generate
 *   RUNPOD_ENDPOINT_ID   required for Generate (swapr-wan-animate)
 *   RUNPOD_ENDPOINT_URL  optional https://api.runpod.ai/v2/<id>
 *   HF_GENERATE_FALLBACK set true only to send Generate to the Space when Runpod env is absent
 *   HF_TOKEN             used for Extend and /api/video, not the Runpod happy path
 *   URL                  set by Netlify; used to start the background worker
 */
import { handleGenerateRequest, errorMessage } from "../../server/gradioProxy.js";
import { enqueueGenerateJob, netlifyFunctionEnv } from "../../server/jobs.js";

function jsonResult(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body: JSON.stringify(body),
  };
}

function eventToRequest(event) {
  const contentType = event.headers?.["content-type"] || event.headers?.["Content-Type"] || "";
  const headers = new Headers();
  if (contentType) headers.set("content-type", contentType);
  const method = event.httpMethod || "POST";
  const init = { method, headers };
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64") : event.body;
    if (raw != null && raw !== "") {
      init.body = Buffer.isBuffer(raw) ? new Uint8Array(raw) : raw;
    }
  }
  return new Request("https://proxy.local/api/generate", init);
}

export async function handler(event, context) {
  if (context) context.callbackWaitsForEmptyEventLoop = false;
  try {
    const request = eventToRequest(event);
    const env = netlifyFunctionEnv(context);
    const deps = { env };
    if (context && typeof context.enqueue === "function") {
      deps.enqueue = context.enqueue;
    } else {
      deps.enqueue = (job) =>
        enqueueGenerateJob(job, {
          event,
          env,
          store: context?.store,
          kick: context?.kick,
          fetch: context?.fetch,
          upload: context?.upload,
        });
    }
    const response = await handleGenerateRequest(request, deps);
    const text = await response.text();
    return {
      statusCode: response.status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
      body: text,
    };
  } catch (error) {
    return jsonResult(500, { error: errorMessage(error) });
  }
}
