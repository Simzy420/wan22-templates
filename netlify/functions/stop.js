import { netlifyFunctionEnv, netlifyJobStore } from "../../server/jobs.js";
import { handleStopRequest } from "../../server/runpodAdmin.js";

export async function handler(event, context) {
  let store = context?.store || null;
  if (!store && event?.blobs) {
    try {
      store = netlifyJobStore(event);
    } catch {
      store = null;
    }
  }
  const request = new Request("https://proxy.local/api/stop", {
    method: event.httpMethod || "GET",
    headers: { "content-type": "application/json" },
    body: event.httpMethod === "POST" ? event.body || "{}" : undefined,
  });
  const response = await handleStopRequest(request, {
    env: netlifyFunctionEnv(context),
    store,
    fetch: context?.fetch,
    sleep: context?.sleep,
  });
  return {
    statusCode: response.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: await response.text(),
  };
}
