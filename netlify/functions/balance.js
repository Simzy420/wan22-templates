import { handleBalanceRequest } from "../../server/runpodAdmin.js";

export async function handler(event) {
  const request = new Request("https://proxy.local/api/balance", {
    method: event.httpMethod || "GET",
    headers: { "content-type": "application/json" },
    body: event.httpMethod === "POST" ? event.body || "{}" : undefined,
  });
  const response = await handleBalanceRequest(request);
  return {
    statusCode: response.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: await response.text(),
  };
}
