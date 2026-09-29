"""Synthetic checks for the mush / near-black gate. No Gradio import."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

from clip_quality import assess_video, edge_energy, measure_grays, rejection_message


def _soft_field(seed: int, shift: float = 0.0) -> np.ndarray:
    yy, xx = np.mgrid[0:64, 0:64]
    field = 150 + 28 * np.sin((xx + shift) / 16.0) + 18 * np.sin((yy + seed) / 20.0)
    return np.clip(field, 0, 255).astype(np.float32)


def _structured(offset: int) -> np.ndarray:
    frame = np.zeros((64, 64), np.float32)
    frame[4:60:2, :] = 210
    frame[:, 3:60:4] = 25
    return np.roll(frame, offset * 3, axis=1)


class ClipQualityTest(unittest.TestCase):
    def test_smooth_color_fields_are_rejected(self):
        grays = [_soft_field(i, shift=i * 0.3) for i in range(24)]
        stats = measure_grays(grays)
        self.assertLess(stats["gradient"], 5.4)
        message = rejection_message(stats)
        self.assertIsNotNone(message)
        self.assertIn("color noise", message)

    def test_edged_motion_is_kept(self):
        grays = [_structured(i) for i in range(24)]
        stats = measure_grays(grays)
        self.assertGreater(stats["gradient"], 8)
        self.assertIsNone(rejection_message(stats))

    def test_near_black_is_rejected_even_with_a_few_edges(self):
        grays = []
        for i in range(16):
            frame = np.full((64, 64), 3, np.float32)
            frame[:, i % 64] = 40
            grays.append(frame)
        message = rejection_message(measure_grays(grays))
        self.assertIsNotNone(message)
        self.assertIn("near-black", message)

    def test_unreadable_clip_is_an_error(self):
        message = rejection_message({"frames": 0, "steady_frames": 0, "luma": 0, "gradient": 0}, "Extend")
        self.assertIn("Extend", message)
        self.assertIn("readable", message)

    def test_written_mush_file_is_rejected_and_a_sharp_file_is_not(self):
        with tempfile.TemporaryDirectory() as tmp:
            mush = Path(tmp) / "mush.avi"
            sharp = Path(tmp) / "sharp.avi"
            self._write(mush, [self._bgr(_soft_field(i)) for i in range(20)])
            self._write(sharp, [self._bgr(_structured(i)) for i in range(20)])
            mush_reason = assess_video(mush)
            sharp_reason = assess_video(sharp)
        self.assertIn("color noise", mush_reason or "")
        self.assertIsNone(sharp_reason)

    def test_edge_energy_is_zero_on_a_flat_frame(self):
        self.assertEqual(edge_energy(np.full((8, 8), 128, np.float32)), 0.0)

    @staticmethod
    def _bgr(gray: np.ndarray) -> np.ndarray:
        return cv2.cvtColor(gray.astype(np.uint8), cv2.COLOR_GRAY2BGR)

    @staticmethod
    def _write(path: Path, frames: list[np.ndarray]) -> None:
        height, width = frames[0].shape[:2]
        writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), 8.0, (width, height))
        if not writer.isOpened():
            raise RuntimeError("VideoWriter failed")
        for frame in frames:
            writer.write(frame)
        writer.release()


if __name__ == "__main__":
    unittest.main()
