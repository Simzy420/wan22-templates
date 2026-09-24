/**
 * Hugging Face Space file URLs and the same-origin /api/video rewrite.
 * Safe to import from the Vite client (no Node built-ins).
 */

export const DEFAULT_SPACE = "https://simzy-wan-2-2-templates.hf.space";

export class VideoProxyError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "VideoProxyError";
    this.statusCode = statusCode;
  }
}

export function parseHttpUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    return null;
  }
}

export function spaceHostnames(space = DEFAULT_SPACE) {
  const hosts = new Set();
  for (const value of [space, DEFAULT_SPACE]) {
    const parsed = parseHttpUrl(value);
    if (!parsed) continue;
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") continue;
    hosts.add(parsed.hostname.toLowerCase());
  }
  return hosts;
}

/** Hosts the video proxy may contact: HF_SPACE_URL and the default Space. */
export function allowedVideoHosts(env = {}) {
  const configured = env && env.HF_SPACE_URL ? env.HF_SPACE_URL : "";
  return spaceHostnames(configured || DEFAULT_SPACE);
}

export function isGradioFilePath(pathname) {
  const path = String(pathname || "");
  return path.startsWith("/gradio_api/file=") || path.startsWith("/file=") || path.includes("/file=");
}

export function isRelativeGradioFile(url) {
  if (typeof url !== "string" || !url) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//")) return false;
  return url.startsWith("file=") || url.startsWith("/file=") || url.startsWith("/gradio_api/") || url.includes("/file=");
}

export function isSameOriginVideoPath(url) {
  return typeof url === "string" && (url.startsWith("/api/video?") || url === "/api/video");
}

export function absolutizeSpaceUrl(url, space = DEFAULT_SPACE) {
  if (typeof url !== "string" || !url) return url;
  if (isSameOriginVideoPath(url)) return url;
  if (/^https?:\/\//i.test(url)) return url;
  const base = String(space || DEFAULT_SPACE).replace(/\/$/, "");
  if (url.startsWith("file=")) return `${base}/gradio_api/${url}`;
  if (url.includes("/file=") || url.startsWith("/gradio_api/") || url.startsWith("/file=")) {
    return url.startsWith("/") ? `${base}${url}` : `${base}/${url}`;
  }
  const path = url.startsWith("/") ? url : `/${url}`;
  return `${base}/gradio_api/file=${path}`;
}

/**
 * Turn a Space file URL into `/api/video?url=...` so the phone never loads
 * the Hugging Face host directly. Other hosts are left unchanged.
 */
export function rewriteSpaceVideoUrl(url, space = DEFAULT_SPACE) {
  if (typeof url !== "string" || !url.trim()) return url;
  const trimmed = url.trim();
  if (isSameOriginVideoPath(trimmed)) return trimmed;

  let candidate = trimmed;
  if (!/^https?:\/\//i.test(candidate)) {
    if (!isRelativeGradioFile(candidate)) return url;
    candidate = absolutizeSpaceUrl(candidate, space);
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return url;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return url;
  if (parsed.username || parsed.password) {
    parsed.username = "";
    parsed.password = "";
  }
  if (!spaceHostnames(space).has(parsed.hostname.toLowerCase())) return url;
  parsed.protocol = "https:";
  parsed.hash = "";
  return `/api/video?url=${encodeURIComponent(parsed.toString())}`;
}

/**
 * Absolute https Gradio file URL on HF_SPACE_URL or the default Space.
 * Rejects every other target so /api/video cannot be used as an open proxy.
 */
export function resolveAllowedVideoUrl(raw, env = {}) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new VideoProxyError("Missing video url", 400);
  }
  const input = raw.trim();
  if (isSameOriginVideoPath(input) || input.includes("/api/video?")) {
    throw new VideoProxyError("Video URL is not allowed", 400);
  }

  const configured = String((env && env.HF_SPACE_URL) || "").trim();
  const space = configured || DEFAULT_SPACE;
  let absolute = input;
  if (!/^https:\/\//i.test(input)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(input) || input.startsWith("//")) {
      throw new VideoProxyError("Video URL is not allowed", 400);
    }
    if (!isRelativeGradioFile(input)) {
      throw new VideoProxyError("Video URL is not allowed", 400);
    }
    absolute = absolutizeSpaceUrl(input, space);
  }

  let parsed;
  try {
    parsed = new URL(absolute);
  } catch {
    throw new VideoProxyError("Video URL is not allowed", 400);
  }
  if (parsed.protocol !== "https:") {
    throw new VideoProxyError("Video URL is not allowed", 400);
  }
  if (parsed.username || parsed.password || parsed.port) {
    throw new VideoProxyError("Video URL is not allowed", 400);
  }
  if (!allowedVideoHosts(env).has(parsed.hostname.toLowerCase())) {
    throw new VideoProxyError("Video URL host is not allowed", 400);
  }
  if (!isGradioFilePath(parsed.pathname)) {
    throw new VideoProxyError("Video URL is not allowed", 400);
  }
  parsed.hash = "";
  return parsed.toString();
}
