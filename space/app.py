"""
Wan 2.2 Templates — Become the Character.

Proxy Space: does NOT load 14B weights. Calls upstream Gradio Spaces via
gradio_client, then stitches with ffmpeg when extending.

Upstream:
  Animate: hugging-apps/wan2-2-animate-2-14b  /animate
  Extend:  kulkas2pintu/wan222                /generate_video
Templates: dataset Simzy/wan22-template-clips
"""

from __future__ import annotations

import html
import json
import os
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

import cv2
import gradio as gr
import numpy as np
from gradio_client import Client, handle_file
from huggingface_hub import hf_hub_download, list_repo_files
from PIL import Image, ImageOps

ANIMATE_SPACE = os.environ.get(
    "WAN_ANIMATE_SPACE", "hugging-apps/wan2-2-animate-2-14b"
)
ANIMATE_API = "animate"

EXTEND_SPACE = os.environ.get("WAN_UPSTREAM_SPACE", "kulkas2pintu/wan222")
EXTEND_API = "generate_video"

TEMPLATE_DATASET = os.environ.get(
    "WAN_TEMPLATE_DATASET", "Simzy/wan22-template-clips"
)
CATALOG_PATH = "templates/catalog.json"

DEFAULT_PROMPT = "a person, natural motion, cinematic, high quality"
DEFAULT_NEGATIVE = (
    "色调艳丽, 过曝, 静态, 细节模糊不清, 字幕, 风格, 作品, 画作, 画面, 静止, "
    "整体发灰, 最差质量, 低质量, JPEG压缩残留, 丑陋的, 残缺的, 多余的手指, "
    "画得不好的手部, 画得不好的脸部, 畸形的, 毁容的, 形态畸形的肢体, 手指融合, "
    "静止不动的画面, 杂乱的背景, 三条腿, 背景人很多, 倒着走"
)

WORK = Path(tempfile.gettempdir()) / "wan22_templates"
WORK.mkdir(parents=True, exist_ok=True)

# Server-side sessions so /extend works over Gradio API (State is not API-exposed).
_SESSIONS: dict[str, dict] = {}


def _save_session(state: dict) -> str:
    sid = state.get("session_id") or uuid.uuid4().hex
    state["session_id"] = sid
    _SESSIONS[sid] = dict(state)
    return sid


def _load_session(session_id: str | None, state: dict | None) -> dict:
    if state and state.get("video"):
        return state
    if session_id and session_id in _SESSIONS:
        return dict(_SESSIONS[session_id])
    return state or {}


_animate_client: Client | None = None
_extend_client: Client | None = None
_catalog_cache: list[dict] | None = None
_catalog_mtime: float = 0.0


def _hf_token() -> str | None:
    return os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")


def _client_kwargs(headers: dict[str, str] | None = None) -> dict[str, Any]:
    token = _hf_token()
    kwargs: dict[str, Any] = {}
    if token:
        # gradio_client versions differ: prefer token=, fall back to hf_token=
        kwargs["token"] = token
    if headers:
        kwargs["headers"] = headers
    return kwargs


def _visitor_headers(request: gr.Request | None) -> dict[str, str]:
    """Forward browser visitor ZeroGPU identity (x-ip-token) to upstream Spaces."""
    if request is None:
        return {}
    try:
        headers = getattr(request, "headers", None) or {}
        token = headers.get("x-ip-token") or headers.get("X-IP-Token") or ""
    except Exception:
        token = ""
    if not token:
        return {}
    return {"x-ip-token": token}


def _make_client(space: str, request: gr.Request | None = None) -> Client:
    hdrs = _visitor_headers(request)
    try:
        return Client(space, **_client_kwargs(hdrs or None))
    except TypeError:
        kw: dict[str, Any] = {}
        tok = _hf_token()
        if tok:
            kw["hf_token"] = tok
        if hdrs:
            kw["headers"] = hdrs
        return Client(space, **kw)


def get_animate_client(request: gr.Request | None = None) -> Client:
    """Prefer a per-call client when visitor x-ip-token is present (own Pro quota)."""
    global _animate_client
    hdrs = _visitor_headers(request)
    if hdrs:
        return _make_client(ANIMATE_SPACE, request)
    if _animate_client is None:
        _animate_client = _make_client(ANIMATE_SPACE, None)
    return _animate_client


def get_extend_client(request: gr.Request | None = None) -> Client:
    global _extend_client
    hdrs = _visitor_headers(request)
    if hdrs:
        return _make_client(EXTEND_SPACE, request)
    if _extend_client is None:
        _extend_client = _make_client(EXTEND_SPACE, None)
    return _extend_client


_RATE_LIMIT_HINT = (
    "ZeroGPU rate limit / quota / queue busy. "
    "Wait 10–15 minutes, then try Generate once — do not spam retries "
    "(each attempt burns GPU quota). HF Pro helps; Space secret HF_TOKEN "
    "plus your browser login (x-ip-token) identity the request."
)


def _friendly_upstream_error(exc: BaseException, action: str) -> str:
    msg = str(exc) or repr(exc)
    low = msg.lower()
    rate_markers = (
        "429",
        "too many request",
        "too many attempts",
        "rate limit",
        "rate-limit",
        "quota",
        "gpu quota",
        "queue full",
        "queue timeout",
        "timed out",
        "timeout",
        "failed too many",
        "zerogpu",
        "cuda",
        "no hardware",
        "capacity",
    )
    if any(m in low for m in rate_markers):
        return f"{action} blocked: {_RATE_LIMIT_HINT}\n\nDetails: {msg[:500]}"
    return f"{action} failed: {msg[:800]}"


def _session_dir() -> Path:
    d = WORK / uuid.uuid4().hex[:12]
    d.mkdir(parents=True, exist_ok=True)
    return d


def _as_image_source(img, _depth: int = 0):
    if img is None or _depth > 4:
        return img
    if isinstance(img, dict):
        inner = img.get("path") or img.get("name") or img.get("image") or img.get("url")
        return _as_image_source(inner, _depth + 1)
    if isinstance(img, (list, tuple)) and img:
        return _as_image_source(img[0], _depth + 1)
    return img


def load_pil_image(img: Image.Image | np.ndarray | str | Path | dict | None) -> Image.Image | None:
    img = _as_image_source(img)
    if img is None:
        return None
    if isinstance(img, Image.Image):
        pil = img
    elif isinstance(img, np.ndarray):
        arr = img
        if arr.ndim == 2:
            arr = np.stack([arr, arr, arr], axis=-1)
        if arr.shape[-1] == 4:
            arr = arr[..., :3]
        pil = Image.fromarray(arr.astype("uint8"))
    elif isinstance(img, (str, Path)):
        src = Path(img)
        if not src.exists() or not src.is_file():
            return None
        try:
            with Image.open(src) as opened:
                pil = opened.copy()
        except Exception:
            return None
    else:
        return None
    try:
        pil = ImageOps.exif_transpose(pil)
    except Exception:
        pass
    return pil.convert("RGB")


def save_image(img, dest: Path) -> Path | None:
    pil = load_pil_image(img)
    if pil is None:
        return None
    out = dest.with_suffix(".png")
    pil.save(out)
    return out


def _even(n: int) -> int:
    n = int(n)
    if n < 2:
        return 2
    return n - (n % 2)


def probe_video_size(video_path: str | Path) -> tuple[int, int]:
    video_path = str(video_path)
    try:
        out = subprocess.check_output(
            [
                "ffprobe", "-v", "error", "-select_streams", "v:0",
                "-show_entries", "stream=width,height",
                "-of", "csv=p=0:s=x", video_path,
            ],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
        w_s, h_s = out.split("x", 1)
        w, h = _even(int(w_s)), _even(int(h_s))
        if w >= 2 and h >= 2:
            return w, h
    except Exception:
        pass
    cap = cv2.VideoCapture(video_path)
    w = _even(int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0))
    h = _even(int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0))
    cap.release()
    if w < 2 or h < 2:
        raise RuntimeError(f"Could not read video size: {video_path}")
    return w, h


def cover_resize(image: Image.Image, width: int, height: int) -> Image.Image:
    width, height = _even(width), _even(height)
    image = image.convert("RGB")
    src_w, src_h = image.size
    if src_w < 1 or src_h < 1:
        raise ValueError("Image has no pixels.")
    if src_w == width and src_h == height:
        return image
    scale = max(width / src_w, height / src_h)
    new_w = max(1, int(round(src_w * scale)))
    new_h = max(1, int(round(src_h * scale)))
    resized = image.resize((new_w, new_h), Image.Resampling.LANCZOS)
    left = max(0, (new_w - width) // 2)
    top = max(0, (new_h - height) // 2)
    cropped = resized.crop((left, top, left + width, top + height))
    if cropped.size != (width, height):
        cropped = cropped.resize((width, height), Image.Resampling.LANCZOS)
    return cropped


def extract_last_frame(video_path: str | Path, out_path: Path) -> Path:
    video_path = str(video_path)
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"Could not open video: {video_path}")
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    frame = None
    if total > 0:
        cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, total - 1))
        ok, frame = cap.read()
        if not ok or frame is None:
            cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
            while True:
                ok, f = cap.read()
                if not ok:
                    break
                frame = f
    else:
        while True:
            ok, f = cap.read()
            if not ok:
                break
            frame = f
    cap.release()
    if frame is None:
        raise RuntimeError("No frames found in video.")
    out_path = out_path.with_suffix(".png")
    cv2.imwrite(str(out_path), frame)
    return out_path


def video_duration_seconds(video_path: str | Path) -> float:
    video_path = str(video_path)
    try:
        out = subprocess.check_output(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                video_path,
            ],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
        return float(out)
    except Exception:
        cap = cv2.VideoCapture(video_path)
        fps = cap.get(cv2.CAP_PROP_FPS) or 16.0
        frames = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
        cap.release()
        if fps > 0 and frames > 0:
            return frames / fps
        return 0.0


OUTPUT_FPS = 16


def concat_videos(paths: list[Path], out_path: Path) -> Path:
    if not paths:
        raise RuntimeError("No videos to concatenate.")
    if len(paths) == 1:
        shutil.copy2(paths[0], out_path)
        return out_path
    width, height = probe_video_size(paths[0])
    fps = OUTPUT_FPS
    crop_w = f"if(lt(iw\\,{width})\\,iw\\,{width})"
    crop_h = f"if(lt(ih\\,{height})\\,ih\\,{height})"
    vf = (
        f"scale={width}:{height}:force_original_aspect_ratio=increase,"
        f"crop=w={crop_w}:h={crop_h},"
        f"scale={width}:{height},"
        f"setsar=1,fps={fps},format=yuv420p"
    )
    list_file = out_path.parent / "concat_list.txt"
    normalized: list[Path] = []
    for i, p in enumerate(paths):
        norm = out_path.parent / f"norm_{i:03d}.mp4"
        subprocess.run(
            [
                "ffmpeg", "-y", "-i", str(p),
                "-vf", vf, "-c:v", "libx264", "-pix_fmt", "yuv420p",
                "-an", "-vsync", "cfr", "-r", str(fps), str(norm),
            ],
            check=True,
            capture_output=True,
        )
        normalized.append(norm)
    with list_file.open("w") as f:
        for p in normalized:
            escaped = str(p.resolve()).replace("'", r"'\''")
            f.write(f"file '{escaped}'\n")
    subprocess.run(
        [
            "ffmpeg", "-y", "-f", "concat", "-safe", "0",
            "-i", str(list_file), "-c", "copy",
            "-movflags", "+faststart", str(out_path),
        ],
        check=True,
        capture_output=True,
    )
    return out_path


# ---------------------------------------------------------------------------
# Templates from Hub dataset
# ---------------------------------------------------------------------------

def _cdn_url(rel_path: str) -> str:
    return (
        f"https://huggingface.co/datasets/{TEMPLATE_DATASET}/resolve/main/{rel_path}"
    )


def load_catalog(force: bool = False) -> list[dict]:
    """Download catalog.json from Hub and return list of template dicts."""
    global _catalog_cache, _catalog_mtime
    try:
        path = hf_hub_download(
            repo_id=TEMPLATE_DATASET,
            filename=CATALOG_PATH,
            repo_type="dataset",
            token=_hf_token(),
            force_download=force,
        )
        mtime = Path(path).stat().st_mtime
        if (
            not force
            and _catalog_cache is not None
            and mtime == _catalog_mtime
        ):
            return _catalog_cache
        with open(path) as f:
            data = json.load(f)
        if not isinstance(data, list):
            raise ValueError("catalog.json must be a JSON array")
        for item in data:
            vp = item.get("video_path") or item.get("video") or ""
            item["video_path"] = vp
            item["video_url"] = _cdn_url(vp) if vp else ""
            item["label"] = f"{item.get('title', item.get('id', '?'))}  ·  {item.get('duration_s', '?')}s"
        _catalog_cache = data
        _catalog_mtime = mtime
        return data
    except Exception as e:
        if _catalog_cache is not None:
            return _catalog_cache
        raise RuntimeError(f"Could not load templates from {TEMPLATE_DATASET}: {e}") from e


def download_template_video(template_id: str, dest_dir: Path) -> Path:
    catalog = load_catalog()
    item = next((t for t in catalog if t.get("id") == template_id), None)
    if item is None:
        raise gr.Error(f"Unknown template id: {template_id}")
    rel = item["video_path"]
    local = hf_hub_download(
        repo_id=TEMPLATE_DATASET,
        filename=rel,
        repo_type="dataset",
        token=_hf_token(),
    )
    dest = dest_dir / Path(rel).name
    shutil.copy2(local, dest)
    return dest


def list_templates_api(force_refresh: bool = True):
    """API: /list_templates — return catalog JSON string + dropdown choices."""
    catalog = load_catalog(force=bool(force_refresh))
    choices = [t["label"] for t in catalog]
    ids = [t["id"] for t in catalog]
    # Gradio Dropdown often wants (label, value) pairs
    dropdown_choices = list(zip(choices, ids))
    return json.dumps(catalog, indent=2), gr.update(choices=dropdown_choices, value=ids[0] if ids else None)


def template_preview(template_id: str):
    if not template_id:
        return None, "Select a template."
    catalog = load_catalog()
    item = next((t for t in catalog if t.get("id") == template_id), None)
    if not item:
        return None, f"Unknown template: {template_id}"
    md = (
        f"### {item.get('title', template_id)}\n"
        f"{item.get('description', '')}\n\n"
        f"**Duration:** ~{item.get('duration_s', '?')}s  ·  "
        f"**Category:** {item.get('category', '—')}  ·  "
        f"**Tags:** {', '.join(item.get('tags') or [])}\n\n"
        f"`{item.get('video_path')}`"
    )
    # Prefer CDN URL for preview (Gradio Video accepts URL)
    return item.get("video_url") or None, md


# ---------------------------------------------------------------------------
# Upstream calls
# ---------------------------------------------------------------------------

def _resolve_video_ref(result) -> str:
    video_ref = result[0] if isinstance(result, (list, tuple)) else result
    if isinstance(video_ref, dict):
        video_path = video_ref.get("video") or video_ref.get("path") or video_ref.get("url")
        if isinstance(video_path, dict):
            video_path = video_path.get("path") or video_path.get("url")
    else:
        video_path = video_ref
    if not video_path or not Path(str(video_path)).exists():
        raise RuntimeError(
            f"Upstream did not return a local video path. Got: {type(result)} {str(result)[:300]}"
        )
    return str(video_path)


def call_animate(
    image_path: Path,
    driving_video: Path,
    prompt: str,
    max_seconds: float,
    height: int,
    width: int,
    steps: int,
    guidance: float,
    sample_shift: float,
    negative: str,
    seed: int,
    progress: gr.Progress | None = None,
    request: gr.Request | None = None,
) -> Path:
    client = get_animate_client(request)
    if progress:
        progress(0.15, desc=f"Calling {ANIMATE_SPACE} /animate (ZeroGPU)…")
    result = client.predict(
        handle_file(str(image_path)),
        handle_file(str(driving_video)),
        prompt or DEFAULT_PROMPT,
        float(max_seconds),
        int(height),
        int(width),
        int(steps),
        float(guidance),
        float(sample_shift),
        negative or DEFAULT_NEGATIVE,
        int(seed),
        api_name=f"/{ANIMATE_API}",
    )
    video_path = _resolve_video_ref(result)
    dest = image_path.parent / f"anim_{uuid.uuid4().hex[:8]}.mp4"
    shutil.copy2(video_path, dest)
    return dest


def call_wan_i2v(
    image_path: Path,
    prompt: str,
    duration: float,
    steps: int,
    negative: str,
    seed: int,
    randomize: bool,
    quality: int,
    fps: int,
    safe_mode: bool,
    progress: gr.Progress | None = None,
    request: gr.Request | None = None,
) -> Path:
    client = get_extend_client(request)
    if progress:
        progress(0.15, desc=f"Calling {EXTEND_SPACE} /generate_video (ZeroGPU)…")
    result = client.predict(
        handle_file(str(image_path)),
        None,
        prompt or DEFAULT_PROMPT,
        int(steps),
        negative or DEFAULT_NEGATIVE,
        float(duration),
        1.0,
        1.0,
        int(seed),
        bool(randomize),
        int(quality),
        "UniPCMultistep",
        3.0,
        int(fps),
        True,
        bool(safe_mode),
        api_name=f"/{EXTEND_API}",
    )
    video_path = _resolve_video_ref(result)
    dest = image_path.parent / f"seg_{uuid.uuid4().hex[:8]}.mp4"
    shutil.copy2(video_path, dest)
    return dest


def status_line(segments: list[str], duration_est: float) -> str:
    n = len(segments)
    # HF_TOKEN / HUGGING_FACE_HUB_TOKEN is the Space secret (Pro quota when eligible).
    if _hf_token():
        quota = "ZeroGPU — authenticated (HF Pro quota when eligible)"
    else:
        quota = "ZeroGPU — public queue (set Space secret HF_TOKEN for Pro quota)"
    return (
        f"**Segments:** {n}  ·  **Duration ≈ {duration_est:.1f}s**  ·  "
        f"Animate: `{ANIMATE_SPACE}` · Extend: `{EXTEND_SPACE}` "
        f"({quota})"
    )


# ---------------------------------------------------------------------------
# Generate / Extend / Reset
# ---------------------------------------------------------------------------

def do_generate(
    template_id,
    image,
    prompt,
    max_seconds,
    height,
    width,
    steps,
    guidance,
    sample_shift,
    negative,
    seed,
    session_id: str = "",
    state: dict | None = None,
    request: gr.Request | None = None,
    progress=gr.Progress(track_tqdm=False),
):
    if not template_id:
        raise gr.Error("Pick a template first.")
    if image is None:
        raise gr.Error("Upload a still photo of yourself (the star).")

    state = _load_session(session_id or None, state)
    sess = Path(state.get("dir") or str(_session_dir()))
    sess.mkdir(parents=True, exist_ok=True)
    state["dir"] = str(sess)

    img_path = save_image(image, sess / "input")
    if img_path is None:
        raise gr.Error("Could not read the uploaded photo.")

    progress(0.05, desc="Downloading template…")
    driving = download_template_video(str(template_id), sess)

    # Cap driving seconds — demos are ~4s; keep default low to spare ZeroGPU.
    max_seconds = min(float(max_seconds or 3.0), 5.0)

    progress(0.1, desc="Animating (become the character)…")
    try:
        clip = call_animate(
            img_path,
            driving,
            prompt or DEFAULT_PROMPT,
            max_seconds,
            int(height),
            int(width),
            int(steps),
            float(guidance),
            float(sample_shift),
            negative or DEFAULT_NEGATIVE,
            int(seed),
            progress,
            request=request,
        )
    except Exception as e:
        raise gr.Error(_friendly_upstream_error(e, "Animate")) from e

    out = sess / "current.mp4"
    shutil.copy2(clip, out)
    last = extract_last_frame(out, sess / "last_frame")
    dur = video_duration_seconds(out)
    state["segments"] = [str(clip)]
    state["video"] = str(out)
    state["last_frame"] = str(last)
    state["prompt"] = prompt or DEFAULT_PROMPT
    state["template_id"] = str(template_id)
    sid = _save_session(state)
    progress(1.0, desc="Done")
    return (
        str(out),
        str(out),
        status_line(state["segments"], dur) + f"  ·  session `{sid}`",
        str(last),
        sid,
        state,
    )


def do_extend(
    prompt,
    seg_duration,
    steps,
    negative,
    seed,
    randomize,
    quality,
    fps,
    safe_mode,
    session_id: str = "",
    state: dict | None = None,
    request: gr.Request | None = None,
    progress=gr.Progress(track_tqdm=False),
):
    state = _load_session(session_id or None, state)
    if not state or not state.get("video"):
        raise gr.Error("Generate a clip first, then use Extend. Pass session_id from Generate.")
    if len(state.get("segments", [])) >= 6:
        raise gr.Error("Segment cap reached (6). Reset and start a new run.")

    sess = Path(state["dir"])
    last = Path(state["last_frame"]) if state.get("last_frame") else None
    if last is None or not last.exists():
        last = extract_last_frame(state["video"], sess / "last_frame")
        state["last_frame"] = str(last)

    use_prompt = (prompt or "").strip() or state.get("prompt") or DEFAULT_PROMPT
    progress(0.05, desc="Extending from last frame…")
    try:
        clip = call_wan_i2v(
            last,
            use_prompt,
            float(seg_duration),
            int(steps),
            negative or DEFAULT_NEGATIVE,
            int(seed),
            bool(randomize),
            int(quality),
            int(fps),
            bool(safe_mode),
            progress,
            request=request,
        )
    except Exception as e:
        raise gr.Error(_friendly_upstream_error(e, "Extend")) from e

    segs = [Path(p) for p in state["segments"]] + [clip]
    out = sess / f"current_{len(segs)}.mp4"
    try:
        concat_videos(segs, out)
    except Exception as e:
        raise gr.Error(f"Concat failed (ffmpeg): {e}") from e

    last = extract_last_frame(out, sess / "last_frame")
    dur = video_duration_seconds(out)
    state["segments"] = [str(p) for p in segs]
    state["video"] = str(out)
    state["last_frame"] = str(last)
    state["prompt"] = use_prompt
    sid = _save_session(state)
    progress(1.0, desc="Extended")
    return (
        str(out),
        str(out),
        status_line(state["segments"], dur) + f"  ·  session `{sid}`",
        str(last),
        sid,
        state,
    )


def do_auto_extend(
    target_seconds,
    prompt,
    seg_duration,
    steps,
    negative,
    seed,
    randomize,
    quality,
    fps,
    safe_mode,
    session_id: str = "",
    state: dict | None = None,
    request: gr.Request | None = None,
    progress=gr.Progress(track_tqdm=False),
):
    state = _load_session(session_id or None, state)
    if not state or not state.get("video"):
        raise gr.Error("Generate a first clip, then Auto-extend. Pass session_id from Generate.")
    target = float(target_seconds)
    max_segs = 6
    video = state.get("video")
    download = video
    status = status_line(state.get("segments", []), video_duration_seconds(state["video"]))
    last_preview = state.get("last_frame")
    while len(state.get("segments", [])) < max_segs:
        dur = video_duration_seconds(state["video"])
        if dur >= target:
            break
        progress(
            len(state["segments"]) / max_segs,
            desc=f"Auto-extend: {dur:.1f}s / {target:.0f}s…",
        )
        video, download, status, last_preview, sid, state = do_extend(
            prompt, seg_duration, steps, negative, seed,
            randomize, quality, fps, safe_mode, state.get("session_id", ""), state,
            request, progress,
        )
        time.sleep(0.3)
    sid = _save_session(state)
    return video, download, status, last_preview, sid, state


def do_reset(session_id: str = "", state: dict | None = None):
    state = _load_session(session_id or None, state)
    if state and state.get("dir"):
        try:
            shutil.rmtree(state["dir"], ignore_errors=True)
        except Exception:
            pass
    if state and state.get("session_id"):
        _SESSIONS.pop(state["session_id"], None)
    if session_id:
        _SESSIONS.pop(session_id, None)
    return None, None, "**Segments:** 0  ·  **Duration ≈ 0s**", None, "", {}


# ---------------------------------------------------------------------------
# UI — scrollable autoplay gallery + how-to. API routes are unchanged:
# /generate /extend /auto_extend /reset /list_templates
# ---------------------------------------------------------------------------

HOWTO_MD = """
## Use a template

1. **Scroll the gallery.** Every template clip autoplays muted, looped, and inline (including iPhone Safari). These are the real driving videos from the catalog.
2. **Tap Select this motion** on the clip you want. Nothing is generated yet.
3. **Upload a still** of the person who should become the character (JPG or PNG, face or full body). The upload stays locked until a template is selected.
4. Optionally edit the prompt or open **Animate settings**.
5. Tap **Generate — become the character**. Wan Animate runs on ZeroGPU. When the queue is busy this often takes 1–3+ minutes. You get a short clip of that person in the template motion.
6. Optionally **Extend** once, or **Auto-extend** toward a target length. Stay in this same browser session so the session id is kept. Extend chains from the last frame (same pattern as wan22-extend).
7. If you see a rate limit, 429, or “failed too many attempts”: wait 10–15 minutes and press Generate **once**. Do not retry in a loop — each attempt uses ZeroGPU quota.

## Create a new template

A template is **one short real person-motion driving clip**. This app is not a LoRA trainer and does not take a folder of training videos.

1. **Length:** about **3–5 seconds**. The clips in the catalog today (`demo-wave`, `demo-dance`, `demo-victory`, `demo-walk`) are **4.0s**. Generate uses at most **5 seconds** of the driving video (default **3s**) to spare ZeroGPU quota.
2. **Picture:** one person, motion that reads clearly (wave, dance, walk, gesture). MP4, H.264. Prefer a stable camera and a readable face or full body.
3. **Id:** lowercase, hyphens, stable once published, for example `demo-wave`. Do not reuse an existing id unless you mean to replace that motion.
4. **Add it to the dataset** [Simzy/wan22-template-clips](https://huggingface.co/datasets/Simzy/wan22-template-clips) on branch `main`:
   - File path: `templates/<id>.mp4`
   - Append one object to `templates/catalog.json` (a JSON array). Fields:
     - `id` — same stem as the filename
     - `title` — short label shown on the card
     - `description` — what the motion is
     - `video_path` — `templates/<id>.mp4`
     - `duration_s` — length in seconds (number)
     - `tags` — list of short strings
     - `category` — for example `greeting`, `dance`, `pose`, `locomotion`
     - `thumbnail` — `null`, or a path if you add one
     - `source` — credit and license (Mixkit Stock Video Free License, Apache-2.0, or your own)
5. Keep existing ids (`demo-wave`, `demo-dance`, `demo-victory`, `demo-walk`) unless you intend to change those motions. Add a new id beside them.
6. Commit to the dataset. This Space and the phone UI both read that catalog (`templates/catalog.json` on the CDN, and `/list_templates`). A catalog-only addition does not need an app redeploy.
7. Tap **Refresh templates** so the new clip shows up in the gallery.

Clips already in the dataset: Mixkit free stock, and `demo-victory` from Wan-Video/Wan-Animate-2 `examples/demo1/template.mp4` (Apache-2.0).
"""

GALLERY_HEAD = """
<script>
(function () {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  function tune(v) {
    v.muted = true;
    v.defaultMuted = true;
    v.loop = true;
    v.playsInline = true;
    v.autoplay = true;
    v.setAttribute("muted", "");
    v.setAttribute("playsinline", "");
    v.setAttribute("webkit-playsinline", "");
  }
  function arm(v) {
    tune(v);
    if (!v.getAttribute("src") && v.dataset.src) v.src = v.dataset.src;
  }
  function ratioInView(el) {
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    if (r.width <= 0 || r.height <= 0) return 0;
    const w = Math.min(r.right, vw) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, vh) - Math.max(r.top, 0);
    return (Math.max(0, w) / r.width) * (Math.max(0, h) / r.height);
  }
  function sync() {
    document.querySelectorAll("video.tpl-video").forEach((v) => {
      tune(v);
      const card = v.closest(".tcard");
      const selected = card && card.classList.contains("is-selected");
      const ratio = ratioInView(v);
      if (!reduce && (ratio >= 0.12 || (selected && ratio > 0.02))) {
        arm(v);
        const p = v.play();
        if (p && p.catch) p.catch(function () { v.controls = true; });
      } else {
        v.pause();
      }
    });
  }
  window.__tplPaint = function () {
    const id = window.__tplSelected || "";
    document.querySelectorAll("#template-rail .tcard").forEach((card) => {
      card.classList.toggle("is-selected", !!id && card.id === "card-" + id);
    });
    sync();
  };
  const io = new IntersectionObserver(function () { sync(); }, {
    root: null,
    rootMargin: "80px 120px",
    threshold: [0, 0.15, 0.4]
  });
  function scan() {
    document.querySelectorAll("video.tpl-video").forEach((v) => {
      tune(v);
      if (v.dataset.bound === "1") return;
      v.dataset.bound = "1";
      io.observe(v);
    });
    if (window.__tplPaint) window.__tplPaint();
  }
  function start() {
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
    scan();
    document.addEventListener("click", function (ev) {
      const card = ev.target.closest && ev.target.closest("#template-rail .tcard");
      if (!card || (ev.target.closest && ev.target.closest("button, a, input, textarea"))) return;
      const btn = card.querySelector("button");
      if (btn) btn.click();
    });
    window.addEventListener("scroll", sync, { passive: true });
    window.addEventListener("resize", sync);
  }
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start);
})();
</script>
"""

CSS = """
.gradio-container {
  max-width: 520px !important;
  width: 100% !important;
  min-width: 0 !important;
  margin: 0 auto !important;
  padding: 12px !important;
  box-sizing: border-box !important;
}
.gradio-container .app,
.gradio-container .contain,
.gradio-container .column,
.gradio-container .row {
  min-width: 0 !important;
  max-width: 100% !important;
}
.big-btn button { font-size: 1.05rem !important; min-height: 3rem !important; width: 100%; }
#howto-btn button, #howto-btn { min-height: 3rem; font-weight: 700; }
#status-md { font-size: 1rem; }
footer { display: none !important; }
#template-rail {
  flex-wrap: nowrap !important;
  overflow-x: auto !important;
  gap: 12px !important;
  scroll-snap-type: x mandatory;
  -webkit-overflow-scrolling: touch;
  padding: 4px 2px 12px !important;
  align-items: stretch !important;
}
#template-rail > div,
#template-rail .tcard {
  flex: 0 0 min(78vw, 260px) !important;
  max-width: 260px !important;
  min-width: 200px !important;
  scroll-snap-align: center;
  position: relative;
}
#template-rail .tcard { cursor: pointer; }
#template-rail .tcard.is-selected {
  outline: 2px solid #ec4899;
  outline-offset: 3px;
  border-radius: 16px;
}
#template-rail .tcard.is-selected::after {
  content: "Selected";
  position: absolute;
  top: 10px;
  left: 10px;
  z-index: 5;
  background: #ec4899;
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.01em;
  padding: 4px 8px;
  border-radius: 999px;
  pointer-events: none;
}
.tpl-video, .prose .tpl-video {
  width: 100%;
  aspect-ratio: 3 / 4;
  height: auto;
  max-height: 340px;
  object-fit: cover;
  border-radius: 14px;
  background: #000;
  display: block;
  margin: 0;
}
.tpl-meta { padding: 0.45rem 0.15rem 0.15rem; line-height: 1.25; }
.tpl-meta strong { display: block; font-size: 0.95rem; }
.tpl-meta span { display: block; color: #9a9aaf; font-size: 0.78rem; margin-top: 0.15rem; }
#still-upload { scroll-margin-top: 12px; }
@media (max-width: 640px) {
  .gradio-container { padding-left: 10px !important; padding-right: 10px !important; }
}
"""

HIGHLIGHT_JS = """
(template_id) => {
  window.__tplSelected = template_id || "";
  if (window.__tplPaint) window.__tplPaint();
  if (template_id) {
    const card = document.getElementById("card-" + template_id);
    if (card) card.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    const upload = document.querySelector("#still-upload");
    if (upload) upload.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  return template_id;
}
"""


def _fmt_dur(value: Any) -> str:
    try:
        num = float(value)
    except (TypeError, ValueError):
        return "?"
    if abs(num - round(num)) < 1e-6:
        return str(int(round(num)))
    return f"{num:.1f}"


def _card_html(item: dict) -> str:
    url = html.escape(item.get("video_url") or "", quote=True)
    title = html.escape(item.get("title") or item.get("id") or "Template")
    category = html.escape(str(item.get("category") or "motion"))
    dur = html.escape(_fmt_dur(item.get("duration_s")))
    return (
        f'<video class="tpl-video" muted loop playsinline webkit-playsinline '
        f'autoplay preload="none" data-src="{url}" aria-label="{title}"></video>'
        f'<div class="tpl-meta"><strong>{title}</strong>'
        f"<span>~{dur}s · {category}</span></div>"
    )


def describe_template(template_id: str | None) -> str:
    if not template_id:
        return (
            "Scroll the motions and tap **Select this motion**. "
            "Your still stays locked until a template is selected."
        )
    catalog = load_catalog()
    item = next((t for t in catalog if t.get("id") == template_id), None)
    if not item:
        return f"Unknown template: `{template_id}`"
    tags = ", ".join(item.get("tags") or []) or "—"
    return (
        f"### {item.get('title', template_id)}\n"
        f"{item.get('description', '')}\n\n"
        f"**Selected id:** `{template_id}` · "
        f"~{item.get('duration_s', '?')}s · "
        f"**{item.get('category', '—')}** · {tags}\n\n"
        "Upload a still of the person who should do this motion."
    )


def _make_select(template_id: str):
    def _fn():
        return template_id

    _fn.__name__ = "select_" + template_id.replace("-", "_")
    return _fn


def refresh_ui(current_id: str | None):
    try:
        catalog = load_catalog(force=True)
    except Exception as e:
        return gr.skip(), gr.skip(), gr.skip(), f"Could not refresh templates: {e}"
    choices = [
        (t.get("label") or t.get("title") or t.get("id"), t["id"]) for t in catalog
    ]
    ids = [t["id"] for t in catalog]
    value = current_id if current_id in ids else None
    info = gr.skip() if value else describe_template(None)
    return json.dumps(catalog, indent=2), gr.update(choices=choices, value=value), catalog, info


def on_template_only(template_id: str | None):
    unlocked = bool(template_id)
    label = (
        "Your still photo — you become the character"
        if unlocked
        else "Pick a template above, then upload your still"
    )
    return (
        describe_template(template_id),
        gr.update(interactive=unlocked, label=label),
    )


def gate_generate(template_id: str | None, image):
    return gr.update(interactive=bool(template_id) and image is not None)


def toggle_howto(is_open: bool):
    nxt = not bool(is_open)
    label = "Close instructions" if nxt else "How to use & create templates"
    return nxt, gr.update(visible=nxt), gr.update(value=label)


def build_ui():
    catalog: list[dict] = []
    try:
        catalog = load_catalog(force=True)
    except Exception as e:
        print(f"[warn] catalog load at startup: {e}")

    dropdown_choices = [
        (t.get("label") or t.get("title") or t.get("id"), t["id"]) for t in catalog
    ]

    with gr.Blocks(
        title="Wan 2.2 Templates — Become the Character",
        css=CSS,
        head=GALLERY_HEAD,
        theme=gr.themes.Soft(primary_hue="purple", secondary_hue="pink", neutral_hue="zinc"),
    ) as demo:
        if _hf_token():
            quota_banner = "ZeroGPU — authenticated (HF Pro quota when eligible)."
        else:
            quota_banner = "ZeroGPU — public queue (set Space secret HF_TOKEN for Pro quota)."
        gr.Markdown(
            f"""
# Become the Character
Scroll the motions, pick one, then upload a still. Generate puts you in that clip.

Templates are real ~4s human-motion videos from [`{TEMPLATE_DATASET}`](https://huggingface.co/datasets/{TEMPLATE_DATASET}).

**{quota_banner}** On 429 or “failed too many attempts”, wait 10–15 minutes and press Generate **once**.
            """
        )
        howto_open = gr.State(False)
        howto_btn = gr.Button(
            "How to use & create templates",
            elem_id="howto-btn",
            variant="secondary",
            size="lg",
        )
        howto_panel = gr.Markdown(HOWTO_MD, visible=False, elem_id="howto-panel")
        howto_btn.click(
            toggle_howto,
            [howto_open],
            [howto_open, howto_panel, howto_btn],
            queue=False,
            show_progress="hidden",
            api_name=False,
        )

        gr.Markdown("### Motions\nSwipe sideways. Clips autoplay muted. Tap one to continue.")
        catalog_state = gr.State(catalog)
        template_dd = gr.Dropdown(
            label="Selected template",
            choices=dropdown_choices,
            value=None,
            interactive=True,
            elem_id="template-picker",
            render=False,
        )

        @gr.render(inputs=catalog_state)
        def render_gallery(items):
            if not items:
                gr.Markdown("No templates in the catalog yet. Refresh, or add clips to the dataset.")
                return
            with gr.Row(elem_id="template-rail"):
                for item in items:
                    tid = str(item.get("id") or "")
                    if not tid:
                        continue
                    with gr.Column(
                        elem_classes=["tcard"],
                        elem_id=f"card-{tid}",
                        min_width=200,
                        scale=0,
                    ):
                        gr.HTML(_card_html(item), padding=False)
                        gr.Button(
                            "Select this motion",
                            size="sm",
                            elem_id=f"pick-{tid}",
                        ).click(
                            _make_select(tid),
                            outputs=[template_dd],
                            queue=False,
                            show_progress="hidden",
                            api_name=False,
                        )

        btn_refresh = gr.Button("Refresh templates", size="sm")
        template_info = gr.Markdown(describe_template(None))
        template_dd.render()

        photo = gr.Image(
            label="Pick a template above, then upload your still",
            type="pil",
            height=280,
            interactive=False,
            elem_id="still-upload",
        )
        prompt = gr.Textbox(
            label="Prompt (optional)",
            value=DEFAULT_PROMPT,
            lines=2,
            placeholder="Describe appearance / scene…",
        )

        with gr.Accordion("Animate settings", open=False):
            max_seconds = gr.Slider(1.0, 5.0, value=3.0, step=0.5, label="Seconds of driving video")
            with gr.Row():
                height = gr.Slider(256, 720, value=480, step=16, label="Height")
                width = gr.Slider(256, 720, value=384, step=16, label="Width")
            anim_steps = gr.Slider(1, 12, value=6, step=1, label="Inference steps")
            guidance = gr.Slider(1.0, 5.0, value=1.0, step=0.1, label="Guidance (1=off)")
            sample_shift = gr.Slider(1.0, 10.0, value=5.0, step=0.5, label="Sample shift")
            seed = gr.Number(value=42, label="Seed", precision=0)
            negative = gr.Textbox(label="Negative prompt", value=DEFAULT_NEGATIVE, lines=2)

        with gr.Accordion("Extend options (after generate)", open=False):
            seg_duration = gr.Slider(2.0, 5.0, value=3.5, step=0.5, label="Extend segment length (s)")
            target_seconds = gr.Slider(8, 22, value=12, step=1, label="Auto-extend target (s)")
            ext_steps = gr.Slider(1, 12, value=4, step=1, label="Extend inference steps")
            quality = gr.Slider(1, 10, value=6, step=1, label="Video quality")
            fps = gr.Dropdown(choices=[16, 32, 64], value=16, label="Fluidity FPS")
            randomize = gr.Checkbox(value=True, label="Randomize seed on extend")
            safe_mode = gr.Checkbox(value=True, label="Upstream Safe Mode")

        with gr.Row(elem_classes=["big-btn"]):
            btn_gen = gr.Button(
                "Generate — become the character",
                variant="primary",
                size="lg",
                interactive=False,
            )
        with gr.Row(elem_classes=["big-btn"]):
            btn_ext = gr.Button("Extend", variant="secondary")
            btn_auto = gr.Button("Auto-extend")
            btn_reset = gr.Button("Reset")

        state = gr.State({})
        session_id = gr.Textbox(label="Session ID", value="", visible=False)
        catalog_json = gr.Textbox(label="Catalog JSON (API)", lines=4, visible=False)

        video = gr.Video(label="Result", height=400, autoplay=True)
        status = gr.Markdown("**Segments:** 0  ·  **Duration ≈ 0s**", elem_id="status-md")
        last_preview = gr.Image(label="Last frame (next Extend start)", height=160)
        download = gr.File(label="Download MP4")

        template_dd.change(
            on_template_only,
            [template_dd],
            [template_info, photo],
            js=HIGHLIGHT_JS,
            queue=False,
            show_progress="hidden",
            api_name=False,
        )
        template_dd.change(
            gate_generate,
            [template_dd, photo],
            [btn_gen],
            queue=False,
            show_progress="hidden",
            api_name=False,
        )
        photo.change(
            gate_generate,
            [template_dd, photo],
            [btn_gen],
            queue=False,
            show_progress="hidden",
            api_name=False,
        )
        btn_refresh.click(
            refresh_ui,
            [template_dd],
            [catalog_json, template_dd, catalog_state, template_info],
            api_name=False,
            show_progress="minimal",
        )

        gen_inputs = [
            template_dd, photo, prompt, max_seconds, height, width,
            anim_steps, guidance, sample_shift, negative, seed, session_id, state,
        ]
        ext_inputs = [
            prompt, seg_duration, ext_steps, negative, seed,
            randomize, quality, fps, safe_mode, session_id, state,
        ]
        outs = [video, download, status, last_preview, session_id, state]

        btn_gen.click(do_generate, gen_inputs, outs, api_name="generate")
        btn_ext.click(do_extend, ext_inputs, outs, api_name="extend")
        btn_auto.click(
            do_auto_extend,
            [target_seconds] + ext_inputs,
            outs,
            api_name="auto_extend",
        )
        btn_reset.click(do_reset, [session_id, state], outs, api_name="reset")

        force_box = gr.Checkbox(value=True, visible=False)
        btn_list = gr.Button(visible=False)
        btn_list.click(
            list_templates_api,
            [force_box],
            [catalog_json, template_dd],
            api_name="list_templates",
        )

    return demo


if __name__ == "__main__":
    demo = build_ui()
    demo.queue(default_concurrency_limit=1).launch(server_name="0.0.0.0", server_port=7860)
