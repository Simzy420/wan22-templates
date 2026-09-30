/**
 * Vercel: GET /api/job?id=<runpod job id>
 * Polls https://api.runpod.ai/v2/<endpoint>/status/<id> with RUNPOD_API_KEY.
 */
import { handleRunpodJobRequest } from "../server/runpodRoutes.js";

export const maxDuration = 30;

export async function GET(request) {
  return handleRunpodJobRequest(request);
}

export async function OPTIONS(request) {
  return handleRunpodJobRequest(request);
}

export default {
  async fetch(request) {
    return handleRunpodJobRequest(request);
  },
};
