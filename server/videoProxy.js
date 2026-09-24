/**
 * Same-origin GET /api/video proxy.
 * Streams a Gradio file from the allowlisted Hugging Face Space so phone
 * Safari can play the result (including Range / scrubbing) without loading
 * the Space host directly.
 */
import { resolveAllowedVideoUrl, VideoProxyError } from "./videoUrl.js";

const PASS_HEADERS = ["content-type", "content-length", "accept-ranges", "content-range"];

function errorMessage(error) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  if (typeof error.message === "string" && error.message) return error.message;
  return String(error);
}

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

function playbackContentType(upstreamType, targetUrl) {
  const raw = upstreamType && String(upstreamType).trim();
  const base = raw ? raw.split(";")[0].trim().toLowerCase() : "";
  const generic = !base || base === "application/octet-stream" || base === "binary/octet-stream" || base === "application/force-download";
  if (!generic) return raw;
  if (/\.webm(?:$|[?#])/i.test(targetUrl)) return "video/webm";
  if (/\.mp4(?:$|[?#])/i.test(targetUrl)) return "video/mp4";
  return raw || null;
}

function upstreamHeaders(request, env) {
  const headers = new Headers();
  const range = request.headers.get("range");
  if (range) headers.set("Range", range);
  const token = env && env.HF_TOKEN != null ? String(env.HF_TOKEN).trim() : "";
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

async function fetchSpaceFile(target, { method, headers, fetchImpl, env, hops = 0 }) {
  if (hops > 3) {
    throw new VideoProxyError("Too many redirects", 502);
  }
  const upstream = await fetchImpl(target, { method, headers, redirect: "manual" });
  if (![301, 302, 303, 307, 308].includes(upstream.status)) return upstream;
  const location = upstream.headers.get("location");
  if (upstream.body && typeof upstream.body.cancel === "function") {
    await upstream.body.cancel().catch(() => {});
  }
  if (!location) return upstream;
  let next;
  try {
    next = resolveAllowedVideoUrl(new URL(location, target).toString(), env);
  } catch (error) {
    if (error instanceof VideoProxyError) {
      throw new VideoProxyError("Upstream redirect is not an allowed Space file", 502);
    }
    throw error;
  }
  const nextMethod = upstream.status === 303 ? "GET" : method;
  return fetchSpaceFile(next, { method: nextMethod, headers, fetchImpl, env, hops: hops + 1 });
}

export async function handleVideoRequest(request, deps = {}) {
  const method = request?.method || "GET";
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Range, Content-Type",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  if (method !== "GET" && method !== "HEAD") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const env = deps.env || process.env;
  const fetchImpl = deps.fetch || globalThis.fetch;
  let target;
  try {
    const requestUrl = new URL(request.url);
    target = resolveAllowedVideoUrl(requestUrl.searchParams.get("url"), env);
  } catch (error) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 400;
    return jsonResponse({ error: errorMessage(error) }, status);
  }

  let upstream;
  try {
    upstream = await fetchSpaceFile(target, {
      method,
      headers: upstreamHeaders(request, env),
      fetchImpl,
      env,
    });
  } catch (error) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 502;
    return jsonResponse({ error: errorMessage(error) }, status);
  }

  const outHeaders = new Headers();
  for (const name of PASS_HEADERS) {
    if (name === "content-type") continue;
    const value = upstream.headers.get(name);
    if (value) outHeaders.set(name, value);
  }
  const contentType = playbackContentType(upstream.headers.get("content-type"), target);
  if (contentType) outHeaders.set("Content-Type", contentType);
  outHeaders.set("Access-Control-Allow-Origin", "*");
  outHeaders.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, Content-Type");
  outHeaders.set("Cache-Control", "private");

  const empty = method === "HEAD" || upstream.status === 204 || upstream.status === 205 || upstream.status === 304;
  return new Response(empty ? null : upstream.body, { status: upstream.status, headers: outHeaders });
}
