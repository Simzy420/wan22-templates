/**
 * Optional proxy when browser CORS blocks direct Gradio calls.
 * POST multipart: api, payload (JSON string), photo (file, for /generate)
 *
 * Requires env HF_TOKEN (optional but recommended for Pro quota) and
 * HF_SPACE_URL (default https://simzy-wan-2-2-templates.hf.space).
 *
 * Enable in public/config.js: USE_PROXY: true
 */
const SPACE = process.env.HF_SPACE_URL || "https://simzy-wan-2-2-templates.hf.space";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  try {
    // Dynamic import for Netlify Node 18+
    const { Client } = await import("@gradio/client");
    const busboy = await import("busboy").catch(() => null);

    let api = "/generate";
    let payload = {};
    let photoBuffer = null;
    let photoName = "photo.jpg";
    let photoMime = "image/jpeg";

    const contentType = event.headers["content-type"] || event.headers["Content-Type"] || "";

    if (contentType.includes("multipart/form-data") && busboy) {
      const bb = busboy.default({ headers: { "content-type": contentType } });
      const chunks = [];
      await new Promise((resolve, reject) => {
        const body = event.isBase64Encoded
          ? Buffer.from(event.body || "", "base64")
          : Buffer.from(event.body || "", "utf8");
        bb.on("file", (name, file, info) => {
          const bufs = [];
          file.on("data", (d) => bufs.push(d));
          file.on("end", () => {
            if (name === "photo") {
              photoBuffer = Buffer.concat(bufs);
              photoName = info.filename || photoName;
              photoMime = info.mimeType || photoMime;
            }
          });
        });
        bb.on("field", (name, val) => {
          if (name === "api") api = val;
          if (name === "payload") {
            try {
              payload = JSON.parse(val);
            } catch (_) {}
          }
        });
        bb.on("error", reject);
        bb.on("finish", resolve);
        bb.end(body);
      });
    } else {
      const json = JSON.parse(event.body || "{}");
      api = json.api || api;
      payload = json.payload || json;
    }

    const client = await Client.connect(SPACE, {
      hf_token: process.env.HF_TOKEN || undefined,
    });

    const args = { ...payload };
    if (photoBuffer) {
      const blob = new Blob([photoBuffer], { type: photoMime });
      args.image = new File([blob], photoName, { type: photoMime });
    }
    if (!args.state) args.state = {};

    const result = await client.predict(api.startsWith("/") ? api : `/${api}`, args);
    const data = result?.data || result;
    const video = Array.isArray(data) ? data[0] : data;
    const status = Array.isArray(data) ? data[2] : null;
    const state = Array.isArray(data) ? data[4] : null;

    let videoUrl = video;
    if (video && typeof video === "object") {
      videoUrl = video.url || video.path || video;
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ video: videoUrl, url: videoUrl, status, state }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: String(e && e.message ? e.message : e) }),
    };
  }
};
