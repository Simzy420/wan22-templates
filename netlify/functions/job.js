/**
 * GET /api/job?id=<uuid>
 * Polled by the phone UI while generate-background waits on Wan.
 */
import { netlifyJobStore, publicJob } from "../../server/jobs.js";

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
};

function json(statusCode, body) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

export async function handler(event, context) {
  if ((event.httpMethod || "GET") === "OPTIONS") {
    return { statusCode: 204, headers: JSON_HEADERS, body: "" };
  }
  if ((event.httpMethod || "GET") !== "GET") {
    return json(405, { error: "Method not allowed" });
  }
  const id = event.queryStringParameters?.id || "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return json(400, { error: "Missing job id" });
  }
  try {
    const store = context?.store || netlifyJobStore(event);
    const record = await store.getJSON(id);
    if (!record) return json(404, { error: "Unknown job" });
    return json(200, publicJob(record));
  } catch (error) {
    return json(500, { error: error instanceof Error ? error.message : String(error) });
  }
}
