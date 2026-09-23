/**
 * Become the Character — Netlify / Vite UI
 * Templates from HF dataset CDN; generate via Gradio Space API.
 */

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
/** Opaque Gradio session state from Space (optional; Space keeps its own). */
let sessionState = {};

const els = {
  rail: document.getElementById("template-rail"),
  status: document.getElementById("templates-status"),
  refresh: document.getElementById("btn-refresh"),
  selectedPanel: document.getElementById("selected-panel"),
  selectedPreview: document.getElementById("selected-preview"),
  selectedTitle: document.getElementById("selected-title"),
  selectedDesc: document.getElementById("selected-desc"),
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
};

function videoUrl(t) {
  if (t.video_url) return t.video_url;
  const rel = t.video_path || t.video || "";
  return CDN_BASE + rel.replace(/^\//, "");
}

function updateGenerateEnabled() {
  els.btnGen.disabled = !(selectedId && photoFile);
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
      return;
    }
    els.status.textContent = `${templates.length} templates · demos are placeholders`;
    for (const t of templates) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tcard" + (t.id === selectedId ? " active" : "");
      btn.dataset.id = t.id;
      const url = videoUrl(t);
      btn.innerHTML = `
        <video muted loop playsinline preload="metadata" src="${url}"></video>
        <div class="meta">
          <strong>${escapeHtml(t.title || t.id)}</strong>
          <span>~${t.duration_s ?? "?"}s · ${escapeHtml(t.category || "demo")}</span>
        </div>`;
      const vid = btn.querySelector("video");
      btn.addEventListener("mouseenter", () => vid && vid.play().catch(() => {}));
      btn.addEventListener("mouseleave", () => {
        if (vid) {
          vid.pause();
          vid.currentTime = 0;
        }
      });
      btn.addEventListener("click", () => selectTemplate(t.id));
      els.rail.appendChild(btn);
    }
    if (!selectedId && templates[0]) selectTemplate(templates[0].id);
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

function selectTemplate(id) {
  selectedId = id;
  const t = templates.find((x) => x.id === id);
  document.querySelectorAll(".tcard").forEach((el) => {
    el.classList.toggle("active", el.dataset.id === id);
  });
  if (!t) return;
  els.selectedPanel.hidden = false;
  els.selectedTitle.textContent = t.title || t.id;
  els.selectedDesc.textContent = t.description || "";
  const url = videoUrl(t);
  els.selectedPreview.src = url;
  els.selectedPreview.muted = true;
  els.selectedPreview.play().catch(() => {});
  updateGenerateEnabled();
}

function setPhoto(file) {
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
  e.preventDefault();
  els.uploadZone.classList.add("drag");
});
els.uploadZone.addEventListener("dragleave", () => els.uploadZone.classList.remove("drag"));
els.uploadZone.addEventListener("drop", (e) => {
  e.preventDefault();
  els.uploadZone.classList.remove("drag");
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) setPhoto(f);
});

els.refresh.addEventListener("click", () => loadCatalog());
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
    url = fileOrUrl.url || fileOrUrl.path || fileOrUrl;
  }
  if (!url) throw new Error("No video returned");
  lastResultUrl = typeof url === "string" ? url : String(url);
  els.resultPanel.hidden = false;
  els.resultVideo.src = lastResultUrl;
  els.resultVideo.play().catch(() => {});
  els.btnDownload.href = lastResultUrl;
}

/** Call Space via @gradio/client, or Netlify proxy if USE_PROXY. */
async function callSpace(apiName, payload) {
  if (USE_PROXY) {
    const form = new FormData();
    form.append("api", apiName);
    form.append("payload", JSON.stringify(payload.json || {}));
    if (payload.photo) form.append("photo", payload.photo, payload.photo.name || "photo.jpg");
    const res = await fetch("/api/generate", { method: "POST", body: form });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `Proxy HTTP ${res.status}`);
    }
    return res.json();
  }

  const { Client } = await import("@gradio/client");
  const client = await Client.connect(SPACE);
  const result = await client.predict(apiName, payload.args);
  return result;
}

els.btnGen.addEventListener("click", async () => {
  if (!selectedId || !photoFile) return;
  setBusy("Queuing on ZeroGPU… this can take 1–3+ minutes when busy.");
  try {
    if (USE_PROXY) {
      const data = await callSpace("/generate", {
        json: {
          template_id: selectedId,
          prompt: els.prompt.value,
        },
        photo: photoFile,
      });
      showResult(data.video || data.url);
      if (data.state) sessionState = data.state;
    } else {
      const { Client, handle_file } = await import("@gradio/client");
      // handle_file may not exist in browser build — pass File / Blob directly
      const client = await Client.connect(SPACE);
      const result = await client.predict("/generate", {
        template_id: selectedId,
        image: photoFile,
        prompt: els.prompt.value || "a person, natural motion, cinematic, high quality",
        max_seconds: 3,
        height: 480,
        width: 384,
        steps: 6,
        guidance: 1,
        sample_shift: 5,
        negative: "",
        seed: 42,
        state: sessionState || {},
      });
      // result.data is typically [video, download, status, last_frame, state]
      const data = result?.data || result;
      const video = Array.isArray(data) ? data[0] : data;
      if (Array.isArray(data) && data[4]) sessionState = data[4];
      showResult(video);
      els.genStatus.textContent = Array.isArray(data) && data[2] ? String(data[2]).replace(/[*`]/g, "") : "Done.";
    }
  } catch (e) {
    console.error(e);
    els.genStatus.textContent = `Generate failed: ${e.message || e}. If CORS blocked, set window.CONFIG.USE_PROXY = true and redeploy.`;
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
    const { Client } = await import("@gradio/client");
    const client = await Client.connect(SPACE);
    const api = auto ? "/auto_extend" : "/extend";
    const args = auto
      ? {
          target_seconds: Number(els.extendTarget.value),
          prompt: els.prompt.value,
          seg_duration: 3.5,
          steps: 4,
          negative: "",
          seed: 42,
          randomize: true,
          quality: 6,
          fps: 16,
          safe_mode: true,
          state: sessionState || {},
        }
      : {
          prompt: els.prompt.value,
          seg_duration: 3.5,
          steps: 4,
          negative: "",
          seed: 42,
          randomize: true,
          quality: 6,
          fps: 16,
          safe_mode: true,
          state: sessionState || {},
        };
    const result = await client.predict(api, args);
    const data = result?.data || result;
    const video = Array.isArray(data) ? data[0] : data;
    if (Array.isArray(data) && data[4]) sessionState = data[4];
    showResult(video);
    els.genStatus.textContent = Array.isArray(data) && data[2] ? String(data[2]).replace(/[*`]/g, "") : "Extended.";
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
