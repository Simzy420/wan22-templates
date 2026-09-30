/**
 * Netlify's gateway answers a silent synchronous function with an HTML page:
 * "Inactivity Timeout — Too much time has passed without sending any data".
 * That page must never be shown as the Generate error.
 */

export const IDLE_TIMEOUT_MESSAGE =
  "Wan took longer than this connection allows, so the host closed it. A run usually takes several minutes, and a busy queue can take longer than 10. Leave this tab open and try Generate once.";

const SPACE_GENERATE_RE =
  /zerogpu|the space failed before returning a video|timed out waiting for wan animate/i;

export const RUNPOD_GENERATE_MESSAGE =
  "Generate uses Runpod Wan Animate, not the Hugging Face Space. If this deploy has no RUNPOD_API_KEY, add it for Production and Preview and redeploy. Otherwise try Generate once.";

/** Phone Generate status. The ZeroGPU Space sentence is never shown here. */
export function generateFailureText(input) {
  const text = publicErrorText(input);
  if (SPACE_GENERATE_RE.test(text)) return RUNPOD_GENERATE_MESSAGE;
  return text;
}

/**
 * When Runpod is configured, a Generate failure must not quote the Space.
 * Extend keeps its own Space errors.
 */
export function scrubGenerateError(input, runpodOn) {
  if (!runpodOn) return publicErrorText(input);
  return generateFailureText(input);
}

export function publicErrorText(input) {
  let raw = "";
  if (input == null || input === "") raw = "";
  else if (typeof input === "string") raw = input;
  else if (typeof input.message === "string" && input.message) raw = input.message;
  else if (typeof input.error === "string" && input.error) raw = input.error;
  else raw = String(input);

  const flat = raw.replace(/\s+/g, " ").trim();
  if (!flat) return "Generate failed";
  const lower = flat.toLowerCase();
  if (lower.includes("inactivity timeout") || lower.includes("without sending any data")) {
    return IDLE_TIMEOUT_MESSAGE;
  }
  if (lower.includes("<html") || lower.includes("<!doctype") || lower.includes("<body") || lower.includes("<h1")) {
    const stripped = flat.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return (stripped || IDLE_TIMEOUT_MESSAGE).slice(0, 400);
  }
  return flat.slice(0, 800);
}
