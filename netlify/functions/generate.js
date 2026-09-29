/**
 * POST /api/generate
 *
 * Synchronous Netlify functions stop at 60s, and Wan Animate takes longer.
 * This function uploads the still, returns a job id, and starts
 * generate-background.js, which waits on the Space. Poll GET /api/job?id=.
 *
 * A missing still is a JSON 400. Gradio failures are JSON too — the function
 * must not exit 1.
 *
 * Env (site settings, not committed):
 *   HF_TOKEN      recommended so the Space call is authenticated
 *   HF_SPACE_URL  optional, default https://simzy-wan-2-2-templates.hf.space
 *   URL           set by Netlify; used to start the background worker
 */
import { handleGenerateRequest, errorMessage } from "../../server/gradioProxy.js";
import { enqueueGenerateJob } from "../../server/jobs.js";

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

function isNetlifyRuntime() {
  const flag = process.env.NETLIFY;
  return flag === "true" || flag === "1";
}

export async function handler(event, context) {
  try {
    const request = eventToRequest(event);
    const deps = {};
    if (context && typeof context.connect === "function") deps.connect = context.connect;
    if (context && context.env) deps.env = context.env;
    if (context && typeof context.enqueue === "function") {
      deps.enqueue = context.enqueue;
    } else if (!deps.connect && isNetlifyRuntime()) {
      const env = deps.env || process.env;
      deps.enqueue = (job) => enqueueGenerateJob(job, { event, env });
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
