/**
 * Netlify's gateway answers a silent synchronous function with an HTML page:
 * "Inactivity Timeout — Too much time has passed without sending any data".
 * That page must never be shown as the Generate error.
 */

export const IDLE_TIMEOUT_MESSAGE =
  "Wan took longer than this connection allows, so the host closed it. A run usually takes several minutes, and a busy queue can take longer than 10. Leave this tab open and try Generate once.";

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
