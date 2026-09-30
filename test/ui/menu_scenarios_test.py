#!/usr/bin/env python3
"""Focused tests for UI-harness recovery policy."""

from __future__ import annotations

import subprocess
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from menu_scenarios import _paste_folder_path, open_workspace


class FolderClipboardTests(unittest.TestCase):
    def tearDown(self) -> None:
        if hasattr(open_workspace, "_done"):
            del open_workspace._done  # noqa: SLF001

    def test_dropped_paste_returns_an_attempt_failure_and_reaps_xclip(self) -> None:
        driver = MagicMock(display_name=":73")
        owner = MagicMock()
        owner.stdin = MagicMock()
        owner.poll.return_value = None
        owner.wait.side_effect = [subprocess.TimeoutExpired("xclip", 2), 0]
        with (
            patch("menu_scenarios.subprocess.Popen", return_value=owner),
            patch("menu_scenarios.time.sleep"),
        ):
            failure = _paste_folder_path(driver, Path("/tmp/isolated/ws"))

        self.assertIn("Ctrl+V", failure)
        owner.terminate.assert_called_once()
        driver.key.assert_called_once_with("v", ("Control_L",))

    def test_open_workspace_retries_a_dropped_paste(self) -> None:
        with (
            patch(
                "menu_scenarios._open_folder_once",
                side_effect=["Ctrl+V may have been dropped", None],
            ) as attempt,
            patch("menu_scenarios._dismiss_chooser") as dismiss,
        ):
            open_workspace(MagicMock(), MagicMock(), Path("/tmp/isolated/ws"), attempts=2)

        self.assertEqual(attempt.call_count, 2)
        dismiss.assert_called_once()


if __name__ == "__main__":
    unittest.main()
