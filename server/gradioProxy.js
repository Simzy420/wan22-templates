/**
 * Shared generate/extend proxy used by Vercel (`api/generate.js`) and
 * Netlify (`netlify/functions/generate.js`).
 *
 * POST multipart: api, payload (JSON string), optional photo file.
 * POST JSON: { api, payload }.
 *
 * Calls the Hugging Face Space with @gradio/client on the server so the
 * phone browser never makes a cross-origin Gradio request.
 */
import { Client } from "@gradio/client";
import { absolutizeSpaceUrl, DEFAULT_SPACE, rewriteSpaceVideoUrl } from "./videoUrl.js";

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
  if (typeof error === "string") return error;
  if (typeof error.message === "string" && error.message) return error.message;
  if (typeof error.error === "string" && error.error) return error.error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
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
  const options = {};
  if (token) options.hf_token = token;
  return Client.connect(space, options);
}

export async function callSpaceApi({ api, payload, photo, env = process.env, connect } = {}) {
  const space = (env.HF_SPACE_URL || DEFAULT_SPACE).trim() || DEFAULT_SPACE;
  const token = env.HF_TOKEN && String(env.HF_TOKEN).trim();
  const apiName = normalizeApi(api);
  const connectFn = connect || ((spaceUrl, hfToken) => defaultConnect(spaceUrl, hfToken));
  const client = await connectFn(space, token || undefined);
  const args = buildPredictArgs(payload, photo);
  const result = await client.predict(apiName, args);
  return mapPredictResult(result, space);
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
    const data = await callSpaceApi({
      api,
      payload,
      photo,
      env: deps.env || process.env,
      connect: deps.connect,
    });
    return jsonResponse(data, 200);
  } catch (error) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    return jsonResponse({ error: errorMessage(error) }, status);
  }
}
