/**
 * Vercel Generate status and playback.
 * The phone polls GET /api/job?id=<runpod id>, then plays GET /api/result.
 * Each call uses server-side RUNPOD_API_KEY against /status. The key never
 * goes to the browser, and a Space error is not substituted.
 */
import { scrubGenerateError } from "./gatewayError.js";
import { serveVideoBytes } from "./resultVideo.js";
import {
  describeRunpodJob,
  isJobId,
  loadRunpodResultVideo,
  runpodConfigured,
  fetchRunpodJob,
} from "./runpod.js";

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}

function jobIdFrom(request) {
  try {
    return new URL(request.url).searchParams.get("id") || "";
  } catch {
    return "";
  }
}

function missingRunpod() {
  return jsonResponse(
    {
      error:
        "Generate uses the Runpod Wan Animate endpoint. RUNPOD_API_KEY and RUNPOD_ENDPOINT_ID are not set on this site.",
    },
    500
  );
}

export async function handleRunpodJobRequest(request, deps = {}) {
  const method = request?.method || "GET";
  if (method === "OPTIONS") return new Response(null, { status: 204 });
  if (method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);
  const id = jobIdFrom(request);
  if (!isJobId(id)) return jsonResponse({ error: "Missing job id" }, 400);
  const env = deps.env || process.env;
  if (!runpodConfigured(env)) return missingRunpod();
  try {
    const polled = await fetchRunpodJob(env, id, { fetch: deps.fetch });
    const job = describeRunpodJob(id, polled.body);
    if (job.phase === "error") {
      return jsonResponse({ ...job, error: scrubGenerateError(job.error, true) }, 200);
    }
    return jsonResponse(job, 200);
  } catch (error) {
    if (error?.statusCode === 404) return jsonResponse({ error: "Unknown job" }, 404);
    return jsonResponse({ error: scrubGenerateError(error, true) }, Number.isInteger(error?.statusCode) ? error.statusCode : 502);
  }
}

export async function handleRunpodResultRequest(request, deps = {}) {
  const method = request?.method || "GET";
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Range, Content-Type",
        "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
      },
    });
  }
  if (method !== "GET" && method !== "HEAD") return jsonResponse({ error: "Method not allowed" }, 405);
  const id = jobIdFrom(request);
  if (!isJobId(id)) return jsonResponse({ error: "Missing job id" }, 400);
  const env = deps.env || process.env;
  if (!runpodConfigured(env)) return missingRunpod();
  try {
    const video = await loadRunpodResultVideo(env, id, { fetch: deps.fetch });
    return serveVideoBytes(request, video.bytes, video.contentType);
  } catch (error) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 502;
    return jsonResponse({ error: scrubGenerateError(error, true) }, status);
  }
}
