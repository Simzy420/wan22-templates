import { defineConfig } from "vite";
import { handleGenerateRequest } from "./server/gradioProxy.js";
import { handleRunpodJobRequest, handleRunpodResultRequest } from "./server/runpodRoutes.js";
import { handleVideoRequest } from "./server/videoProxy.js";

function webRequest(req, body) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue;
    if (Array.isArray(value)) value.forEach((item) => headers.append(key, item));
    else headers.set(key, String(value));
  }
  const method = req.method || "GET";
  const init = { method, headers };
  if (method !== "GET" && method !== "HEAD") init.body = body;
  return new Request(`http://${req.headers.host || "127.0.0.1"}${req.url}`, init);
}

/** Mount the same API handlers production uses on Vercel. */
function apiDev() {
  return {
    name: "api-dev",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = (req.url || "").split("?")[0];
        const handlers = {
          "/api/generate": handleGenerateRequest,
          "/api/video": handleVideoRequest,
          "/api/job": handleRunpodJobRequest,
          "/api/result": handleRunpodResultRequest,
        };
        const handle = handlers[path];
        if (!handle) return next();
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const request = webRequest(req, Buffer.concat(chunks));
          const response = await handle(request);
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (error) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
      });
    },
  };
}

export default defineConfig({
  root: ".",
  publicDir: "public",
  plugins: [apiDev()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
});
