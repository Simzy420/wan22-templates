/**
 * Optional proxy when browser CORS blocks direct Gradio calls.
 * POST multipart: api, payload (JSON string), photo (file, for /generate)
 *
 * Requires env HF_TOKEN (optional but recommended for Pro quota) and
 * HF_SPACE_URL (default https://simzy-wan-2-2-templates.hf.space).
 *
 * Enable in public/config.js: USE_PROXY: true
 * Netlify redirects /api/* to this function (see netlify.toml).
 */
import { handleGenerateRequest } from "../../server/gradioProxy.js";

export async function handler(event, context) {
  const contentType = event.headers?.["content-type"] || event.headers?.["Content-Type"] || "";
  const headers = new Headers();
  if (contentType) headers.set("content-type", contentType);

  const method = event.httpMethod || "POST";
  let body;
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    body = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64")
      : event.body || "";
  }

  const request = new Request("https://proxy.local/api/generate", {
    method,
    headers,
    body,
  });
  // Netlify passes a context object as the second argument. Tests may pass
  // { connect } instead. Only honor an explicit connect function.
  const deps = context && typeof context.connect === "function" ? context : {};
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
}
