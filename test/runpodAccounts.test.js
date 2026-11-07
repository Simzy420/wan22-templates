import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { handler as balanceHandler } from "../netlify/functions/balance.js";
import { balanceRows, RUNPOD_BILLING_URL } from "../src/balanceView.js";
import { memoryJobStore, runBackgroundJob } from "../server/jobs.js";
import {
  accountForJob,
  fetchRunpodJob,
  isJobId,
  runpodAccounts,
  startRunpodJob,
} from "../server/runpod.js";
import { fetchRunpodBalance, handleBalanceRequest, handleStopRequest, stopRunpodEndpoint } from "../server/runpodAdmin.js";
import { handleRunpodJobRequest } from "../server/runpodRoutes.js";

const DUAL = {
  RUNPOD_API_KEY: "key-1",
  RUNPOD_ENDPOINT_ID: "zrmwpir4qzs66s",
  RUNPOD_ENDPOINT_URL: "https://api.runpod.ai/v2/zrmwpir4qzs66s",
  RUNPOD_API_KEY_2: "key-2",
  RUNPOD_ENDPOINT_ID_2: "3qu6rstqmkum81",
  RUNPOD_ENDPOINT_URL_2: "https://api.runpod.ai/v2/3qu6rstqmkum81",
};

const ONE = {
  RUNPOD_API_KEY: "secret-key",
  RUNPOD_ENDPOINT_ID: "zrmwpir4qzs66s",
  RUNPOD_ENDPOINT_URL: "https://api.runpod.ai/v2/zrmwpir4qzs66s",
};

function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function authOf(init = {}) {
  return init.headers?.Authorization || init.headers?.authorization || "";
}

function tinyMp4() {
  const bytes = Buffer.alloc(64, 0);
  bytes.writeUInt32BE(24, 0);
  bytes.write("ftyp", 4);
  bytes.write("isom", 8);
  return bytes;
}

describe("two Runpod accounts", () => {
  it("pairs each key with its own endpoint and ignores a partial second account", () => {
    const accounts = runpodAccounts(DUAL);
    assert.equal(accounts.length, 2);
    assert.equal(accounts[0].label, "Runpod 1");
    assert.equal(accounts[0].apiKey, "key-1");
    assert.equal(accounts[0].endpointId, "zrmwpir4qzs66s");
    assert.equal(accounts[0].endpoint, "https://api.runpod.ai/v2/zrmwpir4qzs66s");
    assert.equal(accounts[1].label, "Runpod 2");
    assert.equal(accounts[1].apiKey, "key-2");
    assert.equal(accounts[1].endpointId, "3qu6rstqmkum81");
    assert.equal(accounts[1].endpoint, "https://api.runpod.ai/v2/3qu6rstqmkum81");
    assert.equal(runpodAccounts({ ...DUAL, RUNPOD_API_KEY_2: "" }).length, 1);
    assert.equal(runpodAccounts({ ...DUAL, RUNPOD_ENDPOINT_ID_2: "  " }).length, 1);
    assert.equal(runpodAccounts({ RUNPOD_API_KEY_2: "key-2", RUNPOD_ENDPOINT_ID_2: "3qu6rstqmkum81" }).length, 1);
    const evil = runpodAccounts({ ...DUAL, RUNPOD_ENDPOINT_URL_2: "https://evil.example/steal" });
    assert.equal(evil[1].endpoint, "https://api.runpod.ai/v2/3qu6rstqmkum81");
    assert.equal(evil[1].apiKey, "key-2");
    assert.equal(evil[0].apiKey, "key-1");
  });

  it("submits to the higher balance and prefixes that account on the job id", async () => {
    const calls = [];
    const started = await startRunpodJob(
      DUAL,
      { prompt: "a person" },
      {
        balanceCache: new Map(),
        fetch: async (url, init) => {
          const auth = authOf(init);
          calls.push({ url, auth, body: init.body });
          if (String(url).includes("graphql")) {
            assert.match(String(init.body), /clientBalance/);
            const balance = auth.endsWith("key-2") ? 8.5 : 1.25;
            return jsonRes({ data: { myself: { clientBalance: balance, currentSpendPerHr: 0.2 } } });
          }
          assert.equal(url, "https://api.runpod.ai/v2/3qu6rstqmkum81/run");
          assert.equal(auth, "Bearer key-2");
          return jsonRes({ id: "job-higher", status: "IN_QUEUE" });
        },
      }
    );
    assert.equal(started.id, "a2_job-higher");
    assert.equal(calls.filter((call) => call.url.includes("graphql")).length, 2);
    assert.equal(calls.filter((call) => call.url.endsWith("/run")).length, 1);
    assert.equal(
      calls.some((call) => call.url.includes("3qu6rstqmkum81") && call.auth === "Bearer key-1"),
      false
    );
    assert.equal(
      calls.some((call) => call.url.includes("zrmwpir4qzs66s") && call.auth === "Bearer key-2"),
      false
    );
    assert.equal(JSON.stringify(started).includes("key-2"), false);
  });

  it("keeps account 1 when balances tie, and when account 2 is not configured", async () => {
    const tieCalls = [];
    const tied = await startRunpodJob(
      DUAL,
      { prompt: "a person" },
      {
        balanceCache: new Map(),
        fetch: async (url, init) => {
          tieCalls.push(url);
          if (String(url).includes("graphql")) {
            return jsonRes({ data: { myself: { clientBalance: 4, currentSpendPerHr: 0 } } });
          }
          assert.equal(init.headers.Authorization, "Bearer key-1");
          assert.match(url, /zrmwpir4qzs66s\/run$/);
          return jsonRes({ id: "job-tie", status: "IN_QUEUE" });
        },
      }
    );
    assert.equal(tied.id, "a1_job-tie");

    const singleCalls = [];
    const single = await startRunpodJob(
      { ...DUAL, RUNPOD_API_KEY_2: "" },
      { prompt: "a person" },
      {
        fetch: async (url, init) => {
          singleCalls.push(url);
          assert.equal(init.headers.Authorization, "Bearer key-1");
          return jsonRes({ id: "job-one", status: "IN_QUEUE" });
        },
      }
    );
    assert.equal(single.id, "job-one");
    assert.equal(singleCalls.some((url) => url.includes("graphql")), false);
  });

  it("retries the other account once when /run is out of credits", async () => {
    let runs = 0;
    const started = await startRunpodJob(
      DUAL,
      { prompt: "a person" },
      {
        balanceCache: new Map(),
        fetch: async (url, init) => {
          if (String(url).includes("graphql")) {
            const balance = authOf(init).endsWith("key-2") ? 9 : 0.2;
            return jsonRes({ data: { myself: { clientBalance: balance, currentSpendPerHr: 0 } } });
          }
          runs += 1;
          if (runs === 1) {
            assert.match(url, /3qu6rstqmkum81\/run$/);
            assert.equal(init.headers.Authorization, "Bearer key-2");
            return jsonRes({ error: "insufficient balance" }, 402);
          }
          assert.match(url, /zrmwpir4qzs66s\/run$/);
          assert.equal(init.headers.Authorization, "Bearer key-1");
          return jsonRes({ id: "job-fallback", status: "IN_QUEUE" });
        },
      }
    );
    assert.equal(runs, 2);
    assert.equal(started.id, "a1_job-fallback");
  });

  it("retries when the preferred endpoint is missing, but not on auth failures", async () => {
    let runs = 0;
    const started = await startRunpodJob(
      DUAL,
      { prompt: "a person" },
      {
        balanceCache: new Map(),
        fetch: async (url, init) => {
          if (String(url).includes("graphql")) {
            const balance = authOf(init).endsWith("key-2") ? 9 : 0.2;
            return jsonRes({ data: { myself: { clientBalance: balance, currentSpendPerHr: 0 } } });
          }
          runs += 1;
          if (runs === 1) {
            assert.match(url, /3qu6rstqmkum81\/run$/);
            return jsonRes({ error: "endpoint not found" }, 404);
          }
          assert.match(url, /zrmwpir4qzs66s\/run$/);
          return jsonRes({ id: "job-missing-ep", status: "IN_QUEUE" });
        },
      }
    );
    assert.equal(runs, 2);
    assert.equal(started.id, "a1_job-missing-ep");

    runs = 0;
    await assert.rejects(
      () =>
        startRunpodJob(
          DUAL,
          { prompt: "a person" },
          {
            balanceCache: new Map(),
            fetch: async (url, init) => {
              if (String(url).includes("graphql")) {
                const balance = authOf(init).endsWith("key-2") ? 3 : 1;
                return jsonRes({ data: { myself: { clientBalance: balance, currentSpendPerHr: 0 } } });
              }
              runs += 1;
              return jsonRes({ error: "Unauthorized" }, 401);
            },
          }
        ),
      /API key/
    );
    assert.equal(runs, 1);

    runs = 0;
    await assert.rejects(
      () =>
        startRunpodJob(
          DUAL,
          { prompt: "a person" },
          {
            balanceCache: new Map(),
            fetch: async (url) => {
              if (String(url).includes("graphql")) {
                return jsonRes({ data: { myself: { clientBalance: 2, currentSpendPerHr: 0 } } });
              }
              runs += 1;
              return jsonRes({ error: "You have insufficient credits" }, 402);
            },
          }
        ),
      /out of credits/
    );
    assert.equal(runs, 2);
  });

  it("uses the account whose balance could be read when the other lookup fails", async () => {
    const started = await startRunpodJob(
      DUAL,
      { prompt: "a person" },
      {
        balanceCache: new Map(),
        fetch: async (url, init) => {
          if (String(url).includes("graphql")) {
            if (authOf(init).endsWith("key-1")) return jsonRes({ errors: [{ message: "graphql down" }] });
            return jsonRes({ data: { myself: { clientBalance: 3, currentSpendPerHr: 0 } } });
          }
          assert.match(url, /3qu6rstqmkum81\/run$/);
          assert.equal(init.headers.Authorization, "Bearer key-2");
          return jsonRes({ id: "job-known", status: "IN_QUEUE" });
        },
      }
    );
    assert.equal(started.id, "a2_job-known");
  });

  it("caches both balances for about 30 seconds", async () => {
    let graphql = 0;
    let clock = 1_000_000;
    const balanceCache = new Map();
    const fetchImpl = async (url, init) => {
      if (String(url).includes("graphql")) {
        graphql += 1;
        const balance = authOf(init).endsWith("key-2") ? 2 : 5;
        return jsonRes({ data: { myself: { clientBalance: balance, currentSpendPerHr: 0 } } });
      }
      return jsonRes({ id: "job-cache", status: "IN_QUEUE" });
    };
    const deps = { fetch: fetchImpl, balanceCache, now: () => clock };
    const first = await startRunpodJob(DUAL, { prompt: "a person" }, deps);
    assert.equal(first.id, "a1_job-cache");
    assert.equal(graphql, 2);
    await startRunpodJob(DUAL, { prompt: "a person" }, deps);
    assert.equal(graphql, 2);
    clock += 31_000;
    await startRunpodJob(DUAL, { prompt: "a person" }, deps);
    assert.equal(graphql, 4);
  });

  it("polls and cancels on the account encoded in the job id", async () => {
    const polled = await fetchRunpodJob(DUAL, "a2_job-higher", {
      fetch: async (url, init) => {
        assert.equal(url, "https://api.runpod.ai/v2/3qu6rstqmkum81/status/job-higher");
        assert.equal(init.headers.Authorization, "Bearer key-2");
        return jsonRes({ id: "job-higher", status: "IN_PROGRESS" });
      },
    });
    assert.equal(polled.body.status, "IN_PROGRESS");

    const legacy = await fetchRunpodJob(DUAL, "plain-job-id", {
      fetch: async (url, init) => {
        assert.equal(url, "https://api.runpod.ai/v2/zrmwpir4qzs66s/status/plain-job-id");
        assert.equal(init.headers.Authorization, "Bearer key-1");
        return jsonRes({ id: "plain-job-id", status: "IN_QUEUE" });
      },
    });
    assert.equal(legacy.body.status, "IN_QUEUE");
    assert.equal(isJobId("a2_job-higher"), true);
    assert.equal(isJobId("a2_no"), false);
    assert.equal(accountForJob(DUAL, "a1_job-higher").account.index, 1);

    const route = await handleRunpodJobRequest(new Request("https://wan22-templates.vercel.app/api/job?id=a2_job-higher"), {
      env: DUAL,
      fetch: async (url, init) => {
        assert.equal(url, "https://api.runpod.ai/v2/3qu6rstqmkum81/status/job-higher");
        assert.equal(init.headers.Authorization, "Bearer key-2");
        return jsonRes({ id: "job-higher", status: "IN_PROGRESS" });
      },
    });
    const body = await route.json();
    assert.equal(body.job_id, "a2_job-higher");
    assert.equal(body.phase, "running");
  });

  it("stops the encoded account and still scales the other endpoint", async () => {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url, method: init.method || "GET", auth: authOf(init) });
      if (String(url).includes("/cancel/")) return jsonRes({ status: "CANCELLED" });
      if (String(url).includes("purge-queue")) return jsonRes({ removed: 1 });
      if (String(url).includes("rest.runpod.io")) return jsonRes({ workersMax: 2 });
      if (String(url).includes("/health")) return jsonRes({ workers: { running: 0, idle: 0 }, jobs: { inQueue: 0, inProgress: 0 } });
      return jsonRes({});
    };
    const stopped = await stopRunpodEndpoint(DUAL, { jobId: "a2_job-22", restoreDelayMs: 0 }, { fetch: fetchImpl, sleep: async () => {} });
    assert.equal(stopped.endpoint, "3qu6rstqmkum81");
    const cancels = calls.filter((call) => call.url.includes("/cancel/"));
    assert.equal(cancels.length, 1);
    assert.equal(cancels[0].url, "https://api.runpod.ai/v2/3qu6rstqmkum81/cancel/job-22");
    assert.equal(cancels[0].auth, "Bearer key-2");
    assert.equal(calls.some((call) => call.url.includes("zrmwpir4qzs66s/purge-queue")), true);
    assert.equal(calls.some((call) => call.url.includes("3qu6rstqmkum81/purge-queue")), true);
    assert.match(stopped.steps[0], /Runpod 2: cancel job-22: ok/);
    assert.equal(JSON.stringify(stopped).includes("key-2"), false);

    const singleCalls = [];
    const single = await stopRunpodEndpoint(
      ONE,
      { jobId: "rp-job-1", restoreDelayMs: 0 },
      {
        fetch: async (url, init = {}) => {
          singleCalls.push({ url, auth: authOf(init) });
          if (String(url).includes("rest.runpod.io")) return jsonRes({ workersMax: 1 });
          if (String(url).includes("purge-queue")) return jsonRes({ removed: 0 });
          if (String(url).includes("/health")) return jsonRes({ workers: {}, jobs: {} });
          return jsonRes({});
        },
        sleep: async () => {},
      }
    );
    assert.equal(single.steps[0], "cancel rp-job-1: ok");
    assert.equal(single.steps.some((step) => step.startsWith("Runpod")), false);
    assert.equal(singleCalls.some((call) => call.url.includes("3qu6rstqmkum81")), false);
    assert.equal(singleCalls.find((call) => call.url.includes("/cancel/")).auth, "Bearer secret-key");
  });

  it("resolves a Netlify job id to the Runpod account stored on the job", async () => {
    const localId = "11111111-1111-4111-8111-111111111111";
    const store = memoryJobStore();
    await store.setJSON(localId, { id: localId, phase: "running", runpod_job_id: "a2_job-22" });
    const calls = [];
    await stopRunpodEndpoint(
      DUAL,
      { jobId: localId, restoreDelayMs: 0 },
      {
        store,
        sleep: async () => {},
        fetch: async (url, init = {}) => {
          calls.push({ url, auth: authOf(init) });
          if (String(url).includes("rest.runpod.io")) return jsonRes({ workersMax: 1 });
          if (String(url).includes("purge-queue")) return jsonRes({ removed: 0 });
          if (String(url).includes("/health")) return jsonRes({ workers: {}, jobs: {} });
          return jsonRes({});
        },
      }
    );
    const cancel = calls.find((call) => call.url.includes("/cancel/"));
    assert.equal(cancel.url, "https://api.runpod.ai/v2/3qu6rstqmkum81/cancel/job-22");
    assert.equal(cancel.auth, "Bearer key-2");
  });

  it("background polling stays on the account that accepted /run", async () => {
    const store = memoryJobStore();
    const encoded = tinyMp4().toString("base64");
    const spec = {
      job_id: "12121212-1212-4121-8121-121212121212",
      api: "/generate",
      backend: "runpod",
      payload: { prompt: "a person" },
      video_url: "https://huggingface.co/datasets/Simzy/wan22-template-clips/resolve/main/templates/demo-dance.mp4",
      image_base64: Buffer.from("still").toString("base64"),
    };
    await store.setJSON(spec.job_id, { id: spec.job_id, phase: "queued" });
    const done = await runBackgroundJob(spec, {
      store,
      env: DUAL,
      intervalMs: 0,
      sleep: async () => {},
      balanceCache: new Map(),
      fetch: async (url, init) => {
        if (String(url).includes("graphql")) {
          const balance = authOf(init).endsWith("key-2") ? 6 : 1;
          return jsonRes({ data: { myself: { clientBalance: balance, currentSpendPerHr: 0 } } });
        }
        if (url.endsWith("/run")) {
          assert.match(url, /3qu6rstqmkum81\/run$/);
          assert.equal(init.headers.Authorization, "Bearer key-2");
          return jsonRes({ id: "rp-higher", status: "IN_QUEUE" });
        }
        assert.equal(url, "https://api.runpod.ai/v2/3qu6rstqmkum81/status/rp-higher");
        assert.equal(init.headers.Authorization, "Bearer key-2");
        return jsonRes({ id: "rp-higher", status: "COMPLETED", output: { video: encoded } });
      },
    });
    assert.equal(done.phase, "done");
    assert.equal(done.runpod_job_id, undefined);
    assert.equal((await store.getJSON(spec.job_id)).runpod_job_id, "a2_rp-higher");
    assert.equal(JSON.stringify(done).includes("key-2"), false);
  });
});

describe("/api/balance", () => {
  it("returns both accounts and keeps the original top-level fields", async () => {
    const response = await handleBalanceRequest(new Request("https://wan22-templates.vercel.app/api/balance"), {
      env: DUAL,
      balanceCache: new Map(),
      fetch: async (url, init) => {
        assert.match(String(init.body), /myself \{ clientBalance/);
        const second = authOf(init).endsWith("key-2");
        return jsonRes({
          data: { myself: { clientBalance: second ? 0.4 : 12.5, currentSpendPerHr: second ? 0.1 : 0 } },
        });
      },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.balance, 12.5);
    assert.equal(body.spendPerHour, 0);
    assert.equal(typeof body.at, "string");
    assert.deepEqual(body.accounts, [
      { label: "Runpod 1", balance: 12.5, spendPerHour: 0 },
      { label: "Runpod 2", balance: 0.4, spendPerHour: 0.1 },
    ]);
    assert.equal(JSON.stringify(body).includes("key-1"), false);

    const single = await fetchRunpodBalance(ONE, {
      balanceCache: new Map(),
      fetch: async () => jsonRes({ data: { myself: { clientBalance: 3.5, currentSpendPerHr: 0.01 } } }),
    });
    assert.equal(single.balance, 3.5);
    assert.equal(single.spendPerHour, 0.01);
    assert.deepEqual(single.accounts, [{ label: "Runpod 1", balance: 3.5, spendPerHour: 0.01 }]);

    const missing = await handleBalanceRequest(new Request("https://wan22-templates.vercel.app/api/balance"), {
      env: {},
      fetch: async () => {
        throw new Error("should not call Runpod");
      },
    });
    assert.equal(missing.status, 500);
    assert.match((await missing.json()).error, /RUNPOD_API_KEY/);
  });

  it("netlify balance uses the function env for both accounts", async () => {
    const result = await balanceHandler(
      { httpMethod: "GET", headers: {} },
      {
        env: DUAL,
        balanceCache: new Map(),
        fetch: async (_url, init) => {
          const second = authOf(init).endsWith("key-2");
          return jsonRes({
            data: { myself: { clientBalance: second ? 1.5 : 2.5, currentSpendPerHr: 0 } },
          });
        },
      }
    );
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.equal(body.balance, 2.5);
    assert.equal(body.accounts[1].label, "Runpod 2");
    assert.equal(body.accounts[1].balance, 1.5);
  });

  it("stop request cancels on the prefixed account", async () => {
    const calls = [];
    const response = await handleStopRequest(
      new Request("https://wan22-templates.vercel.app/api/stop", {
        method: "POST",
        body: JSON.stringify({ job_id: "a2_job-22" }),
      }),
      {
        env: DUAL,
        sleep: async () => {},
        fetch: async (url, init = {}) => {
          calls.push(url + " " + authOf(init));
          if (String(url).includes("rest.runpod.io")) return jsonRes({ workersMax: 1 });
          if (String(url).includes("purge-queue")) return jsonRes({ removed: 0 });
          if (String(url).includes("/health")) return jsonRes({ workers: { running: 0, idle: 0 }, jobs: {} });
          return jsonRes({});
        },
      }
    );
    assert.equal(response.status, 200);
    assert.equal(calls.some((line) => line.startsWith("https://api.runpod.ai/v2/3qu6rstqmkum81/cancel/job-22 Bearer key-2")), true);
    assert.equal(calls.some((line) => line.includes("/cancel/") && line.includes("key-1")), false);
  });
});

describe("balance block", () => {
  it("marks a balance under $1 and keeps a buy-credit link on every line", () => {
    const rows = balanceRows({
      balance: 12.5,
      spendPerHour: 0,
      accounts: [
        { label: "Runpod 1", balance: 12.5, spendPerHour: 0 },
        { label: "Runpod 2", balance: 0.42, spendPerHour: 0.19 },
      ],
    });
    assert.equal(rows[0].low, false);
    assert.equal(rows[0].text, "Runpod 1 $12.50 · $0.000/hr");
    assert.equal(rows[1].low, true);
    assert.equal(rows[1].text, "Runpod 2 $0.42 · $0.190/hr");
    assert.equal(rows[0].href, RUNPOD_BILLING_URL);
    assert.equal(rows[1].href, "https://console.runpod.io/user/billing");
    assert.equal(balanceRows({ accounts: [{ label: "Runpod 2", balance: 1 }] })[0].low, false);
    assert.equal(balanceRows({ accounts: [{ label: "Runpod 2", balance: 0.99 }] })[0].low, true);
    const legacy = balanceRows({ balance: 4.5, spendPerHour: 1 });
    assert.equal(legacy.length, 1);
    assert.equal(legacy[0].text, "Runpod 1 $4.50 · $1.000/hr");
    assert.equal(legacy[0].low, false);

    const main = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
    const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    const page = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const config = readFileSync(new URL("../public/config.js", import.meta.url), "utf8");
    assert.match(main, /Buy credit/);
    assert.match(main, /target = "_blank"/);
    assert.match(main, /rel = "noopener"/);
    assert.match(main, /is-low/);
    assert.match(css, /\.balance-line\.is-low/);
    assert.match(css, /#ff4d5e/);
    assert.match(page, /20261106-motions-swapr/);
    assert.match(page, /config\.js\?v=20261106-motions-swapr/);
    assert.match(config, /ASSET_VERSION:\s*"20261106-motions-swapr"/);
    assert.equal(RUNPOD_BILLING_URL, "https://console.runpod.io/user/billing");
  });
});
