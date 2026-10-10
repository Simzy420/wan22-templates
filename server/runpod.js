/**
 * Casey's Runpod Wan Animate serverless endpoint
 * (wlsdml1114/Wan_Animate_Runpod_hub handler).
 *
 * POST {endpoint}/run, then poll {endpoint}/status/{id}.
 * The handler accepts image_base64 plus a public video_url, and returns
 * a base64 mp4 on output.video (Comfy gifs encoded as base64).
 * The API key stays in this process. Callers never send it to the phone.
 */

export const TEMPLATE_CATALOG_URL =
  "https://huggingface.co/datasets/Simzy/wan22-template-clips/resolve/main/templates/catalog.json";
export const TEMPLATE_CDN_BASE =
  "https://huggingface.co/datasets/Simzy/wan22-template-clips/resolve/main/";

const RUNPOD_DEFAULTS = {
  negative_prompt: "blurry, low quality, distorted",
  // Template clips are phone recordings (portrait). 832x480 landscape made the
  // worker's VHS_LoadVideo crop the motion clip, cutting the head in half.
  width: 480,
  height: 832,
  fps: 16,
  cfg: 1,
  steps: 6,
  mode: "replace",
};

const CREDIT_RE = /credit|insufficient|billing|payment required|out of funds|balance/i;
const AUTH_RE = /unauthorized|invalid api key|forbidden|api key/i;

/** swapr-wan-animate. Used when the API key is set and RUNPOD_ENDPOINT_ID is empty. */
export const DEFAULT_ANIMATE_ENDPOINT_ID = "zrmwpir4qzs66s";

const MAX_STILL_BYTES = 2_000_000;
/** Custom Add-template clips stay under the Netlify/Vercel body budget. */
export const MAX_MOTION_BYTES = 3_500_000;

export function hfGenerateEnabled(env = {}) {
  const flag = String(env.HF_GENERATE_FALLBACK || "").trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

export function runpodEndpointId(env = {}) {
  const id = String(env.RUNPOD_ENDPOINT_ID || "").trim();
  if (id) return id;
  if (String(env.RUNPOD_API_KEY || "").trim()) return DEFAULT_ANIMATE_ENDPOINT_ID;
  return "";
}

export function runpodConfigured(env = {}) {
  return Boolean(String(env.RUNPOD_API_KEY || "").trim() && runpodEndpointId(env));
}

export function runpodEndpoint(env = {}) {
  const id = runpodEndpointId(env);
  const fallback = id ? `https://api.runpod.ai/v2/${id}` : "";
  const raw = String(env.RUNPOD_ENDPOINT_URL || "").trim();
  if (!raw) return fallback;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" || parsed.hostname !== "api.runpod.ai") return fallback;
    parsed.hash = "";
    parsed.search = "";
    parsed.username = "";
    parsed.password = "";
    return parsed.toString().replace(/\/$/, "").replace(/\/(?:run|runsync|status)$/i, "");
  } catch {
    return fallback;
  }
}

export function resultVideoKey(jobId) {
  return `result-video:${jobId}`;
}

export function isAllowedTemplateVideoUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  if (host !== "huggingface.co" && !host.endsWith(".huggingface.co")) return false;
  return /wan22-template-clips/i.test(parsed.pathname);
}

export function templateVideoFromCatalog(catalog, templateId) {
  if (!Array.isArray(catalog) || !templateId) return null;
  const item = catalog.find((entry) => entry && entry.id === templateId);
  if (!item) return null;
  if (typeof item.video_url === "string" && isAllowedTemplateVideoUrl(item.video_url)) return item.video_url;
  const rel = item.video_path || item.video || "";
  if (!rel || typeof rel !== "string") return null;
  const url = TEMPLATE_CDN_BASE + rel.replace(/^\//, "");
  return isAllowedTemplateVideoUrl(url) ? url : null;
}

export async function resolveMotionVideoUrl(payload, deps = {}) {
  const source = payload && typeof payload === "object" ? payload : {};
  const direct = typeof source.video_url === "string" ? source.video_url.trim() : "";
  if (direct && isAllowedTemplateVideoUrl(direct)) return direct;
  const templateId = typeof source.template_id === "string" ? source.template_id.trim() : "";
  if (!templateId) {
    throw new Error("Pick a motion template before Generate.");
  }
  const fetchImpl = deps.fetch || fetch;
  const catalogUrl = deps.catalogUrl || TEMPLATE_CATALOG_URL;
  let response;
  try {
    response = await fetchWithTimeout(fetchImpl, catalogUrl, {}, deps.timeoutMs ?? 15000);
  } catch {
    throw new Error("Could not load the motion catalog to find that template video. Try Generate again.");
  }
  if (!response?.ok) {
    throw new Error(`Could not load the motion catalog (HTTP ${response?.status || "error"}).`);
  }
  let catalog;
  try {
    catalog = await response.json();
  } catch {
    throw new Error("The motion catalog was not valid JSON.");
  }
  const url = templateVideoFromCatalog(catalog, templateId);
  if (!url) throw new Error(`No public video for template “${templateId}”. Refresh the gallery and pick the motion again.`);
  return url;
}

function normalizeSeed(seed) {
  const n = Number(seed);
  if (Number.isFinite(n)) return Math.max(0, Math.floor(n));
  return Math.floor(Math.random() * 1_000_000_000);
}

/**
 * Pick the worker width/height from the template's aspect. The worker feeds
 * width/height to VHS_LoadVideo (crops the motion clip to that aspect) and to
 * ImageResizeKJv2 (pads the reference still), so they must match the clip.
 */
export function targetSize(fields = {}) {
  const w = Number(fields.template_width);
  const h = Number(fields.template_height);
  let orientation = String(fields.orientation || "").toLowerCase();
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
    const ratio = w / h;
    orientation = ratio > 1.15 ? "landscape" : ratio < 0.87 ? "portrait" : "square";
  }
  if (orientation === "landscape") return { width: 832, height: 480 };
  if (orientation === "square") return { width: 640, height: 640 };
  return { width: RUNPOD_DEFAULTS.width, height: RUNPOD_DEFAULTS.height };
}

function normalizeVideoBase64(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const compact = value.trim().replace(/^data:[^;]+;base64,/i, "").replace(/\s+/g, "");
  if (compact.length < 32 || !/^[A-Za-z0-9+/]+=*$/.test(compact)) return null;
  return compact;
}

export function buildRunpodInput(fields = {}) {
  if (!fields.image_base64 || typeof fields.image_base64 !== "string") {
    throw new Error("The still photo was empty.");
  }
  const video_base64 = normalizeVideoBase64(fields.video_base64);
  const hasUrl = isAllowedTemplateVideoUrl(fields.video_url);
  if (!video_base64 && !hasUrl) {
    throw new Error("Pick a catalog motion or add your own short template clip first.");
  }
  const negative = String(fields.negative_prompt || fields.negative || "").trim();
  const input = {
    image_base64: fields.image_base64,
    prompt: String(String(fields.prompt || "").trim() || "a person, natural motion, cinematic, high quality").slice(0, 2000),
    negative_prompt: (negative || RUNPOD_DEFAULTS.negative_prompt).slice(0, 1000),
    seed: normalizeSeed(fields.seed),
    ...targetSize(fields),
    fps: RUNPOD_DEFAULTS.fps,
    cfg: RUNPOD_DEFAULTS.cfg,
    steps: RUNPOD_DEFAULTS.steps,
    mode: fields.mode === "animate" ? "animate" : "replace",
  };
  // Prefer uploaded custom clips (video_base64) over catalog video_url.
  if (video_base64) input.video_base64 = video_base64;
  else input.video_url = fields.video_url;
  return input;
}

function pickMessage(json, text) {
  if (!json || typeof json !== "object") {
    return typeof text === "string" ? text : "";
  }
  if (typeof json.error === "string") return json.error;
  if (json.error && typeof json.error.message === "string") return json.error.message;
  if (typeof json.output === "object" && json.output && typeof json.output.error === "string") return json.output.error;
  if (typeof json.message === "string") return json.message;
  return typeof text === "string" && !text.trim().startsWith("{") ? text : "";
}

export function explainRunpodFailure({ httpStatus, json, text } = {}) {
  const statusName = String(json?.status || "").toUpperCase();
  let message = pickMessage(json, text).replace(/\s+/g, " ").trim();
  message = message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  const blob = `${httpStatus || ""} ${statusName} ${message}`;
  if (httpStatus === 402 || CREDIT_RE.test(blob)) {
    return "Runpod is out of credits. Add credits on the Runpod account, then try Generate again.";
  }
  if (httpStatus === 401 || httpStatus === 403 || AUTH_RE.test(blob)) {
    return "Runpod rejected the API key. Check RUNPOD_API_KEY on this site (Vercel Production and Preview, or Netlify swapr-casey), then redeploy.";
  }
  if (statusName === "TIMED_OUT") {
    return "Runpod timed out. The first Generate after the worker has been idle can take several minutes. Wait a minute and try once.";
  }
  if (statusName === "CANCELLED") return "Runpod cancelled the job before it finished. Try Generate again.";
  if (/비디오|no video|video not found|could not find/i.test(message)) {
    return "Runpod finished without a video.";
  }
  if (message) return `Runpod failed: ${message}`.slice(0, 500);
  if (httpStatus) return `Runpod failed (HTTP ${httpStatus}).`;
  return "Runpod failed.";
}

function looksLikeBase64(value) {
  if (typeof value !== "string") return false;
  const compact = value.trim().replace(/^data:[^;]+;base64,/i, "").replace(/\s+/g, "");
  return compact.length >= 32 && /^[A-Za-z0-9+/]+=*$/.test(compact);
}

export function extractRunpodVideoBase64(output) {
  const found = [];
  const visit = (node, depth) => {
    if (found.length || depth > 8 || node == null) return;
    if (typeof node === "string") {
      if (looksLikeBase64(node)) found.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (typeof node !== "object") return;
    for (const key of ["video", "base64", "data", "gifs"]) {
      if (key in node) visit(node[key], depth + 1);
      if (found.length) return;
    }
    for (const value of Object.values(node)) visit(value, depth + 1);
  };
  visit(output, 0);
  return found[0] || null;
}

export function videoContentType(bytes) {
  if (!bytes || bytes.length < 12) return "video/mp4";
  const head = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 64)));
  if (head.includes(Buffer.from("ftyp"))) return "video/mp4";
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return "video/webm";
  return "video/mp4";
}

export function isVideoBytes(bytes) {
  if (!bytes || bytes.length < 16) return false;
  const head = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 64)));
  if (head.includes(Buffer.from("ftyp"))) return true;
  return head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
}

export function decodeVideoBase64(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  let raw = value.trim().replace(/^data:[^;]+;base64,/i, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+=*$/.test(raw)) return null;
  const bytes = Buffer.from(raw, "base64");
  if (!isVideoBytes(bytes)) return null;
  return bytes;
}

function isTerminalFailure(status) {
  const name = String(status || "").toUpperCase();
  return name === "FAILED" || name === "CANCELLED" || name === "TIMED_OUT" || name === "ERROR";
}

export function isJobId(value) {
  return /^[A-Za-z0-9_-]{6,80}$/.test(String(value || ""));
}

function statusError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export async function stillToBase64(photo) {
  if (!photo || typeof photo.arrayBuffer !== "function") {
    throw statusError("Upload a still photo of the person who should do this motion.", 400);
  }
  const buf = Buffer.from(await photo.arrayBuffer());
  if (!buf.length) throw statusError("The still photo was empty.", 400);
  if (buf.length > MAX_STILL_BYTES) {
    throw statusError("That still is too large. Choose a smaller photo and try again.", 400);
  }
  return buf.toString("base64");
}

/** Turn an Add-template motion upload into Runpod video_base64. */
export async function motionToBase64(motion) {
  if (!motion || typeof motion.arrayBuffer !== "function") {
    throw statusError("Add a short motion clip (about 3–5 seconds) first.", 400);
  }
  const type = String(motion.type || "").toLowerCase();
  if (type && !type.startsWith("video/")) {
    throw statusError("That file is not a video. Choose an MP4 or MOV clip.", 400);
  }
  const buf = Buffer.from(await motion.arrayBuffer());
  if (!buf.length) throw statusError("The motion clip was empty.", 400);
  if (buf.length > MAX_MOTION_BYTES) {
    throw statusError(
      `That motion clip is too large (max ${Math.round(MAX_MOTION_BYTES / 1024 / 1024)} MB). Trim it to about 3–5 seconds and try again.`,
      400
    );
  }
  return buf.toString("base64");
}

/**
 * Map a Runpod /status body to the phone job document.
 * Never includes the mp4 bytes or the API key.
 */
export function describeRunpodJob(jobId, body) {
  const status = String(body?.status || "").toUpperCase();
  if (status === "COMPLETED") {
    const encoded = extractRunpodVideoBase64(body?.output ?? body);
    if (!decodeVideoBase64(encoded)) {
      return {
        job_id: jobId,
        phase: "error",
        error: explainRunpodFailure({
          json: {
            status,
            error: body?.output?.error || body?.error || "Runpod finished without a video.",
          },
        }),
      };
    }
    const url = `/api/result?id=${encodeURIComponent(jobId)}`;
    return {
      job_id: jobId,
      phase: "done",
      video: url,
      url,
      status: "Done.",
      session_id: null,
      state: null,
    };
  }
  if (isTerminalFailure(status)) {
    return { job_id: jobId, phase: "error", error: explainRunpodFailure({ json: body }) };
  }
  if (status === "IN_PROGRESS" || status === "RUNNING") {
    return { job_id: jobId, phase: "running" };
  }
  if (status === "IN_QUEUE" || status === "QUEUED") {
    return { job_id: jobId, phase: "queued" };
  }
  return { job_id: jobId, phase: "error", error: "Runpod did not return a job status." };
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function runpodRequest(url, { apiKey, fetchImpl, method = "GET", body, timeoutMs }) {
  let response;
  try {
    response = await fetchWithTimeout(
      fetchImpl,
      url,
      {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      },
      timeoutMs
    );
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    throw new Error(
      timedOut
        ? "Runpod did not respond in time. The worker may be starting. Wait a minute and try Generate once."
        : "Could not reach Runpod. Try Generate again."
    );
  }
  const text = typeof response.text === "function" ? await response.text() : "";
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    const error = new Error(explainRunpodFailure({ httpStatus: response.status, json, text }));
    error.statusCode = response.status;
    throw error;
  }
  return { response, text, json };
}

function requireRunpod(env) {
  const endpoint = runpodEndpoint(env);
  const apiKey = String(env.RUNPOD_API_KEY || "").trim();
  if (!endpoint || !apiKey) {
    throw new Error("Generate uses Runpod, but RUNPOD_API_KEY or RUNPOD_ENDPOINT_ID is missing.");
  }
  return { endpoint, apiKey };
}

export async function startRunpodJob(env, input, deps = {}) {
  const { endpoint, apiKey } = requireRunpod(env);
  const fetchImpl = deps.fetch || fetch;
  const timeoutMs = Math.min(30000, deps.timeoutMs ?? 30000);
  const submitted = await runpodRequest(`${endpoint}/run`, {
    apiKey,
    fetchImpl,
    method: "POST",
    body: { input },
    timeoutMs,
  });
  const first = submitted.json || {};
  if (isTerminalFailure(first.status)) {
    throw new Error(explainRunpodFailure({ httpStatus: submitted.response.status, json: first, text: submitted.text }));
  }
  if (!isJobId(first.id)) {
    throw new Error(
      explainRunpodFailure({
        httpStatus: submitted.response.status,
        json: first,
        text: submitted.text || "Runpod did not return a job id.",
      })
    );
  }
  return first;
}

export async function fetchRunpodJob(env, jobId, deps = {}) {
  const { endpoint, apiKey } = requireRunpod(env);
  const fetchImpl = deps.fetch || fetch;
  const polled = await runpodRequest(`${endpoint}/status/${encodeURIComponent(jobId)}`, {
    apiKey,
    fetchImpl,
    timeoutMs: deps.timeoutMs ?? 30000,
  });
  return { body: polled.json || {}, httpStatus: polled.response.status, text: polled.text };
}

export async function submitAndWait(env, input, deps = {}) {
  const timeoutMs = deps.timeoutMs ?? 14 * 60 * 1000;
  const intervalMs = deps.intervalMs ?? 5000;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const started = Date.now();
  const first = await startRunpodJob(env, input, { ...deps, timeoutMs });
  if (String(first.status || "").toUpperCase() === "COMPLETED") return first;

  while (Date.now() - started < timeoutMs) {
    await sleep(intervalMs);
    const polled = await fetchRunpodJob(env, first.id, deps);
    const body = polled.body || {};
    const status = String(body.status || "").toUpperCase();
    if (status === "COMPLETED") return body;
    if (isTerminalFailure(status)) {
      throw new Error(explainRunpodFailure({ httpStatus: polled.httpStatus, json: body, text: polled.text }));
    }
  }
  throw new Error(
    "Runpod did not finish within 14 minutes. The first Generate after the worker has been idle can take several minutes. Wait a minute and try once."
  );
}

/**
 * Vercel has no background worker. POST /run and return the Runpod job id.
 * The phone polls /api/job, which calls /status.
 */
export async function submitGenerateOnRunpod({ payload, photo, motion, env, fetch: fetchImpl } = {}) {
  let image_base64;
  let video_url;
  let video_base64;
  try {
    image_base64 = await stillToBase64(photo);
    if (motion) {
      video_base64 = await motionToBase64(motion);
    } else if (payload?.video_base64) {
      video_base64 = normalizeVideoBase64(payload.video_base64);
      if (!video_base64) throw statusError("The custom motion clip was empty.", 400);
    } else {
      video_url = await resolveMotionVideoUrl(payload || {}, { fetch: fetchImpl || fetch });
    }
  } catch (error) {
    if (Number.isInteger(error?.statusCode)) throw error;
    throw statusError(error instanceof Error ? error.message : String(error), 400);
  }
  const input = buildRunpodInput({ ...(payload || {}), video_url, video_base64, image_base64 });
  const started = await startRunpodJob(env, input, { fetch: fetchImpl || fetch });
  return { job_id: started.id, phase: "queued" };
}

export async function loadRunpodResultVideo(env, jobId, deps = {}) {
  const polled = await fetchRunpodJob(env, jobId, deps);
  const described = describeRunpodJob(jobId, polled.body);
  if (described.phase !== "done") {
    const error = new Error(described.phase === "error" ? described.error : "Result is not ready");
    error.statusCode = described.phase === "error" ? 502 : 404;
    throw error;
  }
  const encoded = extractRunpodVideoBase64(polled.body?.output ?? polled.body);
  const bytes = decodeVideoBase64(encoded);
  if (!bytes) {
    throw statusError("Runpod finished without a video.", 502);
  }
  return { bytes, contentType: videoContentType(bytes) };
}

export async function runRunpodGenerate(spec, deps = {}) {
  const env = deps.env || process.env;
  if (!spec?.image_base64) throw new Error("The still photo was empty.");
  const fetchImpl = deps.fetch || fetch;
  const video_base64 = normalizeVideoBase64(spec.video_base64) || normalizeVideoBase64(spec.payload?.video_base64);
  const video_url =
    video_base64
      ? undefined
      : spec.video_url || (await resolveMotionVideoUrl(spec.payload || {}, { fetch: fetchImpl }));
  const input = buildRunpodInput({
    ...(spec.payload || {}),
    video_url,
    video_base64,
    image_base64: spec.image_base64,
  });
  const completed = await submitAndWait(env, input, deps);
  const encoded = extractRunpodVideoBase64(completed?.output ?? completed);
  const bytes = decodeVideoBase64(encoded);
  if (!bytes) {
    throw new Error(
      explainRunpodFailure({
        json: completed?.output?.error ? { error: completed.output.error, status: completed.status } : { status: completed?.status, error: "Runpod finished without a video." },
      })
    );
  }
  if (!deps.store || typeof deps.store.setBytes !== "function") {
    throw new Error("Cannot store the result video.");
  }
  await deps.store.setBytes(resultVideoKey(spec.job_id), bytes, { contentType: videoContentType(bytes) });
  const url = `/api/result?id=${encodeURIComponent(spec.job_id)}`;
  return {
    video: url,
    url,
    status: "Done.",
    session_id: null,
    state: null,
  };
}
