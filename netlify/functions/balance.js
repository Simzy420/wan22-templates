import { netlifyFunctionEnv } from "../../server/jobs.js";
import { handleBalanceRequest } from "../../server/runpodAdmin.js";

export async function handler(event, context) {
  const request = new Request("https://proxy.local/api/balance", {
    method: event.httpMethod || "GET",
    headers: { "content-type": "application/json" },
    body: event.httpMethod === "POST" ? event.body || "{}" : undefined,
  });
  const response = await handleBalanceRequest(request, {
    env: netlifyFunctionEnv(context),
    fetch: context?.fetch,
    balanceCache: context?.balanceCache,
    now: context?.now,
  });
  return {
    statusCode: response.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: await response.text(),
  };
}
