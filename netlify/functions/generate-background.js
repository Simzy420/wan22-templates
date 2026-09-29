/**
 * Background worker (filename suffix -background). Netlify returns 202 to the
 * caller immediately and lets this run for up to 15 minutes.
 *
 * Generate polls Runpod until COMPLETED, then stores the mp4 for /api/result.
 * Extend still calls the Space. Always resolves successfully so the platform
 * does not retry the GPU call. netlify.toml also sets background = true.
 */
import { memoryJobStore, netlifyFunctionEnv, netlifyJobStore, runBackgroundJob } from "../../server/jobs.js";

export const config = { background: true };

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
        env: netlifyFunctionEnv(context),
        fetch: context?.fetch,
        timeoutMs: context?.timeoutMs,
        intervalMs: context?.intervalMs,
        sleep: context?.sleep,
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
