/**
 * Fetch-only Gradio client for the Wan Space (protocol sse_v3 / queue).
 * Does not import @gradio/client. That package rejects inside an async
 * Promise executor, which Node treats as an unhandled rejection and exits
 * with status 1 — the Netlify Runtime.ExitError.
 */

import { publicErrorText } from "./gatewayError.js";

const API_PREFIX = "/gradio_api";

export function httpError(message, statusCode = 502) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function takeSseEvents(buffer) {
  const events = [];
  let rest = buffer;
  while (rest.length) {
    const splitAt = rest.indexOf("\n\n");
    if (splitAt === -1) break;
    const raw = rest.slice(0, splitAt);
    rest = rest.slice(splitAt + 2);
    const data = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      // Ignore keepalives and non-JSON frames.
    }
  }
  return { events, rest };
}

export function outcomeFromMessage(message) {
  if (!message || message.msg !== "process_completed") return null;
  const output = message.output && typeof message.output === "object" ? message.output : {};
  if (message.success && Array.isArray(output.data)) {
    return { ok: true, data: output.data };
  }
  const detail = typeof output.error === "string" ? output.error.trim() : "";
  const title = typeof message.title === "string" ? message.title.trim() : "";
  const error =
    detail ||
    (title && title.toLowerCase() !== "error" ? title : "") ||
    "The Space failed before returning a video. If ZeroGPU is rate-limited, wait 10–15 minutes and try Generate once.";
  return { ok: false, error };
}

export function positionalArgs(parameters, args) {
  const source = args && typeof args === "object" ? args : {};
  const names = new Set((parameters || []).map((param) => param.parameter_name));
  for (const key of Object.keys(source)) {
    if (!names.has(key)) {
      throw httpError(`Parameter \`${key}\` is not a valid keyword argument.`, 400);
    }
  }
  return (parameters || []).map((param) => {
    if (Object.prototype.hasOwnProperty.call(source, param.parameter_name)) {
      const value = source[param.parameter_name];
      if (value === undefined && !param.parameter_has_default) {
        throw httpError(`No value provided for required parameter: ${param.parameter_name}`, 400);
      }
      return value === undefined ? param.parameter_default : value;
    }
    if (param.parameter_has_default) return param.parameter_default;
    throw httpError(`No value provided for required parameter: ${param.parameter_name}`, 400);
  });
}

function isBlob(value) {
  return typeof Blob !== "undefined" && value instanceof Blob;
}

function authHeaders(token, extra) {
  const headers = { ...extra };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function apiName(endpoint) {
  const name = String(endpoint || "").trim();
  return name.startsWith("/") ? name.slice(1) : name;
}

export async function uploadFiles(space, token, files, fetchImpl = fetch) {
  const form = new FormData();
  for (const file of files) {
    form.append("files", file, file.name || "photo.jpg");
  }
  const response = await fetchImpl(`${space}${API_PREFIX}/upload`, {
    method: "POST",
    headers: authHeaders(token),
    body: form,
  });
  const text = await response.text();
  if (!response.ok) {
    throw httpError(publicErrorText(`Upload to the Space failed (HTTP ${response.status}): ${text.slice(0, 500)}`), 502);
  }
  let paths;
  try {
    paths = JSON.parse(text);
  } catch {
    throw httpError("Upload to the Space did not return JSON.", 502);
  }
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string" || !path)) {
    throw httpError("Upload to the Space did not return a file path.", 502);
  }
  return paths;
}

async function materializeFiles(space, token, args, fetchImpl) {
  const out = { ...args };
  const keys = [];
  const blobs = [];
  for (const [key, value] of Object.entries(out)) {
    if (isBlob(value)) {
      keys.push(key);
      blobs.push(value);
    }
  }
  if (!blobs.length) return out;
  const paths = await uploadFiles(space, token, blobs, fetchImpl);
  keys.forEach((key, index) => {
    const file = blobs[index];
    out[key] = {
      path: paths[index],
      orig_name: file.name || "photo.jpg",
      mime_type: file.type || "application/octet-stream",
      size: file.size,
      meta: { _type: "gradio.FileData" },
    };
  });
  return out;
}

async function readQueue(response, timeoutMs, startedAt) {
  if (!response.body) throw httpError("Space queue stream was empty.", 502);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let timer;
  const arm = (ms) =>
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), ms);
    });
  try {
    while (Date.now() - startedAt < timeoutMs) {
      const remaining = Math.max(1, timeoutMs - (Date.now() - startedAt));
      const next = await Promise.race([reader.read(), arm(remaining)]);
      clearTimeout(timer);
      if (next.timedOut) break;
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      const parsed = takeSseEvents(buffer);
      buffer = parsed.rest;
      for (const message of parsed.events) {
        if (message.msg === "unexpected_error" || message.msg === "queue_full") {
          throw httpError(message.message || "The Space queue rejected the request.", 502);
        }
        const outcome = outcomeFromMessage(message);
        if (!outcome) continue;
        if (!outcome.ok) throw httpError(outcome.error, 502);
        return outcome.data;
      }
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
  }
  throw httpError(
    "Timed out waiting for Wan Animate. ZeroGPU is often busy for several minutes. Wait 10–15 minutes and try Generate once.",
    504
  );
}

export function createGradioHttpClient({
  space,
  token,
  fetchImpl = fetch,
  timeoutMs = 270000,
  config,
  apiInfo,
} = {}) {
  const root = String(space || "").replace(/\/$/, "");
  let resolvedConfig = config || null;
  let resolvedInfo = apiInfo || null;

  async function loadMetadata() {
    if (resolvedConfig && resolvedInfo) return;
    const headers = authHeaders(token);
    const [configResponse, infoResponse] = await Promise.all([
      fetchImpl(`${root}/config`, { headers }),
      fetchImpl(`${root}${API_PREFIX}/info`, { headers }),
    ]);
    if (!configResponse.ok) {
      throw httpError(`Could not load the Space config (HTTP ${configResponse.status}).`, 502);
    }
    if (!infoResponse.ok) {
      throw httpError(`Could not load the Space API info (HTTP ${infoResponse.status}).`, 502);
    }
    resolvedConfig = await configResponse.json();
    resolvedInfo = await infoResponse.json();
  }

  return {
    async predict(endpoint, args = {}, options = {}) {
      await loadMetadata();
      const name = apiName(endpoint);
      const dependency = (resolvedConfig.dependencies || []).find((item) => item.api_name === name);
      if (!dependency || typeof dependency.id !== "number") {
        throw httpError(`Space has no /${name} API.`, 502);
      }
      const endpointInfo = resolvedInfo.named_endpoints?.[`/${name}`];
      if (!endpointInfo) throw httpError(`Space has no /${name} parameters.`, 502);
      const concrete = await materializeFiles(root, token, args, fetchImpl);
      const data = positionalArgs(endpointInfo.parameters, concrete);
      const sessionHash = crypto.randomUUID();
      const join = await fetchImpl(`${root}${API_PREFIX}/queue/join`, {
        method: "POST",
        headers: authHeaders(token, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          data,
          fn_index: dependency.id,
          session_hash: sessionHash,
          trigger_id: null,
          event_data: null,
        }),
      });
      if (!join.ok) {
        const text = await join.text();
        throw httpError(
          publicErrorText(`Space queue rejected the request (HTTP ${join.status}): ${text.slice(0, 500)}`),
          join.status === 422 ? 400 : 502
        );
      }
      const limit = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : timeoutMs;
      const startedAt = Date.now();
      const stream = await fetchImpl(
        `${root}${API_PREFIX}/queue/data?session_hash=${encodeURIComponent(sessionHash)}`,
        { headers: authHeaders(token) }
      );
      if (!stream.ok) {
        const text = await stream.text();
        throw httpError(publicErrorText(`Space result stream failed (HTTP ${stream.status}): ${text.slice(0, 500)}`), 502);
      }
      const output = await readQueue(stream, limit, startedAt);
      return { data: output };
    },
  };
}
