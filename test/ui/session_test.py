#!/usr/bin/env python3
"""Policy tests for selecting an isolated X server."""

from __future__ import annotations

import unittest
from pathlib import Path
from unittest.mock import patch

from session import APP, XServer, built_binary, resolve_server


class ResolveServerTests(unittest.TestCase):
    def test_auto_prefers_xvfb(self) -> None:
        with patch("session.shutil.which", side_effect=lambda name: f"/usr/bin/{name}"):
            self.assertEqual(resolve_server("auto"), "xvfb")

    def test_auto_falls_back_to_xephyr(self) -> None:
        with patch(
            "session.shutil.which",
            side_effect=lambda name: None if name == "Xvfb" else f"/usr/bin/{name}",
        ):
            self.assertEqual(resolve_server("auto"), "xephyr")

    def test_explicit_xephyr_is_retained(self) -> None:
        with patch("session.shutil.which") as which:
            self.assertEqual(resolve_server("xephyr"), "xephyr")
            which.assert_not_called()

    def test_auto_reports_both_install_options_when_neither_exists(self) -> None:
        with patch("session.shutil.which", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "xvfb or xserver-xephyr"):
                resolve_server("auto")

    def test_xvfb_command_includes_the_required_screen_number(self) -> None:
        server = XServer(kind="xvfb", width=1280, height=900, display_num=73)
        popen = unittest.mock.MagicMock()
        popen.poll.return_value = None
        with (
            patch("session.shutil.which", return_value="/usr/bin/Xvfb"),
            patch("session.subprocess.Popen", return_value=popen) as start,
            patch("session.Path.exists", return_value=True),
            patch("session.time.sleep"),
        ):
            server.start()
        self.assertEqual(
            start.call_args.args[0],
            ["Xvfb", ":73", "-screen", "0", "1280x900x24"],
        )


class BuiltBinaryTests(unittest.TestCase):
    def test_default_target_is_below_the_tauri_crate(self) -> None:
        with patch.dict("session.os.environ", {}, clear=True):
            self.assertEqual(built_binary(), APP / "src-tauri/target/release/quipu")

    def test_absolute_cargo_target_directory_is_respected(self) -> None:
        with patch.dict("session.os.environ", {"CARGO_TARGET_DIR": "/tmp/quipu-target"}):
            self.assertEqual(built_binary(), Path("/tmp/quipu-target/release/quipu"))
            self.assertEqual(built_binary("debug"), Path("/tmp/quipu-target/debug/quipu"))


if __name__ == "__main__":
    unittest.main()
