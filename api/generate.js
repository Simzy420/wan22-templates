/**
 * Vercel serverless route: POST /api/generate
 * Same multipart contract as netlify/functions/generate.js (api, payload, photo).
 *
 * Generate posts to Runpod /run and returns { job_id, phase: "queued" }.
 * The phone polls /api/job (/status) and plays /api/result. The Space is used
 * for Extend, and for Generate only when HF_GENERATE_FALLBACK is set and
 * RUNPOD_API_KEY is absent.
 *
 * Env (server-side, Production and Preview):
 *   RUNPOD_API_KEY       required for Generate
 *   RUNPOD_ENDPOINT_ID   swapr-wan-animate, zrmwpir4qzs66s
 *   RUNPOD_ENDPOINT_URL  optional https://api.runpod.ai/v2/zrmwpir4qzs66s
 *   HF_GENERATE_FALLBACK optional; Space only when the Runpod key is absent
 *   HF_SPACE_URL         optional, Extend only
 *   HF_TOKEN             optional Hugging Face token (server-side only)
 *
 * maxDuration stays 300s because Extend still waits on the Space.
 * Netlify cannot (60s), so it queues a background job instead.
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
