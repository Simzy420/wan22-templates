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

1. Horizontal rail of short template cards (muted autoplay on hover).
2. Selected template detail.
3. Dashed upload zone for a still photo.
4. **Generate** → Space `/generate` (animate).
5. Result player + download.
6. Optional Extend / Auto-extend.

Demo templates in the dataset are **placeholders** (solid color + title). Replace
them in `Simzy/wan22-template-clips` when real driving videos are ready.

## Related

- Extend restore snapshot: `/workspace/My Saved Apps/extend-current-20260923/`
- Live Extend Space (untouched main): https://huggingface.co/spaces/Simzy/wan22-extend
