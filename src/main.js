/**
 * Become the Character — Vercel / Vite UI
 * Templates from HF dataset CDN. Generate and extend go through
 * same-origin /api/generate when USE_PROXY is true (required on iPhone).
 * Result video URLs on the Space host are rewritten to /api/video.
 */
import { rewriteSpaceVideoUrl } from "../server/videoUrl.js";

const cfg = window.CONFIG || {};
const SPACE = import.meta.env.VITE_HF_SPACE || cfg.HF_SPACE || "https://simzy-wan-2-2-templates.hf.space";
const CATALOG_URL =
  import.meta.env.VITE_CATALOG_URL ||
  cfg.CATALOG_URL ||
  "https://huggingface.co/datasets/Simzy/wan22-template-clips/resolve/main/templates/catalog.json";
const CDN_BASE =
  cfg.DATASET_CDN_BASE ||
  "https://huggingface.co/datasets/Simzy/wan22-template-clips/resolve/main/";
const USE_PROXY = cfg.USE_PROXY === true;

let templates = [];
let selectedId = null;
let photoFile = null;
let photoBlobUrl = null;
let lastResultUrl = null;
/** Session id returned by Space /generate for /extend API calls. */
let sessionId = "";

const els = {
  rail: document.getElementById("template-rail"),
  status: document.getElementById("templates-status"),
  refresh: document.getElementById("btn-refresh"),
  selectedPanel: document.getElementById("selected-panel"),
  selectedTitle: document.getElementById("selected-title"),
  selectedDesc: document.getElementById("selected-desc"),
  uploadSection: document.getElementById("upload-section"),
  uploadHint: document.getElementById("upload-hint"),
  uploadZone: document.getElementById("upload-zone"),
  uploadInner: document.getElementById("upload-inner"),
  photoInput: document.getElementById("photo-input"),
  photoPreview: document.getElementById("photo-preview"),
  prompt: document.getElementById("prompt"),
  btnGen: document.getElementById("btn-generate"),
  genStatus: document.getElementById("gen-status"),
  resultPanel: document.getElementById("result-panel"),
  resultVideo: document.getElementById("result-video"),
  btnDownload: document.getElementById("btn-download"),
  btnExtend: document.getElementById("btn-extend"),
  btnAuto: document.getElementById("btn-auto-extend"),
  extendTarget: document.getElementById("extend-target"),
  extendTargetVal: document.getElementById("extend-target-val"),
  howtoBtn: document.getElementById("btn-howto"),
  howtoDialog: document.getElementById("howto-dialog"),
  howtoClose: document.getElementById("btn-howto-close"),
};

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let playObserver = null;

function videoUrl(t) {
  if (t.video_url) return t.video_url;
  const rel = t.video_path || t.video || "";
  return CDN_BASE + rel.replace(/^\//, "");
}

function updateGenerateEnabled() {
  els.btnGen.disabled = !(selectedId && photoFile);
}

function armVideo(vid) {
  vid.muted = true;
  vid.defaultMuted = true;
  vid.loop = true;
  vid.playsInline = true;
  vid.autoplay = true;
  vid.setAttribute("muted", "");
  vid.setAttribute("playsinline", "");
  vid.setAttribute("webkit-playsinline", "");
  if (!vid.getAttribute("src") && vid.dataset.src) vid.src = vid.dataset.src;
}

function visibleRatio(el) {
  const rect = el.getBoundingClientRect();
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  if (rect.width <= 0 || rect.height <= 0) return 0;
  const w = Math.min(rect.right, vw) - Math.max(rect.left, 0);
  const h = Math.min(rect.bottom, vh) - Math.max(rect.top, 0);
  return (Math.max(0, w) / rect.width) * (Math.max(0, h) / rect.height);
}

function syncPlayback() {
  els.rail.querySelectorAll("video").forEach((vid) => {
    const selected = vid.closest(".tcard")?.classList.contains("active");
    const ratio = visibleRatio(vid);
    const shouldPlay = !reduceMotion && (ratio >= 0.12 || (selected && ratio > 0.02));
    if (shouldPlay) {
      armVideo(vid);
      vid.play().catch(() => {
        vid.controls = true;
      });
    } else {
      vid.pause();
    }
  });
}

function observeRail() {
  if (playObserver) playObserver.disconnect();
  playObserver = new IntersectionObserver(() => syncPlayback(), {
    root: null,
    rootMargin: "80px 120px",
    threshold: [0, 0.15, 0.4, 0.75],
  });
  els.rail.querySelectorAll("video").forEach((vid) => playObserver.observe(vid));
  syncPlayback();
}

function lockUpload() {
  els.uploadSection.classList.add("is-locked");
  els.uploadSection.classList.remove("is-ready");
  els.uploadSection.setAttribute("aria-disabled", "true");
  els.photoInput.disabled = true;
  els.uploadHint.textContent = "Pick a motion above to unlock this step.";
  els.selectedPanel.hidden = true;
}

function focusUpload() {
  els.uploadSection.classList.remove("is-locked");
  els.uploadSection.classList.add("is-ready");
  els.uploadSection.setAttribute("aria-disabled", "false");
  els.photoInput.disabled = false;
  els.uploadHint.textContent = "Upload a still of the person who should do this motion.";
  els.uploadSection.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
  els.uploadSection.focus({ preventScroll: true });
}

async function loadCatalog() {
  els.status.textContent = "Loading templates…";
  els.rail.innerHTML = "";
  try {
    const res = await fetch(CATALOG_URL + (CATALOG_URL.includes("?") ? "&" : "?") + "t=" + Date.now());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    templates = await res.json();
    if (!Array.isArray(templates) || !templates.length) {
      els.status.textContent = "No templates in catalog yet.";
      lockUpload();
      return;
    }
    if (selectedId && !templates.some((t) => t.id === selectedId)) {
      selectedId = null;
      lockUpload();
    }
    els.status.textContent = `${templates.length} motions · swipe to see them all`;
    for (const t of templates) {
      const card = document.createElement("article");
      card.className = "tcard" + (t.id === selectedId ? " active" : "");
      card.dataset.id = t.id;
      card.setAttribute("role", "listitem");
      const url = videoUrl(t);
      const title = t.title || t.id;
      const dur = t.duration_s ?? "?";
      card.innerHTML = `
        <div class="tcard-media">
          <video muted loop playsinline webkit-playsinline autoplay preload="none" data-src="${escapeHtml(url)}" aria-label="${escapeHtml(title)}"></video>
        </div>
        <div class="meta">
          <strong>${escapeHtml(title)}</strong>
          <span>~${escapeHtml(dur)}s · ${escapeHtml(t.category || "motion")}</span>
        </div>
        <button type="button" class="tcard-hit" aria-pressed="${t.id === selectedId ? "true" : "false"}" aria-label="Select ${escapeHtml(title)}">
          <span class="tcard-cta">${t.id === selectedId ? "Selected" : "Select"}</span>
        </button>`;
      card.querySelector(".tcard-hit").addEventListener("click", () => selectTemplate(t.id));
      els.rail.appendChild(card);
    }
    observeRail();
    if (selectedId) selectTemplate(selectedId, { scrollUpload: false });
  } catch (e) {
    console.error(e);
    els.status.textContent = `Could not load catalog: ${e.message}`;
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function selectTemplate(id, opts = {}) {
  const scrollUpload = opts.scrollUpload !== false;
  selectedId = id;
  const t = templates.find((x) => x.id === id);
  document.querySelectorAll(".tcard").forEach((el) => {
    const on = el.dataset.id === id;
    el.classList.toggle("active", on);
    const hit = el.querySelector(".tcard-hit");
    if (hit) {
      hit.setAttribute("aria-pressed", on ? "true" : "false");
      const cta = hit.querySelector(".tcard-cta");
      if (cta) cta.textContent = on ? "Selected" : "Select";
    }
    if (on && scrollUpload) {
      const left = el.offsetLeft - (els.rail.clientWidth - el.clientWidth) / 2;
      els.rail.scrollTo({ left: Math.max(0, left), behavior: reduceMotion ? "auto" : "smooth" });
    }
  });
  if (!t) {
    lockUpload();
    updateGenerateEnabled();
    return;
  }
  els.selectedPanel.hidden = false;
  els.selectedTitle.textContent = t.title || t.id;
  els.selectedDesc.textContent = t.description || "";
  syncPlayback();
  updateGenerateEnabled();
  if (scrollUpload) focusUpload();
}

function setPhoto(file) {
  if (!selectedId || els.photoInput.disabled) return;
  if (!file || !file.type.startsWith("image/")) return;
  photoFile = file;
  if (photoBlobUrl) URL.revokeObjectURL(photoBlobUrl);
  photoBlobUrl = URL.createObjectURL(file);
  els.photoPreview.src = photoBlobUrl;
  els.photoPreview.hidden = false;
  els.uploadInner.hidden = true;
  updateGenerateEnabled();
}

els.photoInput.addEventListener("change", () => {
  const f = els.photoInput.files && els.photoInput.files[0];
  if (f) setPhoto(f);
});
els.uploadZone.addEventListener("dragover", (e) => {
  if (!selectedId) return;
  e.preventDefault();
  els.uploadZone.classList.add("drag");
});
els.uploadZone.addEventListener("dragleave", () => els.uploadZone.classList.remove("drag"));
els.uploadZone.addEventListener("drop", (e) => {
  if (!selectedId) return;
  e.preventDefault();
  els.uploadZone.classList.remove("drag");
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) setPhoto(f);
});

els.refresh.addEventListener("click", () => loadCatalog());
window.addEventListener("scroll", syncPlayback, { passive: true });
window.addEventListener("resize", syncPlayback);
els.rail.addEventListener("scroll", syncPlayback, { passive: true });

function openHowto() {
  if (typeof els.howtoDialog.showModal === "function") els.howtoDialog.showModal();
  else els.howtoDialog.setAttribute("open", "");
}
function closeHowto() {
  if (typeof els.howtoDialog.close === "function") els.howtoDialog.close();
  else els.howtoDialog.removeAttribute("open");
  els.howtoBtn.focus();
}
els.howtoBtn.addEventListener("click", openHowto);
els.howtoClose.addEventListener("click", closeHowto);
els.howtoDialog.addEventListener("click", (e) => {
  if (e.target === els.howtoDialog) closeHowto();
});
els.extendTarget.addEventListener("input", () => {
  els.extendTargetVal.textContent = `${els.extendTarget.value}s`;
});

function setBusy(msg) {
  els.genStatus.textContent = msg || "";
  els.btnGen.disabled = true;
  els.btnExtend.disabled = true;
  els.btnAuto.disabled = true;
}

function clearBusy() {
  updateGenerateEnabled();
  els.btnExtend.disabled = false;
  els.btnAuto.disabled = false;
}

function showResult(fileOrUrl) {
  let url = fileOrUrl;
  if (fileOrUrl && typeof fileOrUrl === "object") {
    const nested = fileOrUrl.video && typeof fileOrUrl.video === "object" ? fileOrUrl.video : null;
    url = (nested && (nested.url || nested.path)) || fileOrUrl.url || fileOrUrl.path || fileOrUrl;
  }
  if (!url || typeof url !== "string") throw new Error("No video returned");
  url = rewriteSpaceVideoUrl(url, SPACE);
  lastResultUrl = url;
  els.resultPanel.hidden = false;
  els.resultVideo.src = lastResultUrl;
  els.resultVideo.play().catch(() => {});
  els.btnDownload.href = lastResultUrl;
}

function statusText(value, fallback) {
  if (value == null || value === "") return fallback;
  return String(value).replace(/[*`]/g, "");
}

function rememberSession(data) {
  if (!data) return;
  if (Array.isArray(data) && data[4]) {
    sessionId = String(data[4]);
    return;
  }
  const sid = data.session_id || (typeof data.state === "string" ? data.state : "");
  if (sid) sessionId = String(sid);
}

/** Vercel/Netlify request bodies are about 4.5 MB. Shrink large phone stills. */
async function photoForUpload(file) {
  const limit = 3.5 * 1024 * 1024;
  if (!file || file.size <= limit) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const maxEdge = 1280;
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
    if (typeof bitmap.close === "function") bitmap.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
    if (!blob) return file;
    return new File([blob], "photo.jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}

function generateArgs() {
  return {
    template_id: selectedId,
    prompt: els.prompt.value || "a person, natural motion, cinematic, high quality",
    max_seconds: 3,
    height: 480,
    width: 384,
    steps: 6,
    guidance: 1,
    sample_shift: 5,
    negative: "",
    seed: 42,
    session_id: sessionId || "",
  };
}

function extendArgs(auto) {
  const args = {
    prompt: els.prompt.value,
    seg_duration: 3.5,
    steps: 4,
    negative: "",
    seed: 42,
    randomize: true,
    quality: 6,
    fps: 16,
    safe_mode: true,
    session_id: sessionId,
  };
  if (auto) args.target_seconds = Number(els.extendTarget.value);
  return args;
}

/** Same-origin proxy. Used for generate, extend, and auto_extend when USE_PROXY is true. */
async function callSpace(apiName, payload) {
  const form = new FormData();
  form.append("api", apiName);
  form.append("payload", JSON.stringify(payload.json || {}));
  if (payload.photo) {
    const photo = await photoForUpload(payload.photo);
    form.append("photo", photo, photo.name || "photo.jpg");
  }
  const res = await fetch("/api/generate", { method: "POST", body: form });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    throw new Error((data && data.error) || text || `Proxy HTTP ${res.status}`);
  }
  if (!data) throw new Error("Proxy returned an empty response");
  return data;
}

els.btnGen.addEventListener("click", async () => {
  if (!selectedId || !photoFile) return;
  setBusy("Queuing on ZeroGPU… this can take 1–3+ minutes when busy.");
  try {
    const args = generateArgs();
    if (USE_PROXY) {
      const data = await callSpace("/generate", { json: args, photo: photoFile });
      rememberSession(data);
      showResult(data.video || data.url);
      els.genStatus.textContent = statusText(data.status, "Done.");
    } else {
      const { Client } = await import("@gradio/client");
      const client = await Client.connect(SPACE);
      const result = await client.predict("/generate", { ...args, image: photoFile });
      // result.data: [video, download, status, last_frame, session_id]
      const data = result?.data || result;
      const video = Array.isArray(data) ? data[0] : data;
      rememberSession(data);
      showResult(video);
      els.genStatus.textContent = statusText(Array.isArray(data) ? data[2] : null, "Done.");
    }
  } catch (e) {
    console.error(e);
    const hint = USE_PROXY
      ? ""
      : " If CORS blocked, set window.CONFIG.USE_PROXY = true and redeploy.";
    els.genStatus.textContent = `Generate failed: ${e.message || e}.${hint}`;
  } finally {
    clearBusy();
  }
});

async function extendOnce(auto) {
  if (!lastResultUrl) {
    els.genStatus.textContent = "Generate a clip first.";
    return;
  }
  setBusy(auto ? "Auto-extending (multiple ZeroGPU calls)…" : "Extending…");
  try {
    const api = auto ? "/auto_extend" : "/extend";
    if (!sessionId) {
      throw new Error("Missing session_id — generate first in this browser session.");
    }
    const args = extendArgs(auto);
    if (USE_PROXY) {
      const data = await callSpace(api, { json: args });
      rememberSession(data);
      showResult(data.video || data.url);
      els.genStatus.textContent = statusText(data.status, "Extended.");
    } else {
      const { Client } = await import("@gradio/client");
      const client = await Client.connect(SPACE);
      const result = await client.predict(api, args);
      const data = result?.data || result;
      const video = Array.isArray(data) ? data[0] : data;
      rememberSession(data);
      showResult(video);
      els.genStatus.textContent = statusText(Array.isArray(data) ? data[2] : null, "Extended.");
    }
  } catch (e) {
    console.error(e);
    els.genStatus.textContent = `Extend failed: ${e.message || e}`;
  } finally {
    clearBusy();
  }
}

els.btnExtend.addEventListener("click", () => extendOnce(false));
els.btnAuto.addEventListener("click", () => extendOnce(true));

loadCatalog();
