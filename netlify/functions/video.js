/**
 * Netlify parity for GET /api/video (see netlify.toml: /api/* → this folder).
 * Same allowlist and Range behavior as api/video.js.
 */
import { handleVideoRequest } from "../../server/videoProxy.js";

function requestUrl(event) {
  if (event.rawUrl) return event.rawUrl;
  const headers = event.headers || {};
  const host = headers.host || headers.Host || "proxy.local";
  const proto = headers["x-forwarded-proto"] || headers["X-Forwarded-Proto"] || "https";
  const path = event.path || "/api/video";
  const rawQuery = event.rawQueryString || event.rawQuery || "";
  return `${proto}://${host}${path}${rawQuery ? `?${rawQuery}` : ""}`;
}

export async function handler(event, context) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(event.headers || {})) {
    if (value != null) headers.set(key, Array.isArray(value) ? value.join(", ") : String(value));
  }
  const method = event.httpMethod || "GET";
  const request = new Request(requestUrl(event), { method, headers });
  const deps = {};
  if (context && typeof context.fetch === "function") deps.fetch = context.fetch;
  if (context && context.env) deps.env = context.env;
  const response = await handleVideoRequest(request, deps);
  const buf = Buffer.from(await response.arrayBuffer());
  const outHeaders = {};
  response.headers.forEach((value, key) => {
    outHeaders[key] = value;
  });
  const contentType = response.headers.get("content-type") || "";
  const binary = !contentType.includes("application/json") && !contentType.startsWith("text/");
  return {
    statusCode: response.status,
    headers: outHeaders,
    body: binary ? buf.toString("base64") : buf.toString("utf8"),
    isBase64Encoded: binary,
  };
}
