/**
 * Vercel serverless route: POST /api/generate
 * Same contract as netlify/functions/generate.js (multipart api, payload, photo).
 *
 * Env:
 *   HF_SPACE_URL  optional, default https://simzy-wan-2-2-templates.hf.space
 *   HF_TOKEN      optional Hugging Face token (server-side only)
 *
 * maxDuration is also set in vercel.json (Hobby Fluid limit is 300s).
 */
import { handleGenerateRequest } from "../server/gradioProxy.js";

export const maxDuration = 300;

export async function POST(request) {
  return handleGenerateRequest(request);
}

export async function OPTIONS(request) {
  return handleGenerateRequest(request);
}

export default {
  async fetch(request) {
    return handleGenerateRequest(request);
  },
};
