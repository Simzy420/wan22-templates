"""Reject Wan clips that are color mush or near-black instead of a subject.

Casey’s failed sample (3s, 432×400, 24 fps) is smooth orange/purple fields:
after the opening frame its mean edge energy on a 64×64 gray frame is about
4.6. The softest catalog clip (demo-wave) stays about 6.4, and demo-walk is
about 10. Frame-to-frame difference is not used: at 24 fps a real person
moves less between neighbors than that mush does.

This module only needs OpenCV and NumPy so it can be tested without Gradio.
"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

# Drop the opening frames. The bad sample’s first frame is an outlier.
WARMUP_FRAMES = 8
MAX_FRAMES = 240
SAMPLE_EDGE = 64
# Midway between the bad sample (~4.6) and demo-wave (~6.4).
MUSH_GRADIENT = 5.4
# 12/255 is almost pure black, not a dark but real scene.
NEAR_BLACK_LUMA = 12.0
MIN_STEADY_FRAMES = 4


def _gray64(frame_bgr: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
    small = cv2.resize(gray, (SAMPLE_EDGE, SAMPLE_EDGE), interpolation=cv2.INTER_AREA)
    return small.astype(np.float32)


def edge_energy(gray: np.ndarray) -> float:
    """Mean absolute neighbor difference, averaged across x and y."""
    dx = np.abs(np.diff(gray, axis=1)).mean()
    dy = np.abs(np.diff(gray, axis=0)).mean()
    return float((dx + dy) / 2.0)


def measure_grays(grays: list[np.ndarray]) -> dict:
    """Score already-decoded gray frames (float, 0–255)."""
    if len(grays) <= WARMUP_FRAMES:
        steady = list(grays)
    else:
        steady = list(grays[WARMUP_FRAMES:])
    if not steady:
        return {"frames": len(grays), "steady_frames": 0, "luma": 0.0, "gradient": 0.0}
    luma = float(np.mean([float(frame.mean()) for frame in steady]))
    gradient = float(np.mean([edge_energy(frame) for frame in steady]))
    return {
        "frames": len(grays),
        "steady_frames": len(steady),
        "luma": luma,
        "gradient": gradient,
    }


def read_grays(path: str | Path) -> list[np.ndarray]:
    cap = cv2.VideoCapture(str(path))
    grays: list[np.ndarray] = []
    if cap.isOpened():
        while len(grays) < MAX_FRAMES:
            ok, frame = cap.read()
            if not ok or frame is None:
                break
            grays.append(_gray64(frame))
    cap.release()
    return grays


def rejection_message(stats: dict, action: str = "Animate") -> str | None:
    """Return a user-facing error, or None when the clip can be shown."""
    if int(stats.get("steady_frames") or 0) < MIN_STEADY_FRAMES:
        return (
            f"{action} did not return a readable video, so nothing was saved. "
            "Wait 10–15 minutes and try once."
        )
    if float(stats["luma"]) < NEAR_BLACK_LUMA:
        return (
            f"{action} returned a near-black clip, so it was not saved as a result. "
            "Wait 10–15 minutes and try once."
        )
    if float(stats["gradient"]) < MUSH_GRADIENT:
        return (
            f"{action} returned color noise instead of a subject, so that clip was not saved. "
            "Wait 10–15 minutes and try once."
        )
    return None


def assess_video(path: str | Path, action: str = "Animate") -> str | None:
    """Error string when this file must not be returned as a successful result."""
    file_path = Path(path)
    if not file_path.is_file() or file_path.stat().st_size < 32:
        return rejection_message({"steady_frames": 0}, action)
    return rejection_message(measure_grays(read_grays(file_path)), action)
