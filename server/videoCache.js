/**
 * Warm-instance cache for Runpod result mp4s.
 * Vercel /api/result must Range-chunk responses under ~4MB. Without a cache,
 * every Range request re-downloads the full Runpod /status JSON (often
 * 10–40MB of base64) and the phone never gets a playable clip.
 */
const TTL_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 12;

/** @type {Map<string, { bytes: Buffer, contentType: string, at: number }>} */
const cache = new Map();

function touch(jobId, entry) {
  cache.delete(jobId);
  cache.set(jobId, entry);
}

function evictExpired(now = Date.now()) {
  for (const [id, entry] of cache) {
    if (now - entry.at > TTL_MS) cache.delete(id);
  }
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

export function putCachedVideo(jobId, bytes, contentType = "video/mp4") {
  const id = String(jobId || "");
  if (!id || !bytes?.length) return;
  const body = Buffer.isBuffer(bytes) ? Buffer.from(bytes) : Buffer.from(bytes);
  touch(id, { bytes: body, contentType: contentType || "video/mp4", at: Date.now() });
  evictExpired();
}

export function getCachedVideo(jobId) {
  const id = String(jobId || "");
  if (!id) return null;
  evictExpired();
  const hit = cache.get(id);
  if (!hit) return null;
  touch(id, { ...hit, at: Date.now() });
  return { bytes: Buffer.from(hit.bytes), contentType: hit.contentType };
}

export function clearVideoCache() {
  cache.clear();
}
