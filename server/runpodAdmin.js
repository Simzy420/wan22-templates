/**
 * Runpod account helpers for the phone UI: live balance and "Stop GPU".
 * API keys stay server-side. Nothing here returns a key.
 * Account 2 (RUNPOD_API_KEY_2 + RUNPOD_ENDPOINT_ID_2) is optional.
 */
import { runpodAccounts, splitAccountJobId } from "./runpod.js";

const GRAPHQL_URL = "https://api.runpod.io/graphql";
const REST_URL = "https://rest.runpod.io/v1";
const LOCAL_JOB_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RAW_JOB_RE = /^[A-Za-z0-9_-]{6,80}$/;

/** Balance lookups are reused by Generate and by /api/balance. */
export const BALANCE_CACHE_MS = 30_000;
const balanceCache = new Map();

export function clearRunpodBalanceCache() {
  balanceCache.clear();
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

export async function queryClientBalance(account, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const now = typeof deps.now === "function" ? deps.now() : Date.now();
  const ttl = Number.isFinite(deps.balanceTtlMs) ? deps.balanceTtlMs : BALANCE_CACHE_MS;
  const store = deps.balanceCache || balanceCache;
  const cacheKey = `${account.index}:${account.endpointId}`;
  const hit = store.get(cacheKey);
  if (hit && now - hit.at < ttl) return hit.value;

  const response = await timed(fetchImpl, GRAPHQL_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${account.apiKey}` },
    body: JSON.stringify({ query: "query { myself { clientBalance currentSpendPerHr } }" }),
  });
  const body = await readJson(response);
  if (!response.ok || body.errors?.length) {
    const message = body.errors?.map((e) => e.message).join("; ") || `Runpod GraphQL HTTP ${response.status}`;
    throw new Error(message);
  }
  const me = body.data?.myself || {};
  const value = {
    balance: typeof me.clientBalance === "number" ? me.clientBalance : null,
    spendPerHour: typeof me.currentSpendPerHr === "number" ? me.currentSpendPerHr : null,
    at: new Date(now).toISOString(),
  };
  store.set(cacheKey, { at: now, value });
  return value;
}

export async function fetchRunpodBalance(env = process.env, deps = {}) {
  const accounts = runpodAccounts(env);
  if (!accounts.length) {
    const error = new Error("RUNPOD_API_KEY is not set on this site.");
    error.statusCode = 500;
    throw error;
  }
  const rows = await Promise.all(
    accounts.map(async (account) => {
      try {
        const row = await queryClientBalance(account, deps);
        return { label: account.label, balance: row.balance, spendPerHour: row.spendPerHour, at: row.at, error: null };
      } catch (error) {
        return { label: account.label, balance: null, spendPerHour: null, at: null, error };
      }
    })
  );
  const firstError = rows.find((row) => row.error)?.error || null;
  if (accounts.length === 1 && firstError) throw firstError;
  const primary = rows[0];
  return {
    balance: primary.balance,
    spendPerHour: primary.spendPerHour,
    at: primary.at || new Date().toISOString(),
    accounts: rows.map(({ label, balance, spendPerHour }) => ({ label, balance, spendPerHour })),
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

async function stopOneAccount(account, { cancelId, restoreDelayMs, fetchImpl, sleep, labelSteps }) {
  const steps = [];
  const prefix = labelSteps ? `${account.label}: ` : "";
  const endpoint = account.endpointId;
  const key = account.apiKey;
  const base = `https://api.runpod.ai/v2/${endpoint}`;
  const auth = { authorization: `Bearer ${key}` };

  if (cancelId) {
    const r = await timed(fetchImpl, `${base}/cancel/${encodeURIComponent(cancelId)}`, { method: "POST", headers: auth }).catch((e) => ({
      ok: false,
      status: e.message,
    }));
    steps.push(`${prefix}cancel ${cancelId}: ${r.ok ? "ok" : `failed (${r.status})`}`);
  }
  const purge = await timed(fetchImpl, `${base}/purge-queue`, { method: "POST", headers: auth }).catch((e) => ({
    ok: false,
    status: e.message,
  }));
  const purgeBody = purge.ok ? await readJson(purge) : {};
  steps.push(`${prefix}purge queue: ${purge.ok ? `ok (${purgeBody.removed ?? 0} removed)` : `failed (${purge.status})`}`);

  let originalMax = null;
  try {
    const r = await timed(fetchImpl, `${REST_URL}/endpoints/${endpoint}`, { headers: auth });
    const ep = r.ok ? await readJson(r) : {};
    originalMax = Number.isFinite(Number(ep.workersMax)) && Number(ep.workersMax) > 0 ? Number(ep.workersMax) : 1;
    await patchEndpoint(endpoint, key, fetchImpl, { workersMin: 0, workersMax: 0 });
    steps.push(`${prefix}workersMin=0, workersMax 0 (was ${originalMax}) to release workers`);
    await sleep(restoreDelayMs);
    await patchEndpoint(endpoint, key, fetchImpl, { workersMin: 0, workersMax: originalMax });
    steps.push(`${prefix}workersMax restored to ${originalMax}, workersMin stays 0`);
  } catch (error) {
    steps.push(`${prefix}scale down: ${error instanceof Error ? error.message : String(error)}`);
    if (originalMax) {
      await patchEndpoint(endpoint, key, fetchImpl, { workersMin: 0, workersMax: originalMax }).catch(() => {});
    }
  }
  const after = await health(endpoint, key, fetchImpl).catch((e) => ({ error: e.message }));
  return { steps, health: after };
}

/**
 * Stop background billing on the Wan Animate endpoint for the account that
 * owns the job. With two accounts, the other endpoint is scaled down too so
 * Stop GPU does not leave a worker billing. Cancel still goes only to the
 * account encoded on the job id.
 */
export async function stopRunpodEndpoint(env = process.env, { jobId = "", restoreDelayMs = 6000 } = {}, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const accounts = runpodAccounts(env);
  if (!accounts.length) {
    const error = new Error("RUNPOD_API_KEY is not set on this site.");
    error.statusCode = 500;
    throw error;
  }

  let effectiveId = typeof jobId === "string" ? jobId : "";
  if (deps.store && LOCAL_JOB_RE.test(effectiveId)) {
    try {
      const record = await deps.store.getJSON(effectiveId);
      if (record?.runpod_job_id) effectiveId = String(record.runpod_job_id);
    } catch {
      // A missing local record still scales the endpoint.
    }
  }

  const split = splitAccountJobId(effectiveId);
  let primary = accounts[0];
  let cancelId = "";
  if (split.tagged) {
    const found = accounts.find((account) => account.index === split.index);
    if (!found) {
      const error = new Error(`That job is on Runpod ${split.index}, but that account is not configured on this site.`);
      error.statusCode = 409;
      throw error;
    }
    primary = found;
    if (RAW_JOB_RE.test(split.id)) cancelId = split.id;
  } else if (RAW_JOB_RE.test(effectiveId) && !LOCAL_JOB_RE.test(effectiveId)) {
    cancelId = effectiveId;
  }

  const labelSteps = accounts.length > 1;
  const stopped = await stopOneAccount(primary, { cancelId, restoreDelayMs, fetchImpl, sleep, labelSteps });
  const steps = stopped.steps;
  for (const other of accounts) {
    if (other.index === primary.index) continue;
    const extra = await stopOneAccount(other, { cancelId: "", restoreDelayMs, fetchImpl, sleep, labelSteps });
    steps.push(...extra.steps);
  }
  return { endpoint: primary.endpointId, steps, health: stopped.health };
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
