# wan22-templates — Become the Character

Phone-first dark UI for Casey Sims (Simzy): scroll template videos → pick one →
upload a still of yourself → Wan Animate puts you in that motion.

**Phone site:** https://swapr-casey.netlify.app (Generate uses Runpod)

**Vercel UI:** https://wan22-templates.vercel.app (synchronous Space proxy)

**Not** a LoRA trainer. No “upload 10–20 training videos” flow.

## Live backends

| Piece | URL |
|-------|-----|
| Phone UI (Netlify) | https://swapr-casey.netlify.app |
| Runpod endpoint | `zrmwpir4qzs66s` (`swapr-wan-animate`) — `https://api.runpod.ai/v2/zrmwpir4qzs66s` |
| Phone UI (Vercel) | https://wan22-templates.vercel.app |
| HF Space (Gradio API) | https://simzy-wan-2-2-templates.hf.space |
| Space repo | https://huggingface.co/spaces/Simzy/Wan-2.2-templates |
| Template dataset | https://huggingface.co/datasets/Simzy/wan22-template-clips |
| Catalog JSON (CDN) | https://huggingface.co/datasets/Simzy/wan22-template-clips/resolve/main/templates/catalog.json |

## Why Generate posts to `/api/generate`

iPhone Safari blocks the page from calling Hugging Face or Runpod directly.
`public/config.js` sets `USE_PROXY: true`, so **Generate, Extend, and
Auto-extend** POST to the same-origin route `/api/generate`. The API key stays
on the server. The phone never sees `RUNPOD_API_KEY` or `HF_TOKEN`.

On **swapr-casey**, Generate submits the still (`image_base64`) and the
selected template motion (`video_url`, a public Hugging Face dataset URL) to
the Runpod Wan Animate endpoint, then polls that job from the background
function. The mp4 comes back as base64. The site stores it and the phone plays
`/api/result?id=...` on the same origin, including `Range`.

`USE_PROXY` must stay **`true`**. `false` makes the phone UI call the Space
directly and Safari fails again.

Space files (Extend) are still rewritten to `/api/video?url=...`. Safari shows
a broken player when `<video>` loads the Space host directly. `/api/video`
streams those bytes and forwards `Range`.

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

Do not press Generate on the Vercel dev server while checking the UI. That path
still calls the Space and spends ZeroGPU. The Netlify phone site spends Runpod
credits instead.

## Deploy on Netlify

The phone site https://swapr-casey.netlify.app is this repo on Netlify (custom
site name, not the repo name). `netlify.toml` sends `/api/*` to
`netlify/functions/`.

Synchronous Netlify functions stop at **60 seconds**. That cap is not
configurable (there is no env var or `netlify.toml` timeout that raises it).
Background functions stop at **15 minutes**, also a platform cap.
Wan Animate usually takes longer than 60 seconds and sends no bytes on the
browser request while it runs, so the gateway answers with an HTML page
(`Inactivity Timeout` / “Too much time has passed without sending any data”).
Generate must not wait inside the synchronous function:

1. `POST /api/generate` reads the still and returns
   `{ job_id, phase: "queued" }` (HTTP 202) well inside the 60s limit.
   It does not call Runpod in this function.
2. It starts `generate-background` and only waits for the **202 headers**
   (8s cap). It does not read the worker body.
3. `netlify.toml` sets `[functions."generate-background"] background = true`
   (the `-background` filename does the same). That worker `POST`s `/run`,
   then polls `/status/{id}` until `COMPLETED`, `FAILED`, or 14 minutes.
   The worker scales to zero (`workersMin` 0), so the first Generate after
   idle includes a cold start and can take several minutes. The page says so.
4. On success the worker stores the mp4 and the page polls
   `GET /api/job?id=...` until `phase` is `done` or `error`. `done` includes
   `video: "/api/result?id=..."`, which the player loads same-origin.

A missing still is JSON **400**. Runpod failures are JSON with `phase: "error"`
and no video URL. Out of credits, a rejected API key, and a job that finishes
without a video each get a short sentence. An HTML gateway timeout is turned
into that same kind of sentence, never shown raw. The function must not exit 1.

Extend and Auto-extend still call the Hugging Face Space from the background
worker. They cannot continue a clip that Generate made on Runpod. Set
`HF_GENERATE_FALLBACK=true` only if Generate should use the Space when
`RUNPOD_API_KEY` and `RUNPOD_ENDPOINT_ID` are both absent. When those two are
set, Generate uses Runpod.

`URL` is set by Netlify and is how `/api/generate` starts the background
worker. Do not invent that value locally.

### Environment variables

Set these on the **swapr-casey** site (**Site configuration → Environment
variables**). Do not commit them. The Vercel project’s variables are not
copied here.

| Name | Required | Purpose |
|------|----------|---------|
| `RUNPOD_API_KEY` | Yes for Generate | Server-side only. `Authorization: Bearer` on `/run` and `/status`. Never put this in the frontend or in git. |
| `RUNPOD_ENDPOINT_ID` | Yes for Generate | `zrmwpir4qzs66s` (`swapr-wan-animate`). |
| `RUNPOD_ENDPOINT_URL` | No | Base URL. Default `https://api.runpod.ai/v2/$RUNPOD_ENDPOINT_ID`. Must be `https://api.runpod.ai/...`. |
| `HF_GENERATE_FALLBACK` | No | `true` sends Generate to the Space only when the Runpod key and endpoint id are absent. |
| `HF_TOKEN` | No | Server-side only. Used for Extend and `/api/video`, not the Runpod Generate path. |
| `HF_SPACE_URL` | No | Default `https://simzy-wan-2-2-templates.hf.space` |
| `URL` | Set by Netlify | Site origin used to invoke `generate-background`. |

These Runpod variables are already set on **swapr-casey**. Do not commit the key.

Also set Space secret `HF_TOKEN` on https://huggingface.co/spaces/Simzy/Wan-2.2-templates
(**Settings → Secrets**) so the Space can call upstream ZeroGPU with Pro quota.
That secret is separate from the Netlify variable.

### After this merges

GitHub does not publish the custom Netlify site by itself unless that site is
already linked to this repo. **Casey (or CoS) needs to clear the cache and
redeploy** so the published functions are this Generate path, not a stale bundle.

1. Merge to **`main`**.
2. In Netlify, open the **swapr-casey** site → **Deploys**.
3. **Trigger deploy → Clear cache and deploy site.** Do this even if a deploy
   from `main` starts on its own, so the new functions replace the cached ones.
4. There is no timeout field to raise. **Site configuration → Functions**
   cannot set a synchronous function above 60 seconds. After this deploy,
   **Functions** should list `generate-background` as a background function
   (15 minutes) plus synchronous `generate`, `job`, and `result`.
5. Confirm the new deploy is **Published**, and that `RUNPOD_API_KEY`,
   `RUNPOD_ENDPOINT_ID`, and `RUNPOD_ENDPOINT_URL` are still present. Do not
   copy the key into the repo.
6. On the phone, close the old tab and open https://swapr-casey.netlify.app
   again so it loads the new page. The first Generate may take several minutes
   while the Runpod worker starts.
7. Pushing `space/` is only required for Extend and the Space UI. Generate on
   swapr-casey does not call that Space.

Build settings from `netlify.toml`: command `npm run build`, publish `dist`.

## Product flow

1. Horizontal gallery of catalog clips. Visible and nearby videos autoplay **muted**, **looped**, and **playsInline** (iPhone Safari). Offscreen clips stay unloaded until you scroll near them.
2. Tap a template. The still upload stays locked until that pick, then the page focuses the upload card.
3. Dashed upload zone for a still photo.
4. **Generate** posts the still and the template `video_url` to same-origin `/api/generate`. On swapr-casey that becomes a Runpod `/run` (`image_base64`, `video_url`, 832×480, 16 fps, cfg 1, 6 steps, `mode: replace`). The page polls `/api/job` and plays `/api/result`.
5. Result player + download from that same-origin mp4.
6. Optional Extend / Auto-extend still go through `/api/generate` to the Space. They do not continue a Runpod clip.
7. **How to use & create templates** opens step-by-step instructions for both flows.

Templates are the real ~4s clips in `Simzy/wan22-template-clips` (`demo-wave`, `demo-dance`, `demo-victory`, `demo-walk`). Add a new one by putting `templates/<id>.mp4` in that dataset and appending an object to `templates/catalog.json` (about 3–5 seconds, stable id, license in `source`). Then Refresh. This is not a LoRA training upload.

## Hugging Face Space

The live Space (https://huggingface.co/spaces/Simzy/Wan-2.2-templates) is **HF-git only**. It is not deployed from this GitHub repo automatically. `space/app.py` here matches that proxy app, plus the gallery and how-to panel. API routes are unchanged: `/generate`, `/extend`, `/auto_extend`, `/reset`, `/list_templates`.

Generate on the Space resizes the still to the Animate frame (multiples of 16,
at least 320px) and anchors the prompt to that reference photo. If upstream
returns color noise, a near-black clip, or a file that cannot be read,
`space/clip_quality.py` raises an error **before** that file is saved as the
result. The phone then shows that error from `/api/job` instead of playing
the junk mp4.

To update what Casey can open today, push this repo’s `space/` folder to the HF Space repo:

```bash
git clone https://huggingface.co/spaces/Simzy/Wan-2.2-templates hf-space
cp space/app.py space/clip_quality.py space/requirements.txt space/README.md hf-space/
cd hf-space && git add app.py clip_quality.py requirements.txt README.md && git commit -m "Reject degenerate Wan clips instead of returning them" && git push
```

Use a Hugging Face write token. Do not click Generate on the Space while checking the UI — that spends ZeroGPU.

## Related

- Extend restore snapshot: `/workspace/My Saved Apps/extend-current-20260923/`
- Live Extend Space (untouched main): https://huggingface.co/spaces/Simzy/wan22-extend
