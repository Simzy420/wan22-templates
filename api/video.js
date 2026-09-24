/**
 * Vercel serverless route: GET /api/video?url=<encoded Space file URL>
 *
 * Env:
 *   HF_SPACE_URL  optional, default https://simzy-wan-2-2-templates.hf.space
 *   HF_TOKEN      optional; forwarded as Authorization: Bearer for private files
 */
import { handleVideoRequest } from "../server/videoProxy.js";

export const maxDuration = 60;

export async function GET(request) {
  return handleVideoRequest(request);
}

export async function HEAD(request) {
  return handleVideoRequest(request);
}

export async function OPTIONS(request) {
  return handleVideoRequest(request);
}

export default {
  async fetch(request) {
    return handleVideoRequest(request);
  },
};
