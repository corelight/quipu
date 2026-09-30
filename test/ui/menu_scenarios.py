#!/usr/bin/env python3
"""The native-menu acceptance walk, as executable scenarios.

This is a transcription of the manual verification done when the application
menu was implemented. It is kept as runnable code rather than a checklist in a
document because the interesting parts - single-save, zoom stepping, enabled
state - were only ever provable with the probes in xdriver.py, and re-deriving
them by hand each release is exactly the work worth not repeating.

All scenarios here have been run against isolated X servers. Automation prefers
headless Xvfb and falls back to watchable Xephyr. Menu row
positions are resolved from rendered pixels (xdriver.text_rows), but the pane
geometry constants below are still layout assumptions and are the first thing to
check when a scenario starts clicking the wrong thing.

Isolation matters more than it looks. Zoom is persisted and global, so a scenario
that ends at 80% rescales the UI and invalidates every coordinate the next one
uses; `reset_view` between scenarios and `reset_persisted_state` between runs
exist for that reason, and both were added after false failures that looked like
app bugs. The persisted state lives in a throwaway XDG profile (session.Profile),
never in the developer's real `~/.local/share/com.corelight.quipu`.

Run one:   python3 menu_scenarios.py save_fires_once
Run all:   python3 menu_scenarios.py --all
List them: python3 menu_scenarios.py --list
Watchable: python3 menu_scenarios.py --all --server xephyr
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from PIL import Image  # noqa: E402

from session import (  # noqa: E402
    App,
    Profile,
    SERVER_CHOICES,
    XServer,
    make_workspace,
    quipu_session,
    reset_persisted_state,
    resolve_server,
)
from xdriver import (  # noqa: E402
    Driver,
    WindowInfo,
    WriteWatcher,
    await_localstorage,
    centre,
    changed_fraction,
    colour_spans,
    mean_luminance,
    row_contrast,
    text_rows,
)

# ---- layout facts (the fragile part; update these when the UI moves) ----

MENUBAR_Y = 13  # vertical centre of the GTK menu bar
MENUBAR_X = {"File": 18, "Rules": 61, "View": 108, "Help": 152}

EDITOR_CLICK = (500, 300)  # somewhere inside the Monaco viewport
# Well inside the Monaco viewport, for "the text is still there" comparisons. It
# must not include the explorer, the tab strip or the status line, all of which
# change legitimately when a project does.
EDITOR_TEXT_BOX = (300, 150, 400, 200)
# The explorer's file list, below its buttons and folder line. Also what Open
# Folder's own success check reads, so "a project is open" is judged in one place.
EXPLORER_LIST_BOX = (0, 100, 220, 100)
SCAN_BUTTON_BOX = (1130, 52, 55, 22)  # for contrast probing of enabled state

# Strip used to observe zoom in *rendered pixels*. It must lie inside the
# webview: setZoom scales the web content only, and the GTK menu bar is a native
# widget outside it. Probing the menu bar therefore reports "identical at 80% and
# 100%" forever - a broken probe, not a broken feature. y starts below the menu
# bar; the explorer column has well-separated text rows whose spacing tracks the
# zoom factor directly.
ZOOM_PROBE_STRIP = (0, 27, 220, 400)

# --link from styles.css. The About dialog's credit links are found by this
# colour rather than by coordinate, so rewording the sentence does not break the
# scenario. Update it if the variable changes.
LINK_RGB = (0x4D, 0xAA, 0xFC)
ABOUT_DIALOG_BOX = (390, 297, 420, 240)

# Must match app/src/about.ts, app/src/reportissue.ts, and the opener scope in
# src-tauri/capabilities/default.json. Asserting on the exact URL is the point:
# a link that opens the wrong page is a bug a screenshot cannot catch.
CORELIGHT_URL = "https://corelight.com/platform/yara-file-analysis"
YARA_X_URL = "https://virustotal.github.io/yara-x/"
REPORT_ISSUE_URL = "https://github.com/corelight/quipu/issues/new/choose"


@dataclass
class Menu:
    """Opens a native GTK menu and activates items by *label position*.

    Rows are located from the rendered pixels (see xdriver.text_rows) instead of
    an assumed item pitch. Two reasons, both learned the hard way: GTK item
    height varies with theme and scale, and separators occupy a row visually but
    produce no label band. Indexing by "the Nth visible label" is stable against
    both, whereas counting items in menu.ts is not - miscounting separators is
    how a manual check once activated "Includes View" while aiming at
    "Reset Layout".
    """

    drv: Driver
    main: WindowInfo

    def open(self, title: str, attempts: int = 3) -> WindowInfo:
        # Retried because a single click on the menu bar occasionally produces no
        # popup - seen shortly after startup and under load, on a display with no
        # window manager. One lost click is not a claim about the application, so
        # it should not be reported as one.
        for _ in range(attempts):
            self.drv.key("Escape")
            time.sleep(0.3)
            self.drv.click(MENUBAR_X[title], MENUBAR_Y)
            time.sleep(0.7)
            popup = self.drv.open_popup(self.main)
            if popup is not None:
                return popup
            time.sleep(0.7)
        raise AssertionError(f"{title} menu did not open after {attempts} attempts")

    def rows(self, title: str) -> tuple[WindowInfo, list[tuple[int, int]]]:
        popup = self.open(title)
        return popup, text_rows(self.drv.grab(popup))

    def activate(self, title: str, label_index: int, settle: float = 1.2) -> None:
        popup, bands = self.rows(title)
        if label_index >= len(bands):
            raise AssertionError(f"{title} has {len(bands)} labels; no index {label_index}")
        top, bottom = bands[label_index]
        # Popup coordinates are window-relative; clicks are root-relative.
        self.drv.click(popup.x + 54, popup.y + (top + bottom) // 2)
        time.sleep(settle)

    def shot(self, title: str, out: Path, scale: int = 2) -> Path:
        popup = self.open(title)
        path = self.drv.save(out, popup, scale=scale)
        self.drv.key("Escape")
        return path


# Position of each item among the *visible labels* of its menu, separators
# excluded. Mirrors the order in app/src/menu.ts.
LABEL_INDEX = {
    "file.open-folder": 0,
    "file.open-example": 1,
    "file.new-rule": 2,
    "file.save": 3,
    "file.rename-rule": 4,
    "file.refresh-project": 5,
    "file.close-workspace": 6,
    "file.preferences": 7,
    "file.quit": 8,
    "rules.compile": 0,
    "rules.scan": 1,
    "view.zoom-in": 0,
    "view.zoom-out": 1,
    "view.zoom-reset": 2,
    "view.explorer": 3,
    "view.results-pane": 4,
    "view.reset-layout": 5,
    "view.includes": 6,
    "help.quick-start": 0,
    "help.documentation": 1,
    "help.report-issue": 2,
    "help.about": 3,
}

SCENARIOS: dict[str, callable] = {}


def scenario(fn):
    SCENARIOS[fn.__name__] = fn
    return fn


# ---- scenarios ----


@scenario
def menu_shape(drv: Driver, win: WindowInfo, ws: Path, artifacts: Path) -> None:
    """Every menu renders and has the expected number of items."""
    menu = Menu(drv, win)
    for title in ("File", "Rules", "View", "Help"):
        path = menu.shot(title, artifacts / f"menu-{title.lower()}.png")
        print(f"  captured {path}")

    # Label counts. File's last label is Quit, which on Linux is a regular menu
    # item rather than the predefined one - muda's GTK backend silently drops
    # predefined Quit, so building it by hand is what makes it appear at all.
    expected = {"File": 9, "Rules": 2, "View": 7, "Help": 4}
    for title, count in expected.items():
        popup, bands = menu.rows(title)
        drv.key("Escape")
        time.sleep(0.3)
        assert len(bands) == count, f"{title} shows {len(bands)} labels, expected {count}"
        print(f"  {title}: {len(bands)} labels")

@scenario
def save_fires_once(drv: Driver, win: WindowInfo, ws: Path, artifacts: Path) -> None:
    """Ctrl+S saves exactly once per press.

    The regression this guards: while refactoring, both a window keydown handler
    and the menu accelerator were wired to save, so one press wrote the file
    twice. Nothing in the UI shows that; only the write log does.

    Two checks. One press on a dirty file must produce exactly one write. A
    second press with no intervening edit must produce *none*, because Save is
    disabled once the file is clean - so "press twice, expect two writes" is the
    wrong expectation and asserting it fails against correct behaviour.
    """
    open_workspace(drv, win, ws, artifacts)
    activate_file(drv, win, "a.yar")
    drv.click(*EDITOR_CLICK)
    drv.type_text("// edit")
    time.sleep(0.5)

    with WriteWatcher(ws) as w:
        drv.key("s", ("Control_L",))
        time.sleep(1.0)
        w.drain(timeout=1.5)
        once = w.count("CLOSE_WRITE", "a.yar")

    with WriteWatcher(ws) as w:  # already clean: nothing more to write
        drv.key("s", ("Control_L",))
        time.sleep(1.0)
        w.drain(timeout=1.5)
        when_clean = w.count("CLOSE_WRITE", "a.yar")

    drv.type_text("// more")  # dirty again, so a further press must write once
    time.sleep(0.5)
    with WriteWatcher(ws) as w:
        drv.key("s", ("Control_L",))
        time.sleep(1.0)
        w.drain(timeout=1.5)
        again = w.count("CLOSE_WRITE", "a.yar")

    assert once == 1, f"one Ctrl+S on a dirty file produced {once} writes (double-handled?)"
    assert when_clean == 0, f"Ctrl+S on a clean file produced {when_clean} writes"
    assert again == 1, f"Ctrl+S after re-editing produced {again} writes"
    print(f"  dirty -> {once} write, clean -> {when_clean}, re-dirtied -> {again}")


@scenario
def zoom_stepping(drv: Driver, win: WindowInfo, ws: Path, artifacts: Path) -> None:
    """One keypress is one 10% step, and the range clamps at 75/200.

    Zoom is observed through the persisted value rather than by measuring
    pixels, because the stored integer percentage is the thing the
    implementation guarantees (integer stepping so repeated presses cannot
    drift the way float multiplication does).
    """
    drv.key("0", ("Control_L",))
    expect_zoom(100)  # Reset Zoom must land on exactly 100

    drv.key("equal", ("Control_L",))
    expect_zoom(110)  # one press is one step, not two

    for _ in range(12):  # walk into the ceiling
        drv.key("equal", ("Control_L",))
        time.sleep(0.25)
    expect_zoom(200)

    for _ in range(20):  # and into the floor
        drv.key("minus", ("Control_L",))
        time.sleep(0.25)
    expect_zoom(75)

    drv.key("0", ("Control_L",))
    expect_zoom(100)
    print("  stepping, clamping and reset all exact")


@scenario
def zoom_persistence(drv: Driver, win: WindowInfo, ws: Path, artifacts: Path) -> None:
    """A non-default zoom is written to storage, ready to be restored on load.

    Asserts the write half only: the restore half needs a fresh app process,
    which this scenario cannot do without tearing down the shared session. It is
    covered instead by `zoom_survives_restart`, which the runner executes
    separately.
    """
    drv.key("0", ("Control_L",))
    time.sleep(0.5)
    drv.key("minus", ("Control_L",))
    time.sleep(0.4)
    drv.key("minus", ("Control_L",))
    expect_zoom(80)
    print("  quipu.zoom persisted as 80")


@scenario
def scan_enables_after_compile(drv: Driver, win: WindowInfo, ws: Path, artifacts: Path) -> None:
    """Scan Target is disabled until a compile succeeds, then enabled.

    Probed by luminance on the Scan button, which is the same signal the menu
    item carries: during manual verification the label moved 148 -> 50 when it
    became disabled. Both the button and the menu row derive from one state
    push, so checking the button is sufficient and far less brittle than
    reopening the popup.
    """
    open_workspace(drv, win, ws, artifacts)
    before = mean_luminance(drv.grab(win), SCAN_BUTTON_BOX)

    drv.key("b", ("Control_L", "Shift_L"))
    time.sleep(4.0)  # compile is async
    after = mean_luminance(drv.grab(win), SCAN_BUTTON_BOX)
    drv.save(artifacts / "compiled.png", win)

    assert after - before > 15, f"Scan did not brighten after compile: {before:.0f} -> {after:.0f}"
    print(f"  Scan luminance {before:.0f} -> {after:.0f} after compile")


@scenario
def view_toggles_and_reset(drv: Driver, win: WindowInfo, ws: Path, artifacts: Path) -> None:
    """Explorer and Results toggle from every control, and Reset Layout restores
    the default widths without discarding state.

    The bug this guards: hiding the explorer with `display: none` removed it from
    grid auto-placement and slid every pane two columns left, collapsing the UI.
    A whole-window capture comparison catches that class of failure where a
    class-name assertion would not.
    """
    open_workspace(drv, win, ws, artifacts)
    baseline = drv.grab(win)

    drv.key("b", ("Control_L",))  # hide explorer
    time.sleep(0.8)
    hidden = drv.grab(win)
    drv.save(artifacts / "explorer-hidden.png", win)
    explorer_box = (0, 40, 220, 200)
    assert mean_luminance(baseline, explorer_box) != mean_luminance(hidden, explorer_box), \
        "Ctrl+B did not change the explorer region"
    # The editor must have grown into the freed space, not vanished: the far
    # right of the editor row should still be painted, not black.
    assert mean_luminance(hidden, (700, 300, 100, 40)) > 5, "editor region went blank (grid collapse?)"

    drv.key("j", ("Control_L",))  # open results
    time.sleep(0.8)
    Menu(drv, win).shot("View", artifacts / "view-checks-perturbed.png")

    Menu(drv, win).activate("View", LABEL_INDEX["view.reset-layout"], settle=1.5)
    restored = drv.grab(win)
    drv.save(artifacts / "reset-layout.png", win)
    assert abs(mean_luminance(restored, explorer_box) - mean_luminance(baseline, explorer_box)) < 6, \
        "Reset Layout did not restore the explorer to its default width"
    Menu(drv, win).shot("View", artifacts / "view-checks-reset.png")
    print("  toggles and Reset Layout behaved; check-item captures written")


@scenario
def rename_rekeys_and_saves(drv: Driver, win: WindowInfo, ws: Path, artifacts: Path) -> None:
    """After a rename the file stays active and saves to the NEW path only.

    Monaco model URIs are immutable, so a rename has to recreate the model. If
    the workspace key is not re-pointed, saving silently writes to the old path.
    Only the write log distinguishes that from success.
    """
    open_workspace(drv, win, ws, artifacts)
    activate_file(drv, win, "a.yar")
    Menu(drv, win).activate("File", LABEL_INDEX["file.rename-rule"], settle=1.2)
    drv.type_text("renamed.yar\n")
    time.sleep(1.2)
    assert (ws / "renamed.yar").exists(), "rename did not produce the new file"
    assert not (ws / "a.yar").exists(), "old path survived the rename"

    drv.click(*EDITOR_CLICK)
    drv.type_text("// after rename")
    time.sleep(0.4)
    with WriteWatcher(ws) as w:
        drv.key("s", ("Control_L",))
        time.sleep(1.0)
        w.drain(timeout=1.5)
        written = {n for n in w.names() if n.endswith(".yar")}
    assert written == {"renamed.yar"}, f"save touched {written}, expected only renamed.yar"
    print(f"  rename re-keyed; save wrote {written}")

    # Put the workspace back: later scenarios address files by row order, so a
    # leftover rename shifts every subsequent click.
    (ws / "renamed.yar").rename(ws / "a.yar")
    activate_file.invalidate()


@scenario
def about_dialog(drv: Driver, win: WindowInfo, ws: Path, artifacts: Path) -> None:
    """About shows a runtime version and closes on Escape.

    Opening and closing are asserted separately. When they were one assertion, a
    click that simply never reached the menu row reported "About did not close on
    Escape" - the two captures were identical because the dialog had never
    appeared, so the failure named the wrong half of the scenario.
    """
    centre = (450, 300, 300, 200)
    closed_before = mean_luminance(drv.grab(win), centre)
    for _ in range(3):
        Menu(drv, win).activate("Help", LABEL_INDEX["help.about"], settle=1.2)
        shown = drv.grab(win)
        if abs(mean_luminance(shown, centre) - closed_before) > 8:
            break
    else:
        drv.save(artifacts / "about-not-opened.png", win)
        raise AssertionError("About did not open (the menu click never landed)")

    drv.save(artifacts / "about.png", win)
    drv.key("Escape")
    time.sleep(0.8)
    closed = drv.grab(win)
    assert abs(mean_luminance(shown, centre) - mean_luminance(closed, centre)) > 8, \
        "About did not close on Escape"
    print("  About opened and closed; capture written for version review")


def preferences_dialog(artifacts: Path, server: str, mode: str) -> None:
    """Preferences is enabled, reports its isolated cache root, and closes on Escape.

    This is wiring evidence only: Rust tests own cache correctness. The effective
    path is copied from the dialog's read-only field and compared with the
    lifecycle scenario's private XDG profile, so the assertion proves both the
    displayed value and isolation rather than inferring either from pixels.
    """
    profile = Profile()
    expected = profile.cache_home / "com.corelight.quipu" / "compiled" / "v1"
    try:
        with quipu_session(
            server=server,
            mode=mode,
            reset_state=True,
            profile=profile,
        ) as (drv, win, _ws):
            menu = Menu(drv, win)
            popup, bands = menu.rows("File")
            image = drv.grab(popup)
            preferences_contrast = row_contrast(image, bands[LABEL_INDEX["file.preferences"]])
            enabled_reference = row_contrast(image, bands[LABEL_INDEX["file.open-folder"]])
            drv.key("Escape")
            assert preferences_contrast >= enabled_reference * 0.8, (
                f"Preferences looks disabled ({preferences_contrast:.0f} vs enabled "
                f"{enabled_reference:.0f})"
            )

            probe = (320, 210, 560, 420)
            closed_before = mean_luminance(drv.grab(win), probe)
            menu.activate("File", LABEL_INDEX["file.preferences"], settle=2.0)
            shown = drv.grab(win)
            assert abs(mean_luminance(shown, probe) - closed_before) > 8, (
                "Preferences did not open"
            )
            drv.save(artifacts / "preferences.png", win)

            # The location field is read-only but selectable. Copying avoids OCR
            # and asserts the exact backend-reported path. This point is inside
            # that field in the fixed 1280x900 scenario viewport.
            drv.click(win.x + 700, win.y + 485)
            time.sleep(0.3)
            drv.key("a", ("Control_L",))
            drv.key("c", ("Control_L",))
            copied = ""
            env = {**os.environ, "DISPLAY": drv.display_name}
            for _ in range(20):
                result = subprocess.run(
                    ["xclip", "-selection", "clipboard", "-o"],
                    env=env,
                    capture_output=True,
                    text=True,
                    timeout=2,
                    check=False,
                )
                copied = result.stdout
                if copied:
                    break
                time.sleep(0.2)
            assert copied == str(expected), (
                f"effective cache path was {copied!r}, expected {expected}; "
                f"xclip said {result.stderr.strip()!r}"
            )

            drv.key("Escape")
            time.sleep(0.8)
            closed = drv.grab(win)
            assert abs(mean_luminance(shown, probe) - mean_luminance(closed, probe)) > 8, (
                "Preferences did not close on Escape"
            )
            print(f"  enabled; reported isolated path {copied}; closed on Escape")
    finally:
        profile.close()


def documentation_window(artifacts: Path, server: str, mode: str) -> None:
    """Bundled Documentation loads and its Quick Start stays in one window.

    The native window title names the selected fixed entry point, while the
    generated-site build check proves each entry point exists. Keeping the same
    X window id proves in-site navigation remains in the singleton rather than
    opening another documentation window. `menu_shape` separately proves both
    Help entry points are enabled; this scenario enters through Documentation.
    """
    with quipu_session(server=server, mode=mode, reset_state=True) as (drv, main, _ws):
        def await_named(name: str, timeout: float = 10.0) -> WindowInfo:
            deadline = time.time() + timeout
            while time.time() < deadline:
                matches = [window for window in drv.toplevels() if window.name == name]
                if matches:
                    return matches[0]
                time.sleep(0.2)
            names = [window.name for window in drv.toplevels()]
            raise AssertionError(f"no window titled {name!r}; mapped titles: {names}")

        def await_auxiliary(timeout: float = 10.0) -> WindowInfo:
            deadline = time.time() + timeout
            while time.time() < deadline:
                matches = [
                    window for window in drv.toplevels()
                    if window.id != main.id and window.width >= 640 and window.height >= 480
                ]
                if matches:
                    return matches[0]
                time.sleep(0.2)
            raise AssertionError("no application-sized auxiliary window appeared")

        Menu(drv, main).activate("Help", LABEL_INDEX["help.documentation"], settle=1.0)
        opened = await_auxiliary()
        drv.save(artifacts / "documentation-window-opened.png", opened)
        documentation = await_named("Documentation — Quipu Documentation")
        assert documentation.width >= 640 and documentation.height >= 480, (
            f"documentation window is only {documentation.width}x{documentation.height}"
        )
        drv.save(artifacts / "documentation-window.png", documentation)

        # Follow the generated site's own Quick Start link. This exercises the
        # navigation boundary and, unlike returning to the obscured main window,
        # does not require a window manager in the nested display.
        drv.click(documentation.x + 65, documentation.y + 166)
        time.sleep(1.0)
        quick_start = await_named("Quick Start — Quipu Documentation")
        drv.save(artifacts / "quick-start-window.png", quick_start)
        assert quick_start.id == documentation.id, (
            f"Documentation used window 0x{documentation.id:x}, Quick Start used "
            f"0x{quick_start.id:x}; expected one singleton"
        )
        print("  both bundled pages loaded in one documentation window")


# ---- helpers ----


def expect_zoom(percent: int) -> None:
    """Assert the persisted zoom settles on `percent`.

    Waits for the value rather than sampling once, because WebKit's flush to
    sqlite is asynchronous - see xdriver.await_localstorage.
    """
    got = await_localstorage("quipu.zoom", str(percent))
    assert got == str(percent), f"zoom settled on {got}, expected {percent}"


def drive_zoom(drv: Driver, target: int, key: str, presses: int = 8) -> None:
    """Press a zoom accelerator until storage reports `target`.

    For scenarios whose claim is the *value*, never the number of presses.
    `zoom_stepping` owns "one press is one step" and must therefore keep pressing
    exactly once and asserting; here the point is only to get the app to a known
    zoom, and re-pressing is what stops a keystroke the nested X server dropped
    from being reported as "the app did not zoom". Both observed losses happened
    seconds after a dev build started, which is exactly when this scenario runs.
    """
    for _ in range(presses):
        if await_localstorage("quipu.zoom", str(target), timeout=2.5) == str(target):
            return
        drv.key(key, ("Control_L",))
    got = await_localstorage("quipu.zoom", str(target))
    assert got == str(target), f"zoom would not settle on {target} in {presses} presses; storage reports {got}"


def reset_view(drv: Driver, win: WindowInfo) -> None:
    """Return the UI to the baseline every scenario's coordinates assume.

    Run between scenarios because zoom is *global and persisted*: a scenario that
    finishes at 80% rescales the whole webview, so the next scenario's clicks
    land on the wrong widgets. That is how a passing rename scenario started
    renaming b.yar instead of a.yar when run after the zoom scenarios - the
    fixture leaked, the app was fine.
    """
    drv.key("Escape")
    time.sleep(0.2)
    drv.key("0", ("Control_L",))  # zoom back to exactly 100%
    time.sleep(0.6)
    Menu(drv, win).activate("View", LABEL_INDEX["view.reset-layout"], settle=0.8)


def open_workspace(
    drv: Driver, win: WindowInfo, ws: Path, artifacts: Path | None = None, attempts: int = 3
) -> None:
    """Open the scratch workspace through File > Open Folder.

    Retries, and always leaves the chooser closed. Both matter: typing a path
    through XTEST is the least reliable gesture in the suite, and a single
    mistype used to take the whole run down with it. The chooser is *modal*, so a
    failed attempt that left it open swallowed every subsequent click - one
    corrupted path showed up as four scenarios failing at Open Folder plus
    `zoom_stepping` reporting "zoom settled on 100, expected 110", none of which
    had anything to do with the app. Retrying converts that into a slower pass;
    dismissing on the way out keeps a genuine failure local to this scenario.

    Each failed attempt captures the chooser to `artifacts`, because the reason
    an attempt failed is visible in its location bar and nowhere else - the
    post-failure screenshot the runner takes is of the main window, by which time
    the chooser has been dismissed.
    """
    if getattr(open_workspace, "_done", None) == str(ws):
        return
    reason = ""
    for attempt in range(1, attempts + 1):
        reason = _open_folder_once(drv, win, ws)
        if reason is None:
            open_workspace._done = str(ws)  # noqa: SLF001
            return
        print(f"  Open Folder attempt {attempt}/{attempts} failed: {reason}")
        if artifacts is not None:
            chooser = _find_chooser(drv)
            if chooser is not None:
                drv.save(artifacts / f"chooser-attempt{attempt}.png", chooser, scale=2)
        _dismiss_chooser(drv)
    raise AssertionError(f"Open Folder did not load {ws} in {attempts} attempts; last: {reason}")


def _find_chooser(drv: Driver) -> WindowInfo | None:
    return next((w for w in drv.toplevels() if w.name == "Select Folder"), None)


def _dismiss_chooser(drv: Driver) -> None:
    """Close the folder chooser if it is open, so it cannot swallow later input."""
    for _ in range(3):
        chooser = _find_chooser(drv)
        if chooser is None:
            return
        drv.click(chooser.x + chooser.width // 2, chooser.y + chooser.height // 2)
        time.sleep(0.3)
        drv.key("Escape")
        time.sleep(1.0)


def _paste_folder_path(drv: Driver, ws: Path) -> str | None:
    """Paste one path, returning an attempt failure when GTK misses Ctrl+V."""
    env = {**os.environ, "DISPLAY": drv.display_name}
    owner = subprocess.Popen(
        ["xclip", "-selection", "clipboard", "-i", "-quiet", "-loops", "1"],
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        env=env,
        text=True,
    )
    try:
        assert owner.stdin is not None
        owner.stdin.write(f"{ws}/")
        owner.stdin.close()
        time.sleep(0.1)
        drv.key("v", ("Control_L",))
        try:
            code = owner.wait(timeout=2)
        except subprocess.TimeoutExpired:
            return "clipboard owner received no paste request; Ctrl+V may have been dropped"
        stderr = owner.stderr.read() if owner.stderr is not None else ""
        if code != 0:
            return f"xclip could not provide the folder path: {stderr.strip()}"
        return None
    finally:
        if owner.poll() is None:
            owner.terminate()
            try:
                owner.wait(timeout=2)
            except subprocess.TimeoutExpired:
                owner.kill()
                owner.wait(timeout=2)


def _open_folder_once(drv: Driver, win: WindowInfo, ws: Path) -> str | None:
    """One Open Folder attempt. Returns None on success, else why it failed.

    The GTK folder chooser is driven by pasting a path into its location bar
    (Ctrl+L), which is far more stable than clicking through the file list. These
    hazards were all hit while building this:

    * The chooser needs a click to take focus before Ctrl+L reaches it.
    * Character-by-character XTEST input can be dropped and interacts badly
      with inline path completion, so the already-required X clipboard supplies
      the complete isolated path in one paste.
    * GTK may use the first Return to navigate to the typed directory rather
      than choose it. When the chooser remains open we activate its Open button
      explicitly before deciding the path was mistyped.
    * Even with those handled, the X server can drop or duplicate the odd
      keystroke when the machine is loaded, which is why the caller retries.
    """
    Menu(drv, win).activate("File", LABEL_INDEX["file.open-folder"], settle=2.5)
    chooser = _find_chooser(drv)
    if chooser is None:
        return "Open Folder did not raise a Select Folder dialog"
    drv.click(chooser.x + chooser.width // 2, chooser.y + chooser.height // 2)
    time.sleep(0.4)
    drv.key("l", ("Control_L",))
    time.sleep(0.7)
    # Select whatever a previous attempt left behind so the paste replaces it.
    drv.key("a", ("Control_L",))
    time.sleep(0.2)
    if failure := _paste_folder_path(drv, ws):
        return failure
    time.sleep(0.6)
    drv.key("Return")
    time.sleep(1.0)
    chooser = _find_chooser(drv)
    if chooser is not None:
        # In SELECT_FOLDER mode GTK commonly treats Return in the location bar
        # as "navigate here". Open is intentionally addressed relative to the
        # chooser's lower-right corner, independently of the host resolution.
        drv.click(chooser.x + chooser.width - 90, chooser.y + chooser.height - 24)
    time.sleep(3.0)
    if _find_chooser(drv) is not None:
        return f"chooser stayed open; {ws} was probably mistyped"

    # Confirm the folder actually loaded rather than assuming the dialog closing
    # meant success. A mistyped path closes the chooser and opens nothing, which
    # otherwise surfaces later as a baffling "Save did nothing" failure.
    explorer = drv.grab(drv.main_window(), box=EXPLORER_LIST_BOX)
    if mean_luminance(explorer, (0, 0) + EXPLORER_LIST_BOX[2:]) < 20:
        return "explorer is empty after Open Folder; path likely mistyped"
    return None


def activate_file(drv: Driver, win: WindowInfo, name: str) -> None:
    """Single-click a file in the explorer by its row order.

    Files list alphabetically, so row order is derivable from the directory.
    Double-click is the rename gesture - do not use it to activate.
    """
    order = sorted(p.name for p in Path(open_workspace._done).glob("*.yar"))
    if name not in order:
        raise AssertionError(f"{name} is not in the workspace; have {order}")
    row = order.index(name)
    drv.click(60, 148 + row * 24)
    time.sleep(0.8)


def _invalidate_workspace_memo() -> None:
    """Force the next open_workspace() to re-open the folder.

    Needed after a scenario changes the file set, since the explorer's row order
    is what activate_file() addresses by.
    """
    if hasattr(open_workspace, "_done"):
        del open_workspace._done  # noqa: SLF001


activate_file.invalidate = _invalidate_workspace_memo  # noqa: SLF001


# ---- scenarios needing their own app lifecycle ----
#
# These run outside the shared session because they restart the app. Kept out of
# SCENARIOS so the normal fan-out stays in one process.


def _trace_records(path: Path) -> list[dict]:
    """Read the complete JSONL records currently published in an app log.

    Cargo/GTK may share the file with the trace, and the writer can be between
    bytes while this samples it, so non-JSON and incomplete lines are ignored.
    The next sample sees the completed record.
    """
    if not path.exists():
        return []
    records = []
    for line in path.read_text(errors="replace").splitlines():
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if record.get("schema") == "quipu-debug-v1":
            records.append(record)
    return records


def _await_trace(path: Path, predicate, description: str, timeout: float = 180.0) -> list[dict]:
    """Wait for an observable trace fact, never a guessed operation duration."""
    deadline = time.monotonic() + timeout
    records = []
    while time.monotonic() < deadline:
        records = _trace_records(path)
        if predicate(records):
            return records
        time.sleep(0.05)
    tail = records[-12:]
    raise AssertionError(f"timed out waiting for {description}; trace tail: {tail}")


def _frontend(records: list[dict], event: str) -> list[dict]:
    return sorted(
        [record for record in records if record.get("layer") == "frontend" and record.get("event") == event],
        key=lambda record: record.get("sequence", 0),
    )


def restoration_catch_up_overtakes_initial(artifacts: Path, server: str, mode: str) -> None:
    """A coverage catch-up may win the view while the initial hit still settles.

    This creates a real portable cache through the UI, restarts under the same
    isolated XDG profile, and lets normal watcher coverage create B. No delay or
    test hook is used to order A and B: an 8,000-rule repository-local fixture
    makes the portable restore long enough for the ordinary 150 ms coverage
    window to expire. Trace events, rather than sleeps, decide when each phase is
    complete and prove which response actually won.
    """
    profile = Profile()
    xs = None
    app = None
    drv = None
    try:
        ws = make_workspace(profile.workspace)
        generated = "\n".join(
            f'rule generated_{number:05d} {{ strings: $a = "token_{number:05d}" condition: $a }}'
            for number in range(8_000)
        )
        (ws / "a.yar").write_text(generated + "\n")
        xs = XServer(kind=server).start()

        first_log = profile.root / "compile.jsonl"
        app = App(xs.display, profile, mode=mode, log=first_log, debug=True).start()
        drv = Driver(xs.display)
        win = drv.wait_for_window(timeout=120.0)
        _await_trace(
            first_log,
            lambda records: bool(_frontend(records, "debug_mode_confirmed")),
            "frontend debug confirmation",
        )
        drv.click(win.x + win.width // 2, win.y + win.height // 2)
        open_workspace(drv, win, ws, artifacts, attempts=5)
        _await_trace(
            first_log,
            lambda records: any(
                event.get("fields", {}).get("next") == "not-compiled"
                for event in _frontend(records, "build_state_transition")
            ),
            "the uncached opening to settle",
        )
        Menu(drv, win).activate("Rules", LABEL_INDEX["rules.compile"], settle=0.1)
        first = _await_trace(
            first_log,
            lambda records: any(
                event.get("fields", {}).get("command") == "compile_project"
                and event.get("fields", {}).get("ok") is True
                for event in records
                if event.get("layer") == "backend" and event.get("event") == "command_responded"
            ) and any(
                event.get("fields", {}).get("next") == "compiled"
                for event in _frontend(records, "build_state_transition")
            ),
            "successful cache-producing compile",
        )
        compiled = [
            event
            for event in _frontend(first, "build_state_transition")
            if event.get("fields", {}).get("next") == "compiled"
        ]
        assert compiled, "compile command succeeded without the frontend reaching compiled"
        metadata = list(profile.cache_home.rglob("metadata.json"))
        artifacts_on_disk = list(profile.cache_home.rglob("rules-*.yarc"))
        assert len(metadata) == 1 and len(artifacts_on_disk) == 1, (
            f"expected one committed cache entry, got {len(metadata)} metadata and "
            f"{len(artifacts_on_disk)} artifacts"
        )

        drv.close()
        drv = None
        app.stop()
        app = None
        activate_file.invalidate()

        second_log = profile.root / "restore.jsonl"
        app = App(xs.display, profile, mode=mode, log=second_log, debug=True).start()
        drv = Driver(xs.display)
        win = drv.wait_for_window(timeout=120.0)
        _await_trace(
            second_log,
            lambda records: bool(_frontend(records, "debug_mode_confirmed")),
            "restarted frontend debug confirmation",
        )
        drv.click(win.x + win.width // 2, win.y + win.height // 2)
        open_workspace(drv, win, ws, artifacts, attempts=5)

        def corrected_interleaving(records: list[dict]) -> bool:
            decisions = _frontend(records, "restoration_decision")
            opens = _frontend(records, "lsp_document_opened")
            return any(
                event.get("fields", {}).get("decision") == "compiled"
                and event.get("fields", {}).get("viewAccepted") is False
                for event in decisions
            ) and bool(opens)

        restored = _await_trace(
            second_log,
            corrected_interleaving,
            "catch-up B to win the view and restoring A to settle the cache hit",
        )
        accepts = _frontend(restored, "analysis_accept")
        accepted_b = next(
            event for event in accepts
            if event.get("fields", {}).get("order") == 2
            and event.get("fields", {}).get("accepted") is True
        )
        rejected_a = next(
            event for event in accepts
            if event.get("fields", {}).get("order") == 1
            and event.get("fields", {}).get("accepted") is False
        )
        assert accepted_b["sequence"] < rejected_a["sequence"], "A did not lose view order to B"
        assert any(
            event.get("fields", {}).get("catchUp") is True
            for event in _frontend(restored, "watch_notice_received")
        ), "B was not a watcher coverage catch-up"
        assert any(
            event.get("fields", {}).get("next") == "compiled"
            and event.get("fields", {}).get("reason") == "restoration_hit"
            for event in _frontend(restored, "build_state_transition")
        ), "the build state did not leave Checking compiled cache for compiled"
        auto_started = _frontend(restored, "document_auto_open_started")
        auto_completed = _frontend(restored, "document_auto_open_completed")
        assert len(auto_started) == 1 and len(auto_completed) == 1, (
            "the selection did not claim automatic document opening exactly once"
        )
        project_lsp_opens = [
            event for event in _frontend(restored, "lsp_document_opened")
            if auto_started[0]["sequence"] < event["sequence"] < auto_completed[0]["sequence"]
        ]
        assert len(project_lsp_opens) == 1, "the first project document did not reach the LSP once"
        encoded = "\n".join(json.dumps(record, sort_keys=True) for record in restored)
        assert str(profile.root) not in encoded and "token_00000" not in encoded, (
            "the structured trace leaked a fixture path or source text"
        )
        print(
            "  B(order 2) won the view; A(order 1) applied a current hit; "
            "build=compiled; project LSP opens=1"
        )
    finally:
        activate_file.invalidate()
        if drv is not None:
            try:
                drv.close()
            except Exception:  # noqa: BLE001 - teardown must continue regardless
                pass
        if app is not None:
            app.stop()
        if xs is not None:
            xs.stop()
        profile.close()


def zoom_survives_restart(artifacts: Path, server: str, mode: str) -> None:
    """A zoom set in one session is applied on the next startup.

    The restore path is what the user actually notices, and it only runs at load
    time - so it cannot be tested without a second process.

    Storage alone is not enough evidence here: `quipu.zoom` reading 80 only proves
    the *write* half, which `zoom_persistence` already covers. What this scenario
    has to show is that the value was read back and applied to the webview. So it
    also compares rendered text-row positions in the webview against a 100%
    baseline captured in the first session, and asserts they moved by roughly the
    zoom ratio rather than merely differing - "differs" would also pass if the
    content had simply reflowed.

    Both launches share ONE temporary profile, created here and removed only once
    the second has finished. That is the whole mechanism: a per-session profile
    would hand the second process an empty XDG data home, there would be nothing
    to restore, and the scenario would fail while the app was working correctly.
    """
    profile = Profile()
    try:
        with quipu_session(server=server, mode=mode, profile=profile, reset_state=True) as (drv, win, ws):
            # drive_zoom rather than a fixed number of presses: this scenario is
            # about restoring a value, not about stepping, and a dropped keystroke
            # here used to surface as "zoom settled on 100, expected 80" - a
            # harness failure wearing an application failure's clothes.
            drive_zoom(drv, 100, "0")
            baseline = text_rows(drv.grab(win, box=ZOOM_PROBE_STRIP))
            drv.save(artifacts / "zoom-100-baseline.png", win, box=ZOOM_PROBE_STRIP)
            drive_zoom(drv, 80, "minus")

        # reset_state=False on the same profile is the point: keep the store the
        # first session left, in the same isolated data home.
        with quipu_session(server=server, mode=mode, profile=profile, reset_state=False) as (drv, win, ws):
            got = await_localstorage("quipu.zoom", "80")
            assert got == "80", f"restarted session reports zoom {got}, expected 80"

            restored = text_rows(drv.grab(win, box=ZOOM_PROBE_STRIP))
            drv.save(artifacts / "zoom-80-restored.png", win, box=ZOOM_PROBE_STRIP)
            assert baseline and restored, f"no text found in the probe strip ({baseline=}, {restored=})"

            # Row tops are measured from the top of the strip, which is the top of
            # the webview, so they scale about linearly with the zoom factor.
            # Compare the last common row: the further down the strip, the larger
            # the absolute shift and the less a 1px band-detection wobble matters.
            n = min(len(baseline), len(restored))
            at_100, at_80 = baseline[n - 1][0], restored[n - 1][0]
            ratio = at_80 / at_100 if at_100 else 0.0
            assert 0.72 <= ratio <= 0.88, (
                f"webview text at row {n - 1} sits at y={at_80} after restart vs y={at_100} at 100% "
                f"(ratio {ratio:.2f}); expected about 0.80, so the persisted zoom was not applied on load"
            )
            print(f"  restarted at 80%: storage agrees and rows scaled {at_100} -> {at_80} (x{ratio:.2f})")
    finally:
        profile.close()


def about_links_open_externally(artifacts: Path, server: str, mode: str) -> None:
    """The About credit links open in the OS browser and never navigate the webview.

    This guards a failure that would be severe and is easy to reintroduce. Quipu
    installs no navigation handler, so an ordinary <a href> click loads the remote
    page *into the app's own webview*: the entire UI is replaced, with no back
    button and no recovery short of a restart. The fix is a click handler that
    calls the opener plugin, and nothing in the DOM makes it obvious whether that
    handler is still attached.

    Both halves are checked, because either alone is satisfiable by a bug. That
    the right URL reached the OS proves the handler ran; that the window is
    unchanged proves the default navigation was suppressed.

    An `xdg-open` shim on PATH stands in for the browser - the `open` crate tries
    xdg-open first on Unix. That keeps the assertion exact (it records the URL
    verbatim) and avoids launching a real browser inside the nested display. It
    has to be in place before the app starts, which is why this scenario owns its
    own session.
    """
    shim_dir = Path("/tmp/quipu-ui-shim")
    log = shim_dir / "opened-urls.log"
    shim_dir.mkdir(parents=True, exist_ok=True)
    shim = shim_dir / "xdg-open"
    shim.write_text(f'#!/bin/sh\nprintf "%s\\n" "$1" >> {log}\nexit 0\n')
    shim.chmod(0o755)
    log.unlink(missing_ok=True)

    original_path = os.environ["PATH"]
    os.environ["PATH"] = f"{shim_dir}:{original_path}"
    try:
        with quipu_session(server=server, mode=mode, reset_state=True) as (drv, win, ws):
            drv.click(600, 600)  # focus the window before driving the menu
            time.sleep(1.0)
            Menu(drv, win).activate("Help", LABEL_INDEX["help.about"], settle=1.5)
            before = drv.grab(win)
            drv.save(artifacts / "about-links.png", win)

            links = colour_spans(before.crop(_as_pil_box(ABOUT_DIALOG_BOX)), LINK_RGB)
            assert len(links) == 2, f"expected 2 link-coloured runs in the About dialog, found {len(links)}"

            for box in links:  # left to right: Corelight, then YARA-X
                lx, ly = centre(box)
                drv.click(ABOUT_DIALOG_BOX[0] + lx, ABOUT_DIALOG_BOX[1] + ly)
                time.sleep(2.0)

            after = drv.grab(win)
            drv.save(artifacts / "about-links-after.png", win)
            # Unchanged dialog region == the webview did not navigate. A real
            # navigation repaints the whole window, so this moves by far more
            # than the couple of units of capture noise.
            moved = abs(mean_luminance(before, ABOUT_DIALOG_BOX) - mean_luminance(after, ABOUT_DIALOG_BOX))
            assert moved < 5, f"the window changed by {moved:.1f} after clicking a link; did the webview navigate?"

        opened = log.read_text().split() if log.exists() else []
        assert opened == [CORELIGHT_URL, YARA_X_URL], f"handed these URLs to the OS: {opened}"
        print(f"  both links opened externally, UI unchanged (delta {moved:.1f})")
    finally:
        os.environ["PATH"] = original_path


def report_issue_opens_externally(artifacts: Path, server: str, mode: str) -> None:
    """Report an Issue hands the exact issue-chooser URL to the OS browser.

    As with the About-link scenario, an xdg-open shim records what the opener
    plugin gives the operating system. It must be installed before the app starts.
    """
    shim_dir = Path("/tmp/quipu-ui-report-issue-shim")
    log = shim_dir / "opened-urls.log"
    shim_dir.mkdir(parents=True, exist_ok=True)
    shim = shim_dir / "xdg-open"
    shim.write_text(f'#!/bin/sh\nprintf "%s\\n" "$1" >> {log}\nexit 0\n')
    shim.chmod(0o755)
    log.unlink(missing_ok=True)

    original_path = os.environ["PATH"]
    os.environ["PATH"] = f"{shim_dir}:{original_path}"
    try:
        with quipu_session(server=server, mode=mode, reset_state=True) as (drv, win, _ws):
            drv.click(600, 600)
            time.sleep(1.0)
            Menu(drv, win).activate("Help", LABEL_INDEX["help.report-issue"], settle=2.0)
            drv.save(artifacts / "report-issue-opened.png", win)

        opened = log.read_text().splitlines() if log.exists() else []
        assert opened == [REPORT_ISSUE_URL], f"handed these URLs to the OS: {opened}"
        print(f"  opened externally: {REPORT_ISSUE_URL}")
    finally:
        os.environ["PATH"] = original_path


def _dialog(drv: Driver, main: WindowInfo, timeout: float = 8.0) -> WindowInfo | None:
    """The modal confirmation, or None if none is up within `timeout`.

    The dialog plugin's confirmation is a native GTK message dialog of its own, so
    "a viewable window smaller than the application window" identifies it. Menu
    popups do not confuse that: muda keeps them after closing but unmaps them, and
    `toplevels()` reports only viewable ones. (`window.confirm` would have no window
    at all here - it displays nothing in this webview, which is the defect these
    scenarios exist to catch.)
    """
    deadline = time.time() + timeout
    while True:
        for w in drv.toplevels():
            if w.id == main.id or w.width * w.height < 4000:
                continue
            if w.width < main.width or w.height < main.height:
                return w
        if time.time() >= deadline:
            return None
        time.sleep(0.2)


def quit_guards_unsaved_work(artifacts: Path, server: str, mode: str) -> None:
    """Quit asks before losing unsaved work, and cancelling really keeps the app.

    The only place the *wiring* is exercised. `app/src/closing.ts` and its tests
    settle what the guard decides; what they cannot show is that File > Quit is
    connected to it, that the close listener is installed on the real window, and
    that Cancel leaves a live application rather than one that has already
    dismantled itself. Each of those is a way for the feature to be entirely
    absent while every unit test passes.

    The work at risk is deliberately the scratch buffer with no folder open: it is
    the case with no file to recover from, and the one a Quit reusing the workspace
    switch's at-risk list would discard without a word.

    Evidence, in both halves: after Cancel the app process is still running, its
    window is still there and its menus still open, and after confirming the
    window goes and the process exits. This scenario owns its session because it
    ends by terminating the application, and it holds the process handle so that
    "the app survived" is a claim about the process rather than about a repaint.

    Keyboard rather than button coordinates: Escape and Return are GTK's own
    bindings for a message dialog's cancel and default responses, and there is no
    window manager here, so the pointer is moved onto the dialog first - keyboard
    input follows it.
    """
    profile = Profile()
    xs = None
    app = None
    drv = None
    try:
        xs = XServer(kind=server).start()
        reset_persisted_state(profile.data_home)
        app = App(xs.display, profile, mode=mode).start()
        make_workspace(profile.workspace)
        drv = Driver(xs.display)
        win = drv.wait_for_window(timeout=120.0)
        time.sleep(3)  # let the webview paint and the menu install
        drv.click(win.x + win.width // 2, win.y + win.height // 2)
        time.sleep(0.5)

        # Make work that exists nowhere but the editor. The scratch buffer has no
        # path, so this text cannot be saved and nothing on disk holds a copy.
        drv.click(*EDITOR_CLICK)
        time.sleep(0.3)
        drv.type_text("// unsaved")
        time.sleep(0.5)

        menu = Menu(drv, win)
        menu.activate("File", LABEL_INDEX["file.quit"], settle=1.5)
        asked = _dialog(drv, win)
        assert asked is not None, "File > Quit did not ask about the unsaved scratch buffer"
        drv.save(artifacts / "quit-confirmation.png", asked)
        print(f"  Quit asked first ({asked.width}x{asked.height} dialog)")

        drv.move(*centre((asked.x, asked.y, asked.width, asked.height)))
        drv.key("Escape")
        time.sleep(1.5)

        assert app.proc.poll() is None, "cancelling Quit still terminated the application"
        alive = drv.main_window()
        assert alive.id == win.id, "the window was replaced rather than kept"
        # Still usable, not merely still mapped: a menu that opens is the whole
        # frontend answering.
        popup, bands = menu.rows("File")
        drv.key("Escape")
        time.sleep(0.3)
        assert len(bands) == 9, f"File shows {len(bands)} labels after a cancelled Quit"
        print("  cancelled: process alive, window kept, menus working")

        # Now the same gesture, confirmed.
        menu.activate("File", LABEL_INDEX["file.quit"], settle=1.5)
        again = _dialog(drv, win)
        assert again is not None, "the second Quit asked nothing, though the work was still at risk"
        # Clicked rather than typed: the dialog is Cancel | OK across the bottom with
        # no default response focused, so Return does nothing. OK is the right-hand
        # half of that row, addressed proportionally so a wider dialog still hits it.
        drv.click(again.x + (again.width * 3) // 4, again.y + again.height - 14)

        deadline = time.time() + 20.0
        while time.time() < deadline and app.proc.poll() is None:
            time.sleep(0.5)
        assert app.proc.poll() is not None, "confirming Quit did not terminate the application"
        assert not [w for w in drv.toplevels() if w.name == "Quipu"], "the window outlived the process"
        print("  confirmed: window closed and the process exited")
    finally:
        if drv is not None:
            try:
                drv.close()
            except Exception:  # noqa: BLE001 - teardown must continue regardless
                pass
        if app is not None:
            app.stop()  # a no-op beyond reaping when the confirmed Quit worked
        if xs is not None:
            xs.stop()
        profile.close()


def _project_listed(drv: Driver, pristine: Image.Image) -> bool:
    """Whether the explorer is listing a project's files, rather than its placeholder.

    Compared pixel for pixel against the same window captured before any folder was
    opened, because neither an ink threshold nor a mean-luminance comparison can
    tell these two states apart: with no project open the explorer still says "No
    folder open" and "Open a folder to begin", which is about as much ink, at about
    the same average, as three file rows. Both would read a workspace that never
    closed as closed.
    """
    return changed_fraction(pristine, drv.grab(drv.main_window()), EXPLORER_LIST_BOX) > 0.02


def _choose_folder(drv: Driver, win: WindowInfo, ws: Path) -> str | None:
    """Drive File > Open Folder as far as choosing `ws`, without waiting for it to load.

    open_workspace() cannot be reused for this half: it checks that the folder
    loaded, and here it deliberately must not, because a confirmation is standing
    between the choice and the switch. The keystrokes are the same ones and carry
    the same hazards - see _open_folder_once for what each is for.
    """
    Menu(drv, win).activate("File", LABEL_INDEX["file.open-folder"], settle=2.5)
    chooser = _find_chooser(drv)
    if chooser is None:
        return "Open Folder did not raise a Select Folder dialog"
    drv.click(chooser.x + chooser.width // 2, chooser.y + chooser.height // 2)
    time.sleep(0.4)
    drv.key("l", ("Control_L",))
    time.sleep(0.7)
    drv.key("a", ("Control_L",))
    time.sleep(0.2)
    if failure := _paste_folder_path(drv, ws):
        return failure
    time.sleep(0.6)
    drv.key("Return")
    time.sleep(2.0)
    if _find_chooser(drv) is not None:
        return f"chooser stayed open; {ws} was probably mistyped"
    return None


def _approve(drv: Driver, dialog: WindowInfo) -> None:
    """Click OK on a native message dialog.

    Clicked rather than typed: the dialog is Cancel | OK across the bottom with no
    default response focused, so Return does nothing. OK is the right-hand half of
    that row, addressed proportionally so a wider dialog still hits it.
    """
    drv.click(dialog.x + (dialog.width * 3) // 4, dialog.y + dialog.height - 14)


def close_workspace_confirms_discard(artifacts: Path, server: str, mode: str) -> None:
    """Leaving a project asks about unsaved work in a window the user can see.

    The defect this is here for is invisible to every unit test: `window.confirm`
    displays nothing in this webview and returns true, so a guard built on it
    discards the file without a word while every test that stubs the confirmation
    passes. Only the real dialogue on the real display can show that it is there.

    Both native routes out of a project are driven - Open Folder, which asks after
    its picker, and Close Workspace - because they share one gate and a wiring
    mistake would be per call site. The evidence in each half is that a cancelled
    departure left the same project with the same text, and that the menus still
    work, since an awaited confirmation that had already superseded the session
    would leave a half-dismantled window looking much the same.

    Its own session: it ends with no project open, and the shared-session
    scenarios address the explorer by row order.
    """
    try:
        with quipu_session(server=server, mode=mode, reset_state=True) as (drv, win, ws):
            # What "no project open" looks like, recorded before one ever was. It is
            # the reference _project_listed() reads against; see there for why an ink
            # threshold will not do.
            pristine = drv.grab(win)
            drv.click(win.x + win.width // 2, win.y + win.height // 2)
            time.sleep(0.5)
            open_workspace(drv, win, ws, artifacts)
            activate_file(drv, win, "a.yar")
            assert _project_listed(drv, pristine), "the workspace never opened, so nothing is at risk"

            # Work that only the editor has. a.yar is on disk, so this is the
            # ordinary case: a departure must offer to keep it.
            drv.click(*EDITOR_CLICK)
            time.sleep(0.3)
            drv.type_text("// unsaved edit")
            time.sleep(0.8)
            before = drv.grab(win)
            drv.save(artifacts / "departure-dirty.png", win)

            # ---- Open Folder: asked after the picker, cancelled ----
            reason = None
            for attempt in range(1, 4):
                reason = _choose_folder(drv, win, ws)
                if reason is None:
                    break
                print(f"  Open Folder attempt {attempt}/3: {reason}")
                _dismiss_chooser(drv)
            assert reason is None, f"could not choose a folder to be asked about: {reason}"
            asked = _dialog(drv, win)
            assert asked is not None, "Open Folder switched projects without asking about unsaved work"
            drv.save(artifacts / "open-folder-confirmation.png", asked)
            drv.move(*centre((asked.x, asked.y, asked.width, asked.height)))
            drv.key("Escape")
            time.sleep(1.5)
            assert _project_listed(drv, pristine), "cancelling Open Folder closed the project anyway"
            kept = abs(mean_luminance(before, EDITOR_TEXT_BOX) - mean_luminance(drv.grab(win), EDITOR_TEXT_BOX))
            assert kept < 5, f"the editor changed by {kept:.1f} after a cancelled Open Folder"
            print(f"  Open Folder asked ({asked.width}x{asked.height}); cancelling kept the project")

            # ---- Close Workspace: cancelled, then approved ----
            menu = Menu(drv, win)
            menu.activate("File", LABEL_INDEX["file.close-workspace"], settle=1.5)
            asked = _dialog(drv, win)
            assert asked is not None, "Close Workspace discarded unsaved work without asking"
            drv.save(artifacts / "close-workspace-confirmation.png", asked)
            drv.move(*centre((asked.x, asked.y, asked.width, asked.height)))
            drv.key("Escape")
            time.sleep(1.5)

            assert _project_listed(drv, pristine), "cancelling Close Workspace closed the project anyway"
            kept = abs(mean_luminance(before, EDITOR_TEXT_BOX) - mean_luminance(drv.grab(win), EDITOR_TEXT_BOX))
            assert kept < 5, f"the editor changed by {kept:.1f} after a cancelled Close Workspace"
            popup, bands = menu.rows("File")
            drv.key("Escape")
            time.sleep(0.3)
            assert len(bands) == 9, f"File shows {len(bands)} labels after a cancelled close"
            drv.save(artifacts / "close-workspace-cancelled.png", win)
            print("  Close Workspace asked; cancelling kept the project, text and menus")

            menu.activate("File", LABEL_INDEX["file.close-workspace"], settle=1.5)
            again = _dialog(drv, win)
            assert again is not None, "the second Close Workspace asked nothing, though the work was still at risk"
            _approve(drv, again)
            time.sleep(3.0)
            drv.save(artifacts / "close-workspace-approved.png", win)
            assert _dialog(drv, win, timeout=1.0) is None, "the confirmation is still up after OK"
            assert not _project_listed(drv, pristine), (
                "the approved close left the project's files in the explorer"
            )
            # And the discarded work is gone rather than merely off screen: the
            # editor is back to the scratch buffer the app started with.
            assert changed_fraction(pristine, drv.grab(win), EDITOR_TEXT_BOX) < 0.02, (
                "the editor still holds the project's text after the workspace closed"
            )
            print("  approved: the workspace closed and the editor returned to scratch")
    finally:
        # The next scenario in this process must open the folder again: this one
        # closed it, and activate_file() addresses rows by the explorer's order.
        activate_file.invalidate()


def _as_pil_box(box: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    """(x, y, w, h) -> (left, upper, right, lower), which is what PIL crop wants."""
    x, y, w, h = box
    return x, y, x + w, y + h


LIFECYCLE_SCENARIOS = {
    "restoration_catch_up_overtakes_initial": restoration_catch_up_overtakes_initial,
    "zoom_survives_restart": zoom_survives_restart,
    "about_links_open_externally": about_links_open_externally,
    "report_issue_opens_externally": report_issue_opens_externally,
    "quit_guards_unsaved_work": quit_guards_unsaved_work,
    "close_workspace_confirms_discard": close_workspace_confirms_discard,
    "preferences_dialog": preferences_dialog,
    "documentation_window": documentation_window,
}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("names", nargs="*", help="scenario names to run")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--server", choices=SERVER_CHOICES, default="auto")
    ap.add_argument("--mode", choices=("dev", "release"), default="dev")
    ap.add_argument("--artifacts", type=Path, default=Path("/tmp/quipu-ui-artifacts"))
    args = ap.parse_args()

    everything = {**SCENARIOS, **LIFECYCLE_SCENARIOS}
    if args.list:
        for name, fn in everything.items():
            kind = "(restarts app)" if name in LIFECYCLE_SCENARIOS else ""
            print(f"{name:28} {kind:15} {(fn.__doc__ or '').splitlines()[0]}")
        return 0

    chosen = list(everything) if args.all else args.names
    if not chosen:
        ap.error("name at least one scenario, or pass --all / --list")
    unknown = [n for n in chosen if n not in everything]
    if unknown:
        ap.error(f"unknown scenario(s): {', '.join(unknown)}")

    server = resolve_server(args.server)
    policy = "automatic" if args.server == "auto" else "explicit"
    print(f"[display] {server} ({policy})")

    args.artifacts.mkdir(parents=True, exist_ok=True)
    failures: list[tuple[str, BaseException]] = []
    shared = [n for n in chosen if n in SCENARIOS]
    lifecycle = [n for n in chosen if n in LIFECYCLE_SCENARIOS]

    if shared:
        with quipu_session(server=server, mode=args.mode) as (drv, win, ws):
            for name in shared:
                print(f"[{name}]")
                try:
                    reset_view(drv, win)
                    SCENARIOS[name](drv, win, ws, args.artifacts)
                    print(f"  PASS {name}")
                except BaseException as err:  # noqa: BLE001 - one scenario must not abort the run
                    failures.append((name, err))
                    drv.save(args.artifacts / f"FAIL-{name}.png", win)
                    print(f"  FAIL {name}: {err}")

    for name in lifecycle:  # each manages its own app processes
        print(f"[{name}]")
        try:
            LIFECYCLE_SCENARIOS[name](args.artifacts, server, args.mode)
            print(f"  PASS {name}")
        except BaseException as err:  # noqa: BLE001
            failures.append((name, err))
            print(f"  FAIL {name}: {err}")

    print(f"\n{len(chosen) - len(failures)}/{len(chosen)} passed; artifacts in {args.artifacts}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
