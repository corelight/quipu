#!/usr/bin/env python3
"""X11 driving and observation primitives for Quipu UI tests.

Quipu's menu bar is a *native* GTK menu created through muda, so it is invisible
to WebDriver and to anything that only sees the webview DOM. The only way to
exercise it end to end is to synthesise real input at the X server and observe
the result. This module is the reusable half of that: input synthesis, window
discovery, screen capture, and the objective probes that make assertions about
things a screenshot cannot prove (what was written to disk, what was persisted
to localStorage, whether a widget is enabled).

Nothing here knows about Quipu's layout or coordinates. Scenario scripts own
that, because it is the part that rots when the UI changes.

Requires: python3-xlib, python3-pil. Talks to $DISPLAY; run it against a nested
or virtual server (see session.py) so synthesised clicks cannot land on the
developer's real desktop.
"""

from __future__ import annotations

import ctypes
import os
import select
import struct
import sqlite3
import time
from dataclasses import dataclass
from glob import glob
from pathlib import Path

from PIL import Image
from Xlib import X, XK, display
from Xlib.ext import xtest

# Keysym names for characters whose name is not the character itself. Anything
# absent falls through to the character, with Shift added for capitals.
_KEYSYMS = {
    " ": "space",
    "/": "slash",
    "\\": "backslash",
    "_": "underscore",
    ".": "period",
    ",": "comma",
    "-": "minus",
    "=": "equal",
    ":": "colon",
    ";": "semicolon",
    "$": "dollar",
    '"': "quotedbl",
    "'": "apostrophe",
    "(": "parenleft",
    ")": "parenright",
    "{": "braceleft",
    "}": "braceright",
    "[": "bracketleft",
    "]": "bracketright",
    "*": "asterisk",
    "+": "plus",
    "#": "numbersign",
    "@": "at",
    "!": "exclam",
    "?": "question",
    "\n": "Return",
    "\t": "Tab",
}

# Keysyms that need Shift on a US layout, keyed by the character.
_NEEDS_SHIFT = set('~!@#$%^&*()_+{}|:"<>?')


@dataclass(frozen=True)
class WindowInfo:
    """A mapped X toplevel: its id, WM_NAME and geometry."""

    id: int
    name: str
    x: int
    y: int
    width: int
    height: int

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<0x{self.id:x} {self.name!r} {self.width}x{self.height}+{self.x}+{self.y}>"


class Driver:
    """Input synthesis and observation against one X display."""

    def __init__(self, display_name: str | None = None):
        self.display_name = display_name or os.environ.get("DISPLAY", ":0")
        self.d = display.Display(self.display_name)
        self.root = self.d.screen().root
        if self.d.query_extension("XTEST") is None:
            raise RuntimeError(f"{self.display_name} has no XTEST extension; cannot synthesise input")

    def close(self) -> None:
        self.d.close()

    # ---- input ----

    def move(self, x: int, y: int) -> None:
        xtest.fake_input(self.d, X.MotionNotify, x=int(x), y=int(y))
        self.d.sync()

    def click(self, x: int, y: int, button: int = 1, settle: float = 0.15) -> None:
        """Move, then press and release. The settle pause matters: GTK menus
        open on press and track the pointer, so clicking without letting the
        motion arrive first can activate whatever the pointer passed over."""
        self.move(x, y)
        time.sleep(settle)
        xtest.fake_input(self.d, X.ButtonPress, button)
        self.d.sync()
        time.sleep(0.05)
        xtest.fake_input(self.d, X.ButtonRelease, button)
        self.d.sync()

    def drag(self, x1: int, y1: int, x2: int, y2: int, steps: int = 12) -> None:
        """Press at the start, glide, release at the end. Splitters follow
        pointer motion, so a single jump is often ignored."""
        self.move(x1, y1)
        time.sleep(0.1)
        xtest.fake_input(self.d, X.ButtonPress, 1)
        self.d.sync()
        for i in range(1, steps + 1):
            self.move(x1 + (x2 - x1) * i // steps, y1 + (y2 - y1) * i // steps)
            time.sleep(0.02)
        xtest.fake_input(self.d, X.ButtonRelease, 1)
        self.d.sync()

    def _keycode(self, name: str) -> int:
        code = self.d.keysym_to_keycode(XK.string_to_keysym(name))
        if code == 0:
            raise ValueError(f"no keycode for keysym {name!r} on this layout")
        return code

    def key(self, name: str, mods: tuple[str, ...] = ()) -> None:
        """Press a key with modifiers held, e.g. key("s", ("Control_L",)).

        Modifier names are X keysyms: Control_L, Shift_L, Alt_L, Super_L.
        """
        held = [self._keycode(m) for m in mods]
        for m in held:
            xtest.fake_input(self.d, X.KeyPress, m)
        code = self._keycode(name)
        xtest.fake_input(self.d, X.KeyPress, code)
        self.d.sync()
        time.sleep(0.05)
        xtest.fake_input(self.d, X.KeyRelease, code)
        for m in reversed(held):
            xtest.fake_input(self.d, X.KeyRelease, m)
        self.d.sync()

    def type_text(self, text: str, delay: float = 0.04) -> None:
        for ch in text:
            name = _KEYSYMS.get(ch, ch)
            mods = ("Shift_L",) if (ch.isupper() or ch in _NEEDS_SHIFT) else ()
            self.key(name, mods)
            time.sleep(delay)

    def type_literal(self, text: str, delay: float = 0.18) -> None:
        """Type text into a widget with inline autocompletion, e.g. GTK's file
        chooser location bar (Ctrl+L).

        GTK completes a path inline once the cursor sits at end-of-text, and the
        injected text is *unselected* and *behind* the cursor, so it neither gets
        replaced by the next keystroke nor removed by Delete or Shift+End+Delete.
        Typing "/tmp/quipu-uitest-ws/" character by character produced
        "/tmp/quipu-pu-uitest-ws/": after "/tmp/qu" the entry already read
        "/tmp/quipu-" (the common prefix of the /tmp/quipu-* entries), and the
        following "p","u" appended to that. The dialog then closed having found
        nothing, which looks exactly like the app ignoring a valid path.

        The workaround: park a sentinel character at the end and type in front of
        it, so the cursor is never at end-of-text and completion never fires.
        Remove the sentinel afterwards.

        `delay` is deliberately slow. At 0.06s the nested X server dropped
        keystrokes ("qipu"), which is a subtler corruption than the completion it
        was working around.
        """
        self.key("numbersign")  # sentinel: any char that cannot start a path
        time.sleep(delay)
        self.key("Home")
        time.sleep(delay)
        for ch in text:
            name = _KEYSYMS.get(ch, ch)
            mods = ("Shift_L",) if (ch.isupper() or ch in _NEEDS_SHIFT) else ()
            self.key(name, mods)
            time.sleep(delay)
        self.key("End")
        time.sleep(delay)
        self.key("BackSpace")  # drop the sentinel
        time.sleep(delay)

    # ---- window discovery ----

    def toplevels(self) -> list[WindowInfo]:
        """Every mapped direct child of the root, innermost geometry resolved."""
        out: list[WindowInfo] = []
        net_wm_name = self.d.intern_atom("_NET_WM_NAME")
        utf8_string = self.d.intern_atom("UTF8_STRING")
        for win in self.root.query_tree().children:
            try:
                if win.get_attributes().map_state != X.IsViewable:
                    continue
                geom = win.get_geometry()
                # EWMH's UTF-8 title is authoritative. get_wm_name() reads the
                # legacy Latin-1 WM_NAME property, which turns titles containing
                # Quipu's em dash into an empty string and made a correctly
                # titled documentation window look untitled to the harness.
                modern = win.get_full_property(net_wm_name, utf8_string)
                name = (
                    bytes(modern.value).decode("utf-8", errors="replace")
                    if modern is not None
                    else (win.get_wm_name() or "")
                )
            except Exception:
                continue  # window died between the query and the fetch
            out.append(WindowInfo(win.id, name, geom.x, geom.y, geom.width, geom.height))
        return out

    def main_window(self, title: str = "Quipu", min_width: int = 600, min_height: int = 400) -> WindowInfo:
        """The application's own window.

        Matched on the exact WM_NAME first, then on size. Both halves matter:

        * Size alone is not enough. The GTK folder chooser opens *larger* than
          the app window on this display (1096x902 vs 1200x800 by area), so
          "largest toplevel" silently returns the dialog while it is open.
        * Name alone is not enough either, because muda's menu popups carry the
          app's own WM_NAME in lowercase ("quipu"), so a case-insensitive match
          picks up whichever menu is open. The title here is case-sensitive for
          that reason.
        """
        sized = [w for w in self.toplevels() if w.width >= min_width and w.height >= min_height]
        named = [w for w in sized if w.name == title]
        if named:
            return max(named, key=lambda w: w.width * w.height)
        if not sized:
            raise LookupError("no application-sized toplevel is mapped yet")
        raise LookupError(
            f"no toplevel titled {title!r}; mapped candidates: {[w.name for w in sized]}"
        )

    def open_popup(self, main: WindowInfo, min_area: int = 2000) -> WindowInfo | None:
        """The currently open GTK menu popup, or None if no menu is open.

        muda's popups are override-redirect toplevels that share the app's
        WM_NAME and are *kept* after closing rather than destroyed, so one
        popup exists per menu that has ever been opened. Only the open one is
        viewable, which is what makes this reliable; picking "the newest window
        in the tree" is not, and was the source of a misclick during manual
        testing.
        """
        cands = [
            w
            for w in self.toplevels()
            if w.id != main.id and w.width * w.height >= min_area and w.width < main.width
        ]
        if not cands:
            return None
        # If several are somehow viewable, the topmost in stacking order wins.
        return cands[0]

    def wait_for_window(self, timeout: float = 60.0, **kw) -> WindowInfo:
        deadline = time.time() + timeout
        last: Exception | None = None
        while time.time() < deadline:
            try:
                return self.main_window(**kw)
            except LookupError as err:
                last = err
                time.sleep(0.5)
        raise TimeoutError(f"no application window within {timeout}s") from last

    # ---- capture ----

    def grab(self, win: WindowInfo | None = None, box: tuple[int, int, int, int] | None = None) -> Image.Image:
        """Screenshot a window (or a region of the root) as a PIL image.

        Uses X GetImage directly rather than shelling out to xwd+ffmpeg, so the
        harness needs no external binaries and the pixels are available for
        assertions without a round trip through a file.
        """
        if win is None:
            target, x, y, w, h = self.root, 0, 0, self.d.screen().width_in_pixels, self.d.screen().height_in_pixels
        else:
            target, x, y, w, h = self.d.create_resource_object("window", win.id), 0, 0, win.width, win.height
        if box is not None:
            x, y, w, h = box
        raw = target.get_image(x, y, w, h, X.ZPixmap, 0xFFFFFFFF)
        # 24/32-bit TrueColor on this visual is little-endian BGR with a pad byte.
        return Image.frombytes("RGB", (w, h), bytes(raw.data), "raw", "BGRX")

    def save(self, path: str | Path, win: WindowInfo | None = None, scale: int = 1, **kw) -> Path:
        img = self.grab(win, **kw)
        if scale != 1:
            img = img.resize((img.width * scale, img.height * scale), Image.NEAREST)
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        img.save(path)
        return path


# ---- probes: assertions a screenshot cannot make ----


def mean_luminance(img: Image.Image, box: tuple[int, int, int, int]) -> float:
    """Average luminance of a region, 0-255.

    The trick that let us assert *enabled state* objectively: a disabled menu
    item or button renders its label at reduced contrast, so the mean luminance
    of the label's bounding box drops sharply (measured 148 -> 50 on "Scan
    Target" when it became disabled). Compare two captures of the same box
    rather than testing an absolute threshold, which is theme-dependent.
    """
    x, y, w, h = box
    crop = img.crop((x, y, x + w, y + h)).convert("L")
    pixels = list(crop.getdata())
    return sum(pixels) / len(pixels)


def differs(a: Image.Image, b: Image.Image, box: tuple[int, int, int, int], threshold: float = 12.0) -> bool:
    """Whether a region's luminance moved enough to count as a state change."""
    return abs(mean_luminance(a, box) - mean_luminance(b, box)) >= threshold


def changed_fraction(
    a: Image.Image, b: Image.Image, box: tuple[int, int, int, int], delta: int = 40
) -> float:
    """Fraction of a region's pixels whose luminance moved by more than `delta`.

    `differs` answers "did this region get brighter or darker", which is the right
    question for contrast and the wrong one for "is this still the same content":
    two different lists of text over the same background have nearly the same
    average ink, so their means agree while none of the letters do. This counts the
    pixels that actually changed, which is what distinguishes one pane's contents
    from another's.
    """
    x, y, w, h = box
    crop = (x, y, x + w, y + h)
    left = list(a.crop(crop).convert("L").getdata())
    right = list(b.crop(crop).convert("L").getdata())
    moved = sum(1 for p, q in zip(left, right) if abs(p - q) > delta)
    return moved / len(left)


def text_rows(img: Image.Image, margin: int = 6, min_ink: int = 4, min_gap: int = 3) -> list[tuple[int, int]]:
    """Find horizontal bands of text in an image, as (top, bottom) pairs.

    Menu rows are located by where the ink *is* rather than by an assumed row
    pitch. muda/GTK item height depends on theme, font and scale factor, so a
    hardcoded pitch silently drifts and, worse, quietly selects the wrong row -
    that is precisely how a manual check once activated the disabled "Includes
    View" instead of "Reset Layout".

    Separators produce no band, so the returned list indexes *visible labels*
    in order. Scenarios should therefore index by label position, not by the
    item order in menu.ts.
    """
    grey = img.convert("L")
    width, height = grey.size
    pixels = grey.load()
    # The most common value is the popup background whatever the theme is.
    counts: dict[int, int] = {}
    for y in range(height):
        for x in range(margin, width - margin, 2):
            v = pixels[x, y]
            counts[v] = counts.get(v, 0) + 1
    background = max(counts, key=lambda k: counts[k])

    inked = [
        sum(1 for x in range(margin, width - margin) if abs(pixels[x, y] - background) > 25) > min_ink
        for y in range(height)
    ]
    bands: list[tuple[int, int]] = []
    start: int | None = None
    for y, has_ink in enumerate(inked + [False]):
        if has_ink and start is None:
            start = y
        elif not has_ink and start is not None:
            if y - start >= 2:
                bands.append((start, y))
            start = None
    # Merge bands separated by less than min_gap (descenders, underlines).
    merged: list[tuple[int, int]] = []
    for band in bands:
        if merged and band[0] - merged[-1][1] < min_gap:
            merged[-1] = (merged[-1][0], band[1])
        else:
            merged.append(band)
    # Drop 1px window-border artefacts at the very top and bottom.
    return [b for b in merged if b[1] - b[0] >= 4]


def row_contrast(img: Image.Image, band: tuple[int, int], margin: int = 6) -> float:
    """Ink contrast of a text band: high for enabled text, low for disabled.

    Theme-agnostic, which absolute luminance is not. On a light GTK menu a
    disabled label is *lighter* than an enabled one; on the dark webview it is
    darker. Contrast against the local background moves the same way in both
    (measured: 123 enabled vs 24 disabled on the Help menu), so this is the
    probe to use for enabled-state assertions.
    """
    top, bottom = band
    crop = img.crop((margin, top, img.width - margin, bottom)).convert("L")
    pixels = list(crop.getdata())
    mean = sum(pixels) / len(pixels)
    return (sum((p - mean) ** 2 for p in pixels) / len(pixels)) ** 0.5


def colour_spans(
    img: Image.Image,
    rgb: tuple[int, int, int],
    tol: int = 45,
    min_pixels: int = 12,
    max_gap: int = 12,
) -> list[tuple[int, int, int, int]]:
    """Bounding boxes of pixels near `rgb`, grouped into left-to-right runs.

    For finding something whose *colour* is distinctive when its position is not.
    Hyperlinks are the motivating case: they render in --link, a colour nothing
    else in the About dialog uses, so they can be located and clicked without
    hardcoding a pixel that moves the moment the wording changes.

    `tol` is per channel and deliberately loose enough to include antialiased
    edge pixels. Check that the colour you pass really is unique in the region -
    --link (#4daafc) and --accent (#0e639c) are 63 apart on the red channel, so
    a tolerance much above 60 would start matching filled buttons too.

    Returns (x, y, w, h) boxes ordered left to right, so two links on one line
    come back in reading order.
    """
    px = img.convert("RGB").load()
    width, height = img.size
    hits = [
        (x, y)
        for y in range(height)
        for x in range(width)
        if all(abs(px[x, y][i] - rgb[i]) <= tol for i in range(3))
    ]
    if not hits:
        return []
    groups: list[list[tuple[int, int]]] = [[]]
    for hit in sorted(hits):
        if groups[-1] and hit[0] - groups[-1][-1][0] > max_gap:
            groups.append([])
        groups[-1].append(hit)
    boxes = []
    for group in groups:
        if len(group) < min_pixels:
            continue
        xs = [x for x, _ in group]
        ys = [y for _, y in group]
        boxes.append((min(xs), min(ys), max(xs) - min(xs) + 1, max(ys) - min(ys) + 1))
    return boxes


def centre(box: tuple[int, int, int, int]) -> tuple[int, int]:
    """Centre point of an (x, y, w, h) box, for clicking."""
    x, y, w, h = box
    return x + w // 2, y + h // 2


# Set by session.quipu_session() to the temporary XDG data home of the profile
# the app under test is running against. Read-only from here.
PROFILE_ENV = "QUIPU_UITEST_XDG_DATA_HOME"


def localstorage_dir(app_id: str = "com.corelight.quipu") -> Path:
    """Where the *isolated test profile* keeps WebKit's localStorage.

    Fails closed. The path comes only from PROFILE_ENV, which session.py sets for
    the lifetime of a session; there is no fallback to `~/.local/share`, because
    the developer's real profile is precisely what the harness must not read or
    delete. An unset variable means the probe is being called outside a session,
    which is a harness bug and should say so.
    """
    data_home = os.environ.get(PROFILE_ENV)
    if not data_home:
        raise RuntimeError(
            f"{PROFILE_ENV} is unset, so there is no isolated profile to read. "
            "localStorage probes only work inside a session.quipu_session(), "
            "which owns the temporary XDG profile."
        )
    return Path(data_home) / app_id / "localstorage"


def read_localstorage(app_id: str = "com.corelight.quipu", origin: str | None = None) -> dict[str, str]:
    """Read the webview's localStorage straight out of WebKit's sqlite store.

    This is how zoom persistence was verified without trusting the UI to report
    itself. Two traps, both hit during manual testing:

    * The database is in WAL mode, so the `-wal` and `-shm` sidecars must be
      copied alongside the main file or you read stale values.
    * Values are stored as UTF-16LE blobs, not text.
    """
    base = localstorage_dir(app_id)
    pattern = f"{origin}*" if origin else "*.localstorage"
    stores = [p for p in glob(str(base / pattern)) if p.endswith(".localstorage")]
    if not stores:
        raise FileNotFoundError(f"no localstorage database under {base}")
    src = Path(sorted(stores)[0])


    import shutil
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        for sidecar in glob(f"{src}*"):  # main file plus -wal / -shm
            shutil.copy2(sidecar, Path(tmp) / Path(sidecar).name)
        conn = sqlite3.connect(Path(tmp) / src.name)
        try:
            rows = conn.execute("select key, value from ItemTable").fetchall()
        finally:
            conn.close()

    out: dict[str, str] = {}
    for key, value in rows:
        if isinstance(value, (bytes, bytearray)):
            value = bytes(value).decode("utf-16-le", errors="replace")
        out[str(key)] = str(value)
    return out


def await_localstorage(key: str, expected: str, timeout: float = 6.0, **kw) -> str:
    """Poll localStorage until `key` equals `expected`, then return it.

    WebKit writes localStorage to sqlite *lazily*: immediately after a keypress
    the database may hold the previous value, or not exist at all on the very
    first write. Reading once made the zoom scenario intermittently report
    "one Ctrl+= gave 100, expected 110" when the zoom had in fact applied - a
    false failure attributable entirely to the probe.

    Returns the last value seen, so callers can assert on it and get a useful
    message when it genuinely never converges.
    """
    deadline = time.time() + timeout
    last = "<absent>"
    while time.time() < deadline:
        try:
            last = read_localstorage(**kw).get(key, "<absent>")
        except FileNotFoundError:
            last = "<no store>"  # not yet created; keep waiting
        if last == expected:
            return last
        time.sleep(0.25)
    return last


_IN_MODIFY, _IN_CLOSE_WRITE, _IN_CREATE, _IN_MOVED_TO, _IN_MOVED_FROM, _IN_DELETE = (
    0x2,
    0x8,
    0x100,
    0x80,
    0x40,
    0x200,
)
_EVENT_NAMES = {
    _IN_MODIFY: "MODIFY",
    _IN_CLOSE_WRITE: "CLOSE_WRITE",
    _IN_CREATE: "CREATE",
    _IN_MOVED_TO: "MOVED_TO",
    _IN_MOVED_FROM: "MOVED_FROM",
    _IN_DELETE: "DELETE",
}


class WriteWatcher:
    """Records filesystem writes in a directory, via inotify.

    The decisive tool for two claims that are otherwise unfalsifiable from the
    UI: that Ctrl+S saves *exactly once* per press (one press must produce one
    MODIFY + CLOSE_WRITE pair, not two), and that saving after a rename writes
    only to the new path. Use it as a context manager around the gesture.

    Implemented with ctypes rather than inotifywait so the harness does not
    depend on inotify-tools being installed.
    """

    MASK = _IN_MODIFY | _IN_CLOSE_WRITE | _IN_CREATE | _IN_MOVED_TO | _IN_MOVED_FROM | _IN_DELETE

    def __init__(self, path: str | Path):
        self.path = str(path)
        self._libc = ctypes.CDLL("libc.so.6", use_errno=True)
        self.events: list[tuple[float, str, str]] = []
        self._fd = -1

    def __enter__(self) -> "WriteWatcher":
        self._fd = self._libc.inotify_init()
        if self._fd < 0:
            raise OSError(ctypes.get_errno(), "inotify_init failed")
        wd = self._libc.inotify_add_watch(self._fd, self.path.encode(), self.MASK)
        if wd < 0:
            os.close(self._fd)
            raise OSError(ctypes.get_errno(), f"inotify_add_watch({self.path}) failed")
        return self

    def drain(self, timeout: float = 1.0) -> list[tuple[float, str, str]]:
        """Collect events until the directory goes quiet for `timeout`."""
        while True:
            ready, _, _ = select.select([self._fd], [], [], timeout)
            if not ready:
                return self.events
            buf = os.read(self._fd, 8192)
            off = 0
            while off < len(buf):
                _wd, mask, _cookie, length = struct.unpack_from("iIII", buf, off)
                off += 16
                name = buf[off : off + length].split(b"\0")[0].decode(errors="replace")
                off += length
                self.events.append((time.time(), _EVENT_NAMES.get(mask, hex(mask)), name))

    def __exit__(self, *exc) -> None:
        if self._fd >= 0:
            os.close(self._fd)
            self._fd = -1

    def count(self, event: str, name: str | None = None) -> int:
        return sum(1 for _, ev, nm in self.events if ev == event and (name is None or nm == name))

    def names(self) -> set[str]:
        return {nm for _, _, nm in self.events if nm}
