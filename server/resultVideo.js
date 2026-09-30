/**
 * Same-origin GET /api/result?id=<job>
 * Plays the mp4 stored by the Runpod background job so phone Safari never
 * loads a cross-origin file or a data URL.
 */
import { isJobId, resultVideoKey } from "./runpod.js";

const MAX_CHUNK = 4_000_000;

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}

function parseRange(header, total) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(header || "").trim());
  if (!match) return { error: 416 };
  let start = match[1] === "" ? null : Number(match[1]);
  let end = match[2] === "" ? null : Number(match[2]);
  if (start != null && !Number.isFinite(start)) return { error: 416 };
  if (end != null && !Number.isFinite(end)) return { error: 416 };
  if (start == null && end == null) return { error: 416 };
  if (start == null) {
    const suffix = end;
    if (!suffix) return { error: 416 };
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else if (end == null) {
    end = total - 1;
  }
  if (start < 0 || start >= total || end < start) return { error: 416 };
  end = Math.min(end, total - 1, start + MAX_CHUNK - 1);
  return { start, end };
}

export async function handleResultRequest(request, deps = {}) {
  const method = request?.method || "GET";
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Range, Content-Type",
        "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
      },
    });
  }
  if (method !== "GET" && method !== "HEAD") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }
  let id = "";
  try {
    id = new URL(request.url).searchParams.get("id") || "";
  } catch {
    id = "";
  }
  if (!isJobId(id)) {
    return jsonResponse({ error: "Missing job id" }, 400);
  }
  const store = deps.store;
  if (!store) return jsonResponse({ error: "Result store is not available." }, 500);
  let record;
  try {
    record = await store.getJSON(id);
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "Could not read the job." }, 500);
  }
  if (!record || record.phase !== "done") {
    return jsonResponse({ error: "Result is not ready" }, 404);
  }
  let file = null;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      file = await store.getBytes(resultVideoKey(id));
      if (file?.data?.length) break;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 150));
    }
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "Could not read the result video." }, 500);
  }
  if (!file?.data?.length) return jsonResponse({ error: "Result video is missing." }, 404);

  const bytes = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
  const contentType = file.metadata?.contentType || "video/mp4";
  return serveVideoBytes(request, bytes, contentType);
}

export function serveVideoBytes(request, bytes, contentType = "video/mp4") {
  const method = request?.method || "GET";
  const total = bytes.length;
  const rangeHeader = request.headers.get("range");
  let status = 200;
  let start = 0;
  let end = total - 1;
  if (rangeHeader) {
    const parsed = parseRange(rangeHeader, total);
    if (parsed.error) {
      return new Response(null, {
        status: 416,
        headers: {
          "Content-Range": `bytes */${total}`,
          "Accept-Ranges": "bytes",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
    status = 206;
    start = parsed.start;
    end = parsed.end;
  } else if (total > MAX_CHUNK) {
    return jsonResponse(
      { error: "The result video is too large to send in one response. Try Generate again." },
      502
    );
  }

  const slice = bytes.subarray(start, end + 1);
  const headers = {
    "Content-Type": contentType,
    "Content-Length": String(slice.length),
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
    "Content-Disposition": 'inline; filename="become-the-character.mp4"',
  };
  if (status === 206) headers["Content-Range"] = `bytes ${start}-${end}/${total}`;
  return new Response(method === "HEAD" ? null : slice, { status, headers });
}
