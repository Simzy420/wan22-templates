/**
 * Netlify cannot keep a synchronous function open for a Wan run (60s limit).
 * The sync function stores a job and starts generate-background, which polls
 * Runpod (or the Hugging Face Space, only when HF_GENERATE_FALLBACK is set)
 * for up to 15 minutes.
 */
import { connectLambda, getStore } from "@netlify/blobs";
import { publicErrorText, scrubGenerateError } from "./gatewayError.js";
import { DEFAULT_SPACE } from "./videoUrl.js";
import { uploadFiles } from "./gradioHttp.js";
import { callSpaceApi, ProxyError } from "./gradioProxy.js";
import { hfGenerateEnabled, resolveMotionVideoUrl, runpodConfigured, runRunpodGenerate } from "./runpod.js";

export const JOB_STORE = "wan22-jobs";

function errorText(error, env, api) {
  const text = publicErrorText(error || "Generate failed");
  if (api === "/generate" && runpodConfigured(env || {})) return scrubGenerateError(text, true);
  return text;
}

export const UPLOAD_TIMEOUT_MS = 20000;
export const KICK_TIMEOUT_MS = 8000;

function withTimeout(fetchImpl, timeoutMs) {
  return (url, init = {}) => fetchImpl(url, { ...init, signal: init.signal || AbortSignal.timeout(timeoutMs) });
}

function timeoutMessage(error, fallback) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return fallback;
  return errorText(error);
}

export function memoryJobStore() {
  const json = new Map();
  const bytes = new Map();
  return {
    async setJSON(key, value) {
      json.set(key, JSON.parse(JSON.stringify(value)));
    },
    async getJSON(key) {
      return json.has(key) ? JSON.parse(JSON.stringify(json.get(key))) : null;
    },
    async setBytes(key, data, metadata) {
      const body = Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data);
      bytes.set(key, { data: body, metadata: { ...(metadata || {}) } });
    },
    async getBytes(key) {
      const hit = bytes.get(key);
      if (!hit) return null;
      return { data: Buffer.from(hit.data), metadata: { ...hit.metadata } };
    },
  };
}

function header(event, name) {
  const headers = event?.headers || {};
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || "";
}

/** Classic Netlify functions must bind Blobs from the Lambda event. Prefer strong reads when the payload includes an uncached URL. */
export function netlifyJobStore(event) {
  if (!event?.blobs) {
    throw new Error("Netlify Blobs context is missing on this invocation. Redeploy the site so functions can store generate jobs.");
  }
  let data;
  try {
    data = JSON.parse(Buffer.from(event.blobs, "base64").toString("utf8"));
  } catch {
    throw new Error("Netlify Blobs context could not be read.");
  }
  const siteID = header(event, "x-nf-site-id");
  const token = data.token;
  if (!siteID || !token || !data.url) {
    connectLambda(event);
    return blobAdapter(getStore(JOB_STORE));
  }
  const uncached = data.uncached_url || data.uncachedEdgeURL || data.uncachedURL;
  const store = getStore({
    name: JOB_STORE,
    siteID,
    token,
    edgeURL: data.url,
    ...(uncached ? { uncachedEdgeURL: uncached, consistency: "strong" } : { consistency: "eventual" }),
  });
  return blobAdapter(store);
}

function blobAdapter(store) {
  return {
    async setJSON(key, value) {
      await store.setJSON(key, value);
    },
    async getJSON(key) {
      return store.get(key, { type: "json" });
    },
    async setBytes(key, data, metadata = {}) {
      const body = data instanceof Uint8Array ? data : new Uint8Array(data);
      const meta = {};
      for (const [name, value] of Object.entries(metadata)) meta[name] = String(value);
      const type = meta.contentType || "video/mp4";
      await store.set(key, new Blob([body], { type }), { metadata: meta });
    },
    async getBytes(key) {
      if (typeof store.getWithMetadata === "function") {
        const result = await store.getWithMetadata(key, { type: "arrayBuffer" });
        if (!result || result.data == null) return null;
        return { data: Buffer.from(result.data), metadata: result.metadata || {} };
      }
      const data = await store.get(key, { type: "arrayBuffer" });
      if (data == null) return null;
      let metadata = {};
      if (typeof store.getMetadata === "function") {
        const meta = await store.getMetadata(key);
        metadata = meta?.metadata || {};
      }
      return { data: Buffer.from(data), metadata };
    },
  };
}

/**
 * Site settings (RUNPOD_API_KEY, RUNPOD_ENDPOINT_ID, URL) are on process.env
 * in the deployed function. NETLIFY=true is build-only and is not set there.
 * A partial context.env must not hide those site variables.
 */
export function netlifyFunctionEnv(context, base = process.env) {
  const extra = context && context.env && typeof context.env === "object" ? context.env : null;
  if (!extra) return base;
  return { ...base, ...extra };
}

export function publicJob(record) {
  if (!record) return null;
  if (record.phase === "done" && record.result) {
    return { job_id: record.id, phase: "done", ...record.result };
  }
  if (record.phase === "error") {
    return { job_id: record.id, phase: "error", error: record.error || "Generate failed" };
  }
  return { job_id: record.id, phase: record.phase || "queued" };
}

export async function uploadReference(space, token, photo, fetchImpl = fetch) {
  const paths = await uploadFiles(space, token, [photo], fetchImpl);
  return {
    path: paths[0],
    orig_name: photo.name || "photo.jpg",
    mime_type: photo.type || "image/jpeg",
    size: photo.size,
    meta: { _type: "gradio.FileData" },
  };
}

export function backgroundUrl(env = process.env) {
  const base = String(env.URL || env.DEPLOY_PRIME_URL || env.DEPLOY_URL || "").replace(/\/$/, "");
  if (!base) {
    throw new Error("Netlify URL is not set, so the long generate worker cannot be started. Set the site URL and redeploy.");
  }
  return `${base}/.netlify/functions/generate-background`;
}

export async function kickBackground(spec, env = process.env, fetchImpl = fetch, timeoutMs = KICK_TIMEOUT_MS) {
  // Headers only. Reading the body would wait for a worker that was not
  // marked background, and the synchronous function would die at 60s.
  let response;
  try {
    response = await fetchImpl(backgroundUrl(env), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(spec),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(
      timeoutMessage(
        error,
        "The long Wan worker did not accept the job in time. Wait 10–15 minutes and try Generate once."
      )
    );
  }
  if (response.status === 202 || response.ok) {
    await response.body?.cancel?.().catch(() => {});
    return;
  }
  const text = typeof response.text === "function" ? await response.text() : "";
  throw new Error(publicErrorText(`Could not start the generate worker (HTTP ${response.status}). ${text}`));
}

const MAX_STILL_BYTES = 2_000_000;

async function stillBase64(photo) {
  const buf = Buffer.from(await photo.arrayBuffer());
  if (!buf.length) throw new ProxyError("The still photo was empty.", 400);
  if (buf.length > MAX_STILL_BYTES) {
    throw new ProxyError("That still is too large. Choose a smaller photo and try again.", 400);
  }
  return buf.toString("base64");
}

export async function enqueueGenerateJob(job, deps = {}) {
  const env = deps.env || process.env;
  const space = String(env.HF_SPACE_URL || DEFAULT_SPACE).trim() || DEFAULT_SPACE;
  const token = env.HF_TOKEN && String(env.HF_TOKEN).trim();
  const fetchImpl = deps.fetch || fetch;
  const useRunpod = job.api === "/generate" && runpodConfigured(env);
  let image = null;
  let image_base64 = null;
  let video_url = null;
  let backend = "hf";
  if (useRunpod) {
    if (!job.photo) throw new ProxyError("Upload a still photo of the person who should do this motion.", 400);
    try {
      image_base64 = await stillBase64(job.photo);
      video_url = await resolveMotionVideoUrl(job.payload || {}, { fetch: fetchImpl });
    } catch (error) {
      if (error instanceof ProxyError) throw error;
      throw new ProxyError(errorText(error, env, job.api), 400);
    }
    backend = "runpod";
  } else if (job.api === "/generate" && !hfGenerateEnabled(env)) {
    throw new ProxyError(
      "Generate uses the Runpod Wan Animate endpoint. RUNPOD_API_KEY and RUNPOD_ENDPOINT_ID are not set on this site.",
      500
    );
  } else if (job.photo) {
    const upload =
      deps.upload ||
      ((file) => uploadReference(space, token, file, withTimeout(fetchImpl, UPLOAD_TIMEOUT_MS)));
    try {
      image = await upload(job.photo);
    } catch (error) {
      throw new Error(
        timeoutMessage(
          error,
          "The still could not be uploaded before the host closed the connection. Wait 10–15 minutes and try Generate once."
        )
      );
    }
  }
  const job_id = crypto.randomUUID();
  const spec = {
    job_id,
    api: job.api,
    payload: job.payload,
    backend,
    image,
    image_base64,
    video_url,
  };
  const store = deps.store || netlifyJobStore(deps.event);
  await store.setJSON(job_id, { id: job_id, phase: "queued" });
  const kick = deps.kick || ((body) => kickBackground(body, env, fetchImpl, KICK_TIMEOUT_MS));
  try {
    await kick(spec);
  } catch (error) {
    await store.setJSON(job_id, { id: job_id, phase: "error", error: errorText(error, env, job.api) });
    throw error;
  }
  return { job_id, phase: "queued" };
}

async function runPreparedRunpodGenerate(spec, deps, env, store) {
  if (!spec.image_base64) {
    throw new Error(
      spec.backend === "runpod"
        ? "The still photo was empty."
        : "Generate uses Runpod, but this job was not prepared for it. Try Generate again."
    );
  }
  return runRunpodGenerate(spec, {
    store,
    env,
    fetch: deps.fetch,
    timeoutMs: deps.timeoutMs ?? 14 * 60 * 1000,
    intervalMs: deps.intervalMs,
    sleep: deps.sleep,
  });
}

export async function runBackgroundJob(spec, deps = {}) {
  if (!spec || !spec.job_id) throw new Error("Missing job_id");
  const store = deps.store;
  if (!store) throw new Error("Missing job store");
  const existing = await store.getJSON(spec.job_id);
  if (existing && (existing.phase === "running" || existing.phase === "done" || existing.phase === "error")) {
    return publicJob(existing);
  }
  await store.setJSON(spec.job_id, { id: spec.job_id, phase: "running" });
  const env = deps.env || process.env;
  try {
    // Generate uses Runpod whenever the endpoint is configured, including a
    // spec that was labeled "hf". Extend still calls the Space.
    const generateOnRunpod = spec.api === "/generate" && (spec.backend === "runpod" || runpodConfigured(env));
    const result = generateOnRunpod
      ? await runPreparedRunpodGenerate(spec, deps, env, store)
      : await callSpaceApi({
          api: spec.api,
          payload: spec.payload,
          photo: spec.image || null,
          env,
          connect: deps.connect,
          timeoutMs: deps.timeoutMs ?? 14 * 60 * 1000,
        });
    const record = { id: spec.job_id, phase: "done", result };
    await store.setJSON(spec.job_id, record);
    return publicJob(record);
  } catch (error) {
    const record = { id: spec.job_id, phase: "error", error: errorText(error, env, spec.api) };
    await store.setJSON(spec.job_id, record);
    return publicJob(record);
  }
}
