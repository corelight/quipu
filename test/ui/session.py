#!/usr/bin/env python3
"""Bring up an isolated X display, a Quipu build, and a scratch workspace.

Isolation is not a nicety, and it has two halves.

*Input* isolation: the harness synthesises pointer and keyboard input at the X
server, so running it against the developer's live desktop means clicks land
wherever the pointer happens to be and keystrokes go to whatever has focus. Every
scenario must run against a nested (Xephyr) or headless (Xvfb) server. Scenario
runs prefer Xvfb when it is installed and fall back to Xephyr. Pass
`--server xephyr` when a watchable run is more useful for diagnosis.

*State* isolation: Quipu persists view preferences, and a test run has to be able
to clear them. `Profile` gives every run a throwaway XDG base-directory set under
a `quipu-ui-test-*` temporary directory, so the app under test never sees - and
the harness can never delete - the developer's real
`~/.local/share/com.corelight.quipu`. HOME itself is deliberately left alone; see
`Profile`.
"""

from __future__ import annotations

import argparse
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
APP = REPO / "app"

APP_ID = "com.corelight.quipu"

# Prefix for every temporary tree the harness owns. Deliberately unmistakable:
# it is what tells a human looking at /tmp (and reset_persisted_state, looking at
# a path it has been asked to delete) that the directory belongs to a test run.
TMP_PREFIX = "quipu-ui-test-"

# vite's dev server port, fixed in vite.config.ts. A leftover vite from a
# previous run holds it and makes `tauri dev` exit immediately, which otherwise
# surfaces only as an unexplained window timeout.
DEV_PORT = 1420

SERVER_CHOICES = ("auto", "xvfb", "xephyr")
SERVER_BINARIES = {"xephyr": "Xephyr", "xvfb": "Xvfb"}
SERVER_PACKAGES = {"xephyr": "xserver-xephyr", "xvfb": "xvfb"}


def built_binary(mode: str = "release") -> Path:
    """Return a prebuilt binary, respecting Cargo's configured target root."""
    configured = os.environ.get("CARGO_TARGET_DIR")
    if configured is None:
        target = APP / "src-tauri" / "target"
    else:
        target = Path(configured)
        if not target.is_absolute():
            target = APP / "src-tauri" / target
    return target / mode / "quipu"


def resolve_server(kind: str) -> str:
    """Resolve the scenario policy to an installed X server.

    Headless Xvfb is the ordinary automation path. Xephyr remains both the
    fallback on developer machines without Xvfb and an explicit, watchable
    choice. An explicit choice never silently changes server type.
    """
    if kind not in SERVER_CHOICES:
        raise ValueError(f"unknown X server policy: {kind}")
    if kind != "auto":
        return kind
    for candidate in ("xvfb", "xephyr"):
        if shutil.which(SERVER_BINARIES[candidate]) is not None:
            return candidate
    raise RuntimeError(
        "no isolated X server is installed "
        "(apt install xvfb or xserver-xephyr)"
    )


def dev_port_owner() -> str | None:
    """Returns a description of whatever holds the dev port, or None if free."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", DEV_PORT))
        except OSError:
            pass
        else:
            return None
    try:
        out = subprocess.run(
            ["ss", "-ltnp"], capture_output=True, text=True, timeout=5
        ).stdout
        for line in out.splitlines():
            if f":{DEV_PORT} " in line:
                return line.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return f"an unidentified process is listening on {DEV_PORT}"


class XServer:
    """A nested or virtual X server on a free display number."""

    def __init__(self, kind: str = "auto", width: int = 1280, height: int = 900, display_num: int | None = None):
        self.kind = resolve_server(kind)
        self.width, self.height = width, height
        self.display = f":{display_num if display_num is not None else self._free_display()}"
        self.proc: subprocess.Popen | None = None

    @staticmethod
    def _free_display() -> int:
        for n in range(20, 100):
            if not Path(f"/tmp/.X11-unix/X{n}").exists():
                return n
        raise RuntimeError("no free X display number between :20 and :99")

    def start(self) -> "XServer":
        binary = SERVER_BINARIES[self.kind]
        if shutil.which(binary) is None:
            package = SERVER_PACKAGES[self.kind]
            raise RuntimeError(f"{binary} is not installed (apt install {package})")
        cmd = [binary, self.display, "-screen"]
        if self.kind == "xephyr":
            cmd += [f"{self.width}x{self.height}x24", "-resizeable"]
        else:
            # Unlike Xephyr, Xvfb takes a screen number before its geometry.
            cmd += ["0", f"{self.width}x{self.height}x24"]
        self.proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):  # the socket appears well before the server is ready
            if Path(f"/tmp/.X11-unix/X{self.display[1:]}").exists():
                time.sleep(0.5)
                return self
            time.sleep(0.1)
        raise TimeoutError(f"{binary} did not come up on {self.display}")

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()


class Profile:
    """A throwaway XDG base-directory set, owning the temp tree it lives in.

    Everything Quipu persists - WebKit's localStorage, its caches, any config -
    is addressed through the XDG base directories, so pointing the child process
    at a temporary set of them is what keeps a test run out of the developer's
    real `~/.local/share/com.corelight.quipu`. That directory must never be read,
    written or deleted by the harness: an earlier version of
    `reset_persisted_state()` rmtree'd the developer's actual localStorage on
    every run, destroying real preferences to fix a test-fixture problem.

    HOME is left exactly as it is, on purpose. Repointing it would isolate far
    more than this needs - the npm cache, the Cargo and rustup homes that
    `tauri dev` compiles against, the GTK bookmarks the file chooser reads - and
    would turn a two-minute suite into a cold rebuild. Overriding the three XDG
    variables is the smallest change that covers the app's own state.

    The workspace lives here too, rather than at a fixed `/tmp` path, so two runs
    cannot fight over it and a crashed run leaves nothing behind.
    """

    def __init__(self):
        # ignore_cleanup_errors: WebKit and GTK write into these trees from
        # another process, and a teardown race must not mask the test result.
        self._tmp = tempfile.TemporaryDirectory(prefix=TMP_PREFIX, ignore_cleanup_errors=True)
        self.root = Path(self._tmp.name)
        self.data_home = self.root / "data"
        self.cache_home = self.root / "cache"
        self.config_home = self.root / "config"
        # Short on purpose: this path is typed character by character into the GTK
        # folder chooser (see menu_scenarios._open_folder_once), and every
        # keystroke is a chance for the nested X server to drop or duplicate one.
        self.workspace = self.root / "ws"
        for d in (self.data_home, self.cache_home, self.config_home):
            d.mkdir(parents=True)

    def env(self) -> dict[str, str]:
        """The XDG overrides to hand a Quipu child process."""
        return {
            "XDG_DATA_HOME": str(self.data_home),
            "XDG_CACHE_HOME": str(self.cache_home),
            "XDG_CONFIG_HOME": str(self.config_home),
        }

    def close(self) -> None:
        """Remove the whole tree. Idempotent, so a shared profile can be closed
        once after the last session that used it."""
        self._tmp.cleanup()


class App:
    """A running Quipu, either `tauri dev` or a prebuilt binary."""

    def __init__(
        self,
        display: str,
        profile: Profile,
        mode: str = "dev",
        log: Path | None = None,
        debug: bool = False,
    ):
        self.display = display
        self.profile = profile
        self.mode = mode
        self.log = log or Path("/tmp/quipu-uitest.log")
        self.debug = debug
        self.proc: subprocess.Popen | None = None

    def start(self) -> "App":
        env = {
            **os.environ,
            "DISPLAY": self.display,
            # yara-x's build script regenerates modules.rs by default, which
            # needs protoc and rewrites files inside the vendored dependency.
            # Off for test runs.
            "YRX_REGENERATE_MODULES_RS": "false",
            # Confine every scrap of persisted app state to the throwaway
            # profile. Required, not optional: without it the app under test
            # reads and writes the developer's real Quipu profile.
            **self.profile.env(),
        }
        if self.mode == "dev":
            owner = dev_port_owner()
            if owner is not None:
                raise RuntimeError(
                    f"port {DEV_PORT} is in use, so `tauri dev` will exit immediately.\n"
                    f"  {owner}\n"
                    "Stop the leftover dev server, or run against a release build (--mode release)."
                )
            cmd = ["npm", "run", "tauri", "dev"]
            if self.debug:
                # npm consumes the first separator; Tauri consumes the second
                # and forwards `--debug` to the application process.
                cmd += ["--", "--debug"]
            cwd = APP
        else:
            binary = built_binary(self.mode)
            if not binary.exists():
                raise FileNotFoundError(
                    f"{binary} not built; run `npm run tauri -- build"
                    f"{' --debug' if self.mode == 'debug' else ''} --no-bundle` first"
                )
            cmd = [str(binary)]
            if self.debug:
                cmd.append("--debug")
            cwd = APP
        self.log.parent.mkdir(parents=True, exist_ok=True)
        with self.log.open("wb") as fh:
            self.proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=fh, stderr=subprocess.STDOUT,
                                         start_new_session=True)
        return self

    def stop(self) -> None:
        if not self.proc:
            return
        # `npm run tauri dev` spawns vite and the Rust binary as children; kill
        # the whole process group or the binary keeps the display busy.
        try:
            os.killpg(os.getpgid(self.proc.pid), signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            self.proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(os.getpgid(self.proc.pid), signal.SIGKILL)
            except ProcessLookupError:
                pass


def reset_persisted_state(data_home: Path, app_id: str = APP_ID) -> None:
    """Clear the webview's localStorage inside an isolated test profile.

    Not hygiene - correctness. Quipu persists `quipu.zoom`, so a run that ends
    at 80% leaves the *next* run's UI scaled to 80% from startup, and every
    coordinate in the scenarios lands somewhere else. That surfaced as
    `rename_rekeys_and_saves` renaming b.yar instead of a.yar and as Ctrl+S
    appearing to do nothing: both looked like app bugs and were neither.

    `data_home` is required and must be a `Profile` data home. There is
    deliberately no default: this function used to fall back to
    `Path.home()/".local/share"`, which meant every test run deleted the
    developer's real Quipu preferences. A missing isolation root is a bug in the
    harness, so it raises rather than guessing - the one thing it must never do
    is delete state it does not own.
    """
    root = Path(data_home).resolve()
    if not any(part.startswith(TMP_PREFIX) for part in root.parts):
        raise RuntimeError(
            f"refusing to clear persisted state under {root}: it is not inside a "
            f"{TMP_PREFIX}* temporary profile. Tests must never touch the real "
            f"application data directory (~/.local/share/{app_id}); pass a "
            "Profile().data_home."
        )
    store = root / app_id / "localstorage"
    if store.exists():
        shutil.rmtree(store)


def make_workspace(root: Path) -> Path:
    """A throwaway rule directory with known content.

    Two rules, distinct names and patterns, so a compile yields a predictable
    count and a scan a predictable match. The scan target's bytes match only
    `alpha_rule`.
    """
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)
    (root / "a.yar").write_text(
        'rule alpha_rule {\n  strings:\n    $a = "malware"\n  condition:\n    $a\n}\n'
    )
    (root / "b.yar").write_text(
        'rule beta_rule {\n  strings:\n    $b = "benign"\n  condition:\n    $b\n}\n'
    )
    (root / "target.bin").write_bytes(b"malware")
    return root


@contextmanager
def quipu_session(
    server: str = "auto",
    mode: str = "dev",
    startup_timeout: float = 90.0,
    reset_state: bool = True,
    profile: Profile | None = None,
    debug: bool = False,
):
    """Yields (driver, main_window, workspace) with everything torn down after.

    The startup timeout is generous because a cold `tauri dev` compiles the Rust
    side first. Against a release binary it is a couple of seconds.

    A `Profile` is created and removed here unless the caller supplies one.
    Supplying one is how a restart scenario gets two app processes to share a
    single persisted profile: pass the same object to both sessions, with
    `reset_state=False` on the second, and close it once both have finished.
    `zoom_survives_restart` is the worked example.
    """
    # Local import: keeps xdriver usable standalone. PROFILE_ENV lives there
    # because that is where it must fail closed if unset.
    from xdriver import PROFILE_ENV, Driver

    owned = profile is None
    prof = profile or Profile()
    if reset_state:
        reset_persisted_state(prof.data_home)  # before startup: zoom applies on load
    # How the localStorage probes find this run's profile. Set for the duration
    # of the session only, so a probe called outside one raises instead of
    # silently reading a stale (or real) profile.
    previous_env = os.environ.get(PROFILE_ENV)
    os.environ[PROFILE_ENV] = str(prof.data_home)
    xs = None
    app = None
    drv = None
    try:
        xs = XServer(kind=server).start()
        app = App(xs.display, prof, mode=mode, debug=debug).start()
        ws = make_workspace(prof.workspace)
        drv = Driver(xs.display)
        try:
            drv.wait_for_window(timeout=startup_timeout)
        except TimeoutError as err:
            # A bare timeout hides the actual cause (build failure, port clash,
            # missing library). The app's own log almost always names it.
            tail = ""
            if app.log.exists():
                tail = "\n".join(app.log.read_text(errors="replace").splitlines()[-25:])
            raise TimeoutError(f"{err}\n--- {app.log} (tail) ---\n{tail}") from err
        time.sleep(3)  # let the webview paint and the menu install
        # One click into the window before anything else. There is no window
        # manager on the nested display, so keyboard input follows the pointer;
        # a session's first accelerator was intermittently delivered nowhere,
        # which showed up as `zoom_survives_restart` reporting "<no store>" for a
        # zoom the app had never been asked to change.
        main = drv.main_window()
        drv.click(main.x + main.width // 2, main.y + main.height // 2)
        time.sleep(0.5)
        yield drv, main, ws
    finally:
        if drv is not None:
            # Guarded because Ctrl+C signals the whole foreground process group,
            # which includes Xephyr: the server can be gone before this runs, and
            # closing a dead X connection raises. Unguarded, that exception skipped
            # the rest of this block and left `tauri dev` alive, holding the vite
            # port for the next run to trip over.
            try:
                drv.close()
            except Exception:  # noqa: BLE001 - teardown must continue regardless
                pass
        if app is not None:
            app.stop()
        if xs is not None:
            xs.stop()
        if previous_env is None:
            os.environ.pop(PROFILE_ENV, None)
        else:
            os.environ[PROFILE_ENV] = previous_env
        # Only the creator removes the tree; a shared profile outlives one session.
        if owned:
            prof.close()


def main() -> int:
    ap = argparse.ArgumentParser(description="Start an isolated Quipu for interactive poking.")
    # This command is for interactive poking, so keep its visible default even
    # though automated scenario runs use the headless-first `auto` policy.
    ap.add_argument("--server", choices=SERVER_CHOICES, default="xephyr")
    ap.add_argument("--mode", choices=("dev", "debug", "release"), default="dev")
    args = ap.parse_args()
    # Interactive mode gets the same throwaway profile as a scenario run: poking
    # at the app by hand must not write to the real one either. It lives until
    # Ctrl+C and is removed on the way out.
    with quipu_session(server=args.server, mode=args.mode) as (drv, win, ws):
        print(f"display={drv.display_name} window=0x{win.id:x} {win.width}x{win.height} workspace={ws}")
        from xdriver import PROFILE_ENV

        print(f"profile={os.environ[PROFILE_ENV]} (removed on exit)")
        print("Ctrl+C to tear down.")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
