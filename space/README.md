---
title: Wan 2.2 Templates — Become the Character
emoji: 🎭
colorFrom: purple
colorTo: pink
sdk: gradio
sdk_version: 5.49.1
app_file: app.py
pinned: false
license: apache-2.0
short_description: Template motion → become the character (Wan Animate proxy)
---

# Wan 2.2 Templates

Proxy Space: calls upstream ZeroGPU Spaces (`hugging-apps/wan2-2-animate-2-14b` animate,
optional `kulkas2pintu/wan222` extend). Templates from dataset
[`Simzy/wan22-template-clips`](https://huggingface.co/datasets/Simzy/wan22-template-clips)
(**real ~4s human-motion clips**).

The UI is a phone-width gallery: clips autoplay muted and inline, and the still
upload stays locked until a template is selected. **How to use & create templates**
covers the pick → upload → generate/extend flow and how to add a 3–5s clip to
`templates/catalog.json`.

API routes are unchanged: `/generate`, `/extend`, `/auto_extend`, `/reset`, `/list_templates`.

## Usage tip (quota)

If you hit **failed too many attempts** / **429** / queue timeout: **wait 10–15 minutes**
and click Generate **once**. Do not spam retries — each attempt burns ZeroGPU quota.

Space secret `HF_TOKEN` (Pro) + visitor `x-ip-token` forwarding for browser users.

This folder is the source to copy onto the HF Space repo. GitHub does not deploy the Space by itself.
