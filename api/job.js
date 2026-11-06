/**
 * Vercel: GET /api/job?id=<runpod job id>
 * Polls /status with the API key for the account encoded on the job id
 * (`a1_` / `a2_` when both Runpod accounts are configured).
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
