/**
 * Runpod account helpers for the phone UI: live balance and "Stop GPU".
 * RUNPOD_API_KEY stays server-side. Nothing here returns the key.
 */
import { runpodEndpointId } from "./runpod.js";

const GRAPHQL_URL = "https://api.runpod.io/graphql";
const REST_URL = "https://rest.runpod.io/v1";

function apiKey(env) {
  const key = String(env.RUNPOD_API_KEY || "").trim();
  if (!key) {
    const error = new Error("RUNPOD_API_KEY is not set on this site.");
    error.statusCode = 500;
    throw error;
  }
  return key;
}

async function timed(fetchImpl, url, init = {}, ms = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text.slice(0, 300) };
  }
}

export async function fetchRunpodBalance(env = process.env, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const key = apiKey(env);
  const response = await timed(fetchImpl, GRAPHQL_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ query: "query { myself { clientBalance currentSpendPerHr } }" }),
  });
  const body = await readJson(response);
  if (!response.ok || body.errors?.length) {
    const message = body.errors?.map((e) => e.message).join("; ") || `Runpod GraphQL HTTP ${response.status}`;
    throw new Error(message);
  }
  const me = body.data?.myself || {};
  return {
    balance: typeof me.clientBalance === "number" ? me.clientBalance : null,
    spendPerHour: typeof me.currentSpendPerHr === "number" ? me.currentSpendPerHr : null,
    at: new Date().toISOString(),
  };
}

async function health(endpoint, key, fetchImpl) {
  const response = await timed(fetchImpl, `https://api.runpod.ai/v2/${endpoint}/health`, {
    headers: { authorization: `Bearer ${key}` },
  });
  return response.ok ? readJson(response) : { error: `health HTTP ${response.status}` };
}

async function patchEndpoint(endpoint, key, fetchImpl, patch) {
  const response = await timed(fetchImpl, `${REST_URL}/endpoints/${endpoint}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(patch),
  });
  const body = await readJson(response);
  if (!response.ok) throw new Error(`update endpoint HTTP ${response.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

/**
 * Stop background billing on the Wan Animate endpoint:
 * cancel the in-flight job (if known), purge the queue, force workersMin=0,
 * and briefly set workersMax=0 so running/idle workers are released, then
 * restore workersMax so the next Generate can still start a worker.
 */
export async function stopRunpodEndpoint(env = process.env, { jobId = "", restoreDelayMs = 6000 } = {}, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const key = apiKey(env);
  const endpoint = runpodEndpointId(env);
  const steps = [];
  const base = `https://api.runpod.ai/v2/${endpoint}`;
  const auth = { authorization: `Bearer ${key}` };

  if (jobId && /^[A-Za-z0-9_-]{6,80}$/.test(jobId) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) {
    const r = await timed(fetchImpl, `${base}/cancel/${encodeURIComponent(jobId)}`, { method: "POST", headers: auth }).catch((e) => ({ ok: false, status: e.message }));
    steps.push(`cancel ${jobId}: ${r.ok ? "ok" : `failed (${r.status})`}`);
  }
  const purge = await timed(fetchImpl, `${base}/purge-queue`, { method: "POST", headers: auth }).catch((e) => ({ ok: false, status: e.message }));
  const purgeBody = purge.ok ? await readJson(purge) : {};
  steps.push(`purge queue: ${purge.ok ? `ok (${purgeBody.removed ?? 0} removed)` : `failed (${purge.status})`}`);

  let originalMax = null;
  try {
    const r = await timed(fetchImpl, `${REST_URL}/endpoints/${endpoint}`, { headers: auth });
    const ep = r.ok ? await readJson(r) : {};
    originalMax = Number.isFinite(Number(ep.workersMax)) && Number(ep.workersMax) > 0 ? Number(ep.workersMax) : 1;
    await patchEndpoint(endpoint, key, fetchImpl, { workersMin: 0, workersMax: 0 });
    steps.push(`workersMin=0, workersMax 0 (was ${originalMax}) to release workers`);
    await sleep(restoreDelayMs);
    await patchEndpoint(endpoint, key, fetchImpl, { workersMin: 0, workersMax: originalMax });
    steps.push(`workersMax restored to ${originalMax}, workersMin stays 0`);
  } catch (error) {
    steps.push(`scale down: ${error instanceof Error ? error.message : String(error)}`);
    if (originalMax) {
      await patchEndpoint(endpoint, key, fetchImpl, { workersMin: 0, workersMax: originalMax }).catch(() => {});
    }
  }
  const after = await health(endpoint, key, fetchImpl).catch((e) => ({ error: e.message }));
  return { endpoint, steps, health: after };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
  });
}

export async function handleBalanceRequest(request, deps = {}) {
  try {
    return json(await fetchRunpodBalance(deps.env || process.env, deps));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, error?.statusCode || 502);
  }
}

export async function handleStopRequest(request, deps = {}) {
  if ((request?.method || "POST") !== "POST") return json({ error: "Method not allowed" }, 405);
  let jobId = "";
  try {
    const body = await request.json();
    jobId = typeof body?.job_id === "string" ? body.job_id : "";
  } catch {
    jobId = "";
  }
  try {
    return json(await stopRunpodEndpoint(deps.env || process.env, { jobId }, deps));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, error?.statusCode || 502);
  }
}
