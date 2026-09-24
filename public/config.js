// Override at deploy time if needed. Subdomain uses HF slug rules.
window.CONFIG = {
  HF_SPACE: "https://simzy-wan-2-2-templates.hf.space",
  CATALOG_URL:
    "https://huggingface.co/datasets/Simzy/wan22-template-clips/resolve/main/templates/catalog.json",
  DATASET_CDN_BASE:
    "https://huggingface.co/datasets/Simzy/wan22-template-clips/resolve/main/",
  // Phone Safari blocks direct @gradio/client calls to the Space ("Load failed").
  // true posts Generate / Extend / Auto-extend to same-origin /api/generate.
  USE_PROXY: true,
};
