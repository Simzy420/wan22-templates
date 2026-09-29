/**
 * GET /api/result?id=<uuid>
 * Streams the mp4 saved by generate-background after Runpod completes.
 * Same-origin so phone Safari can play it (including Range).
 */
import { netlifyJobStore, memoryJobStore } from "../../server/jobs.js";
import { handleResultRequest } from "../../server/resultVideo.js";

function requestUrl(event) {
  if (event.rawUrl) return event.rawUrl;
  const headers = event.headers || {};
  const host = headers.host || headers.Host || "proxy.local";
  const proto = headers["x-forwarded-proto"] || headers["X-Forwarded-Proto"] || "https";
  const path = event.path || "/api/result";
  const rawQuery = event.rawQueryString || event.rawQuery || "";
  const fromParams = event.queryStringParameters?.id;
  const query = rawQuery || (fromParams ? `id=${encodeURIComponent(fromParams)}` : "");
  return `${proto}://${host}${path}${query ? `?${query}` : ""}`;
}

export async function handler(event, context) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(event.headers || {})) {
    if (value != null) headers.set(key, Array.isArray(value) ? value.join(", ") : String(value));
  }
  const method = event.httpMethod || "GET";
  const request = new Request(requestUrl(event), { method, headers });
  const store = context?.store || (context?.memory ? memoryJobStore() : netlifyJobStore(event));
  const response = await handleResultRequest(request, { store });
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
