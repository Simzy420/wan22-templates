/**
 * Background worker (filename suffix -background). Netlify returns 202 to the
 * caller immediately and lets this run for up to 15 minutes.
 *
 * Always resolves successfully so the platform does not retry the GPU call.
 */
import { netlifyJobStore, runBackgroundJob, memoryJobStore } from "../../server/jobs.js";

function parseSpec(event) {
  const raw = event?.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : event?.body || "";
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  return JSON.parse(raw);
}

export async function handler(event, context) {
  try {
    const spec = parseSpec(event);
    const store = context?.store || (context?.memory ? memoryJobStore() : netlifyJobStore(event));
    if (spec?.job_id) {
      await runBackgroundJob(spec, {
        store,
        connect: context?.connect,
        env: context?.env || process.env,
        timeoutMs: context?.timeoutMs,
      });
    }
  } catch (error) {
    console.error("generate-background", error);
    try {
      const spec = parseSpec(event);
      const store = context?.store;
      if (spec?.job_id && store) {
        await store.setJSON(spec.job_id, {
          id: spec.job_id,
          phase: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } catch (writeError) {
      console.error("generate-background store", writeError);
    }
  }
  return { statusCode: 202, body: "" };
}
