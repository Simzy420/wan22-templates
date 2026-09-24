# wan22-templates — Become the Character

Phone-first dark UI for Casey Sims (Simzy): scroll template videos → pick one →
upload a still of yourself → call the Hugging Face Space to animate you into
that template.

**Live site:** https://wan22-templates.vercel.app

**Not** a LoRA trainer. No “upload 10–20 training videos” flow.

## Live backends

| Piece | URL |
|-------|-----|
| Phone UI (Vercel) | https://wan22-templates.vercel.app |
| HF Space (Gradio API) | https://simzy-wan-2-2-templates.hf.space |
| Space repo | https://huggingface.co/spaces/Simzy/Wan-2.2-templates |
| Template dataset | https://huggingface.co/datasets/Simzy/wan22-template-clips |
| Catalog JSON (CDN) | https://huggingface.co/datasets/Simzy/wan22-template-clips/resolve/main/templates/catalog.json |

## Why Generate posts to `/api/generate`

iPhone Safari blocks the page from calling the Hugging Face Space with
`@gradio/client` (`TypeError: Load failed`). `public/config.js` sets
`USE_PROXY: true`, so **Generate, Extend, and Auto-extend** POST to the
same-origin route `/api/generate`. That route runs `@gradio/client` on the
server.

`USE_PROXY` must stay **`true`** for browser CORS. `false` makes the phone UI
call `https://simzy-wan-2-2-templates.hf.space` directly and Safari fails again.

The result file still lives on the Space. Safari often shows a broken player
(duration 00:00, blurry frames) when `<video>` loads that host directly.
`/api/generate` rewrites `video` and `url` to same-origin
`/api/video?url=...`, and the page does the same rewrite if a Space URL
slips through. `/api/video` streams the bytes and forwards `Range`.

After this deploys, hard-close the phone tab, open the site again, then
Generate. Do not keep the old tab.

## Deploy on Vercel

Production is the Vercel project **`wan22-templates`**, linked to GitHub
**`Simzy420/wan22-templates`**. The homepage is
https://wan22-templates.vercel.app.

1. Merge this change to **`main`**. If the Git integration is still linked,
   Vercel redeploys production on its own.
2. Wait until that deployment is **Ready**.
3. On the phone, close the tab and open https://wan22-templates.vercel.app
   again so it loads the new `config.js` (`USE_PROXY: true`).
4. Generate should POST to `https://wan22-templates.vercel.app/api/generate`.
   The browser should not call the Space. In the network panel that request is
   same-origin.

`api/generate.js` is the Vercel Function. `vercel.json` sets its max duration
to **300 seconds** (the Hobby Fluid limit). A single Generate usually fits in
that window. A long Auto-extend can still time out. On Pro, raise
`functions["api/generate.js"].maxDuration` (up to 800) and redeploy.

Vercel request bodies are about **4.5 MB**. The UI shrinks stills larger than
3.5 MB before upload.

### Environment variables

Set these in the Vercel project (**Settings → Environment Variables**). Do not
commit them.

| Name | Required | Purpose |
|------|----------|---------|
| `HF_SPACE_URL` | No | Space the proxy calls. Default `https://simzy-wan-2-2-templates.hf.space` |
| `HF_TOKEN` | No | Hugging Face token, read only on the server. Recommended so ZeroGPU uses your quota. |

Nothing else is required for the proxy. The public page reads `public/config.js`,
not these variables.

## Local dev

```bash
npm install
npm test
npm run dev
```

`npm run dev` mounts the same `/api/generate` handler as Vercel. Optional:

```bash
export HF_SPACE_URL=https://simzy-wan-2-2-templates.hf.space
export HF_TOKEN=   # server-side only; leave unset to call the Space anonymously
```

`VITE_HF_SPACE` is only used when `USE_PROXY` is false.

Do not press Generate while checking the UI. That spends ZeroGPU.

## Deploy on Netlify

The Netlify function is still there and uses the same proxy code
(`server/gradioProxy.js`). `netlify.toml` sends `/api/*` to
`netlify/functions/generate.js`.

1. In Netlify: **Add new site → Import an existing project → GitHub**.
2. Select repo **`Simzy420/wan22-templates`**.
3. Build settings (usually auto-detected from `netlify.toml`):
   - Build command: `npm run build`
   - Publish directory: `dist`
4. Site env vars:
   - `HF_SPACE_URL` = `https://simzy-wan-2-2-templates.hf.space`
   - `HF_TOKEN` = your HF token (optional, server-side only)
5. Deploy. Keep `USE_PROXY: true` in `public/config.js`.

## Product flow

1. Horizontal gallery of catalog clips. Visible and nearby videos autoplay **muted**, **looped**, and **playsInline** (iPhone Safari). Offscreen clips stay unloaded until you scroll near them.
2. Tap a template. The still upload stays locked until that pick, then the page focuses the upload card.
3. Dashed upload zone for a still photo.
4. **Generate** → Space `/generate` (animate). Same arguments as before, including `session_id`. With `USE_PROXY: true` the browser posts that payload to `/api/generate`.
5. Result player + download. The proxy response includes `session_id` for the next step.
6. Optional Extend / Auto-extend (`/extend`, `/auto_extend`) through the same `/api/generate` route when `USE_PROXY` is true.
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
