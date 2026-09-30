/**
 * Vercel: GET /api/result?id=<runpod job id>
 * Reads the completed /status output and streams the mp4 same-origin.
 */
import { handleRunpodResultRequest } from "../server/runpodRoutes.js";

export const maxDuration = 60;

export async function GET(request) {
  return handleRunpodResultRequest(request);
}

export async function HEAD(request) {
  return handleRunpodResultRequest(request);
}

export async function OPTIONS(request) {
  return handleRunpodResultRequest(request);
}

export default {
  async fetch(request) {
    return handleRunpodResultRequest(request);
  },
};
