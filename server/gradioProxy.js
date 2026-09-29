/**
 * Shared generate/extend proxy used by Vercel (`api/generate.js`) and
 * Netlify (`netlify/functions/generate.js`).
 *
 * POST multipart: api, payload (JSON string), optional photo file.
 * POST JSON: { api, payload }.
 *
 * Calls the Hugging Face Space with a fetch-only Gradio queue client so the
 * phone browser never makes a cross-origin Gradio request.
 */
import { publicErrorText } from "./gatewayError.js";
import { createGradioHttpClient } from "./gradioHttp.js";
import { absolutizeSpaceUrl, DEFAULT_SPACE, rewriteSpaceVideoUrl } from "./videoUrl.js";

// The old Gradio JS client rejected inside an async Promise executor, and Node
// exited with status 1 (Netlify Runtime.ExitError). Keep that from taking the
// function down if a dependency does it again.
if (typeof process !== "undefined" && process.on && !globalThis.__wan22RejectionGuard) {
  globalThis.__wan22RejectionGuard = true;
  process.on("unhandledRejection", (reason) => {
    console.error("unhandledRejection", reason);
  });
}

export { absolutizeSpaceUrl, DEFAULT_SPACE };

const ALLOWED_APIS = new Set(["/generate", "/extend", "/auto_extend"]);

export class ProxyError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "ProxyError";
    this.statusCode = statusCode;
  }
}

export function normalizeApi(api) {
  const name = String(api || "/generate").trim();
  const withSlash = name.startsWith("/") ? name : `/${name}`;
  if (!ALLOWED_APIS.has(withSlash)) {
    throw new ProxyError(`Unsupported api: ${withSlash}`);
  }
  return withSlash;
}

export function buildPredictArgs(payload, photo) {
  const source = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const args = { ...source };
  // Gradio State is not a public API keyword. Passing it makes predict throw.
  delete args.state;
  delete args.image;
  if (photo) args.image = photo;
  return args;
}

export function fileRefUrl(value) {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (typeof value !== "object") return null;
  if (value.video) {
    const nested = fileRefUrl(value.video);
    if (nested) return nested;
  }
  if (typeof value.url === "string" && value.url) return value.url;
  if (typeof value.path === "string" && /^https?:\/\//.test(value.path)) return value.path;
  if (typeof value.path === "string" && value.path) return value.path;
  return null;
}

export function mapPredictResult(result, space = DEFAULT_SPACE) {
  const data = result?.data ?? result;
  const video = Array.isArray(data) ? data[0] : data;
  const status = Array.isArray(data) ? data[2] ?? null : null;
  const sessionId = Array.isArray(data) ? data[4] ?? null : null;
  const rawUrl = fileRefUrl(video);
  const absolute = rawUrl ? absolutizeSpaceUrl(rawUrl, space) : null;
  const videoUrl = absolute ? rewriteSpaceVideoUrl(absolute, space) : null;
  const session_id =
    sessionId == null || sessionId === "" ? null : String(sessionId);
  return {
    video: videoUrl,
    url: videoUrl,
    status: status == null ? null : String(status),
    session_id,
    // Previous Netlify proxy stored data[4] (the session id) on `state`.
    state: session_id,
  };
}

export function errorMessage(error) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return publicErrorText(error);
  if (typeof error.message === "string" && error.message) return publicErrorText(error.message);
  if (typeof error.error === "string" && error.error) return publicErrorText(error.error);
  try {
    return publicErrorText(JSON.stringify(error));
  } catch {
    return publicErrorText(String(error));
  }
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

function isUpload(value) {
  return (
    value != null &&
    typeof value === "object" &&
    typeof value.arrayBuffer === "function" &&
    typeof value.size === "number" &&
    value.size > 0
  );
}

async function readRequest(request) {
  const contentType = request.headers.get("content-type") || "";
  let api = "/generate";
  let payload = {};
  let photo = null;

  if (contentType.includes("multipart/form-data")) {
    let form;
    try {
      form = await request.formData();
    } catch (error) {
      throw new ProxyError(`Could not read upload: ${errorMessage(error)}`);
    }
    const apiField = form.get("api");
    if (typeof apiField === "string" && apiField.trim()) api = apiField;
    const rawPayload = form.get("payload");
    if (typeof rawPayload === "string" && rawPayload.trim()) {
      try {
        payload = JSON.parse(rawPayload);
      } catch {
        throw new ProxyError("payload must be JSON");
      }
    }
    const file = form.get("photo");
    if (isUpload(file)) photo = file;
  } else {
    let body;
    try {
      body = await request.json();
    } catch {
      throw new ProxyError("Expected multipart form data or JSON");
    }
    if (body && typeof body === "object") {
      if (typeof body.api === "string" && body.api.trim()) api = body.api;
      payload = body.payload && typeof body.payload === "object" ? body.payload : body;
      if (payload === body) {
        const { api: _api, ...rest } = body;
        payload = rest;
      }
    }
  }

  return { api: normalizeApi(api), payload, photo };
}

async function defaultConnect(space, token) {
  return createGradioHttpClient({ space, token: token || undefined });
}

export async function callSpaceApi({ api, payload, photo, env = process.env, connect, timeoutMs } = {}) {
  const space = (env.HF_SPACE_URL || DEFAULT_SPACE).trim() || DEFAULT_SPACE;
  const token = env.HF_TOKEN && String(env.HF_TOKEN).trim();
  const apiName = normalizeApi(api);
  const connectFn = connect || ((spaceUrl, hfToken) => defaultConnect(spaceUrl, hfToken));
  const client = await connectFn(space, token || undefined);
  const args = buildPredictArgs(payload, photo);
  const result = await client.predict(apiName, args, { timeoutMs: timeoutMs ?? 270000 });
  const mapped = mapPredictResult(result, space);
  if (!mapped.video) {
    throw new ProxyError(
      "The Space finished without a video, so your still was not returned as a clip. Nothing was substituted.",
      502
    );
  }
  return mapped;
}

export async function handleGenerateRequest(request, deps = {}) {
  if (!request || request.method === "OPTIONS") {
    return jsonResponse({ ok: true }, 204);
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const { api, payload, photo } = await readRequest(request);
    if (api === "/generate" && !photo) {
      throw new ProxyError("Upload a still photo of the person who should do this motion.", 400);
    }
    const env = deps.env || process.env;
    if (typeof deps.enqueue === "function") {
      const queued = await deps.enqueue({ api, payload, photo, env });
      return jsonResponse(queued, 202);
    }
    const data = await callSpaceApi({
      api,
      payload,
      photo,
      env,
      connect: deps.connect,
      timeoutMs: deps.timeoutMs,
    });
    return jsonResponse(data, 200);
  } catch (error) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    return jsonResponse({ error: errorMessage(error) }, status);
  }
}
