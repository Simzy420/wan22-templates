import { handleBalanceRequest } from "../server/runpodAdmin.js";

export const maxDuration = 30;

export default {
  async fetch(request) {
    return handleBalanceRequest(request);
  },
};
