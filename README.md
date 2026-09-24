# wan22-templates — Become the Character (Netlify UI)

Phone-first dark UI for Casey Sims (Simzy): scroll template videos → pick one →
upload a still of yourself → call the Hugging Face Space to animate you into
that template.

**Not** a LoRA trainer. No “upload 10–20 training videos” flow.

## Live backends

| Piece | URL |
|-------|-----|
| HF Space (Gradio API) | https://simzy-wan-2-2-templates.hf.space |
| Space repo | https://huggingface.co/spaces/Simzy/Wan-2.2-templates |
| Template dataset | https://huggingface.co/datasets/Simzy/wan22-template-clips |
| Catalog JSON (CDN) | https://huggingface.co/datasets/Simzy/wan22-template-clips/resolve/main/templates/catalog.json |

## Local dev

```bash
npm install
npm run dev
```

Optional env:

```bash
export VITE_HF_SPACE=https://simzy-wan-2-2-templates.hf.space
```

Or edit `public/config.js`.

## Deploy on Netlify

1. In Netlify: **Add new site → Import an existing project → GitHub**.
2. Select repo **`Simzy420/wan22-templates`**.
3. Build settings (usually auto-detected from `netlify.toml`):
   - Build command: `npm run build`
   - Publish directory: `dist`
4. (Optional) Site env vars:
   - `VITE_HF_SPACE` = `https://simzy-wan-2-2-templates.hf.space`
   - `HF_TOKEN` = your HF token (only needed if you enable the Netlify Function proxy)
   - `HF_SPACE_URL` = same as Space URL (for the proxy)
5. Deploy. No paid Netlify plan required for this static site.

### CORS

The UI prefers **`@gradio/client`** calling the Space directly from the browser.
If the Space blocks CORS, set in `public/config.js`:

```js
USE_PROXY: true
```

That routes generate through `netlify/functions/generate.js`. You may need to
`npm install busboy` (or rely on JSON-only proxy mode) and set `HF_TOKEN` in
Netlify env.

## Product flow

1. Horizontal gallery of catalog clips. Visible and nearby videos autoplay **muted**, **looped**, and **playsInline** (iPhone Safari). Offscreen clips stay unloaded until you scroll near them.
2. Tap a template. The still upload stays locked until that pick, then the page focuses the upload card.
3. Dashed upload zone for a still photo.
4. **Generate** → Space `/generate` (animate). Same arguments as before, including `session_id`.
5. Result player + download.
6. Optional Extend / Auto-extend (`/extend`, `/auto_extend`).
7. **How to use & create templates** opens step-by-step instructions for both flows.

Templates are the real ~4s clips in `Simzy/wan22-template-clips` (`demo-wave`, `demo-dance`, `demo-victory`, `demo-walk`). Add a new one by putting `templates/<id>.mp4` in that dataset and appending an object to `templates/catalog.json` (about 3–5 seconds, stable id, license in `source`). Then Refresh. This is not a LoRA training upload.

## Hugging Face Space

The live Space (https://huggingface.co/spaces/Simzy/Wan-2.2-templates) is **HF-git only**. It is not deployed from this GitHub repo automatically. `space/app.py` here matches that proxy app, plus the gallery and how-to panel. API routes are unchanged: `/generate`, `/extend`, `/auto_extend`, `/reset`, `/list_templates`.

To update what Casey can open today, push this repo’s `space/` folder to the HF Space repo:

```bash
git clone https://huggingface.co/spaces/Simzy/Wan-2.2-templates hf-space
cp space/app.py space/requirements.txt space/README.md hf-space/
cd hf-space && git add app.py requirements.txt README.md && git commit -m "Autoplay gallery and how-to" && git push
```

Use a Hugging Face write token. Do not click Generate on the Space while checking the UI — that spends ZeroGPU.

## Related

- Extend restore snapshot: `/workspace/My Saved Apps/extend-current-20260923/`
- Live Extend Space (untouched main): https://huggingface.co/spaces/Simzy/wan22-extend
