import { getCurrentWebview } from "@tauri-apps/api/webview";

// Whole-webview zoom. Scaling the webview (rather than a CSS transform or
// Monaco's own font-zoom) is what makes EVERYTHING scale together: Monaco,
// the panes, buttons, and the monospace hex dump.
//
// The value is kept as an integer percentage so repeated stepping can't drift
// the way accumulated float multiplication does. Tauri's own zoom-hotkey
// polyfill (`zoom_hotkeys_enabled`) is left OFF - its default in
// tauri-runtime is false - so the menu accelerators are the only zoom input
// and a keypress can never be handled twice.

const STORAGE_KEY = "quipu.zoom";
const MIN_PERCENT = 75;
const MAX_PERCENT = 200;
const DEFAULT_PERCENT = 100;
const STEP = 10;

let current = DEFAULT_PERCENT;

function clamp(percent: number): number {
  return Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, percent));
}

// Reads the persisted zoom, rejecting anything that isn't a finite integer
// percentage inside the supported range. A corrupt or hand-edited value must
// never leave the UI at an unusable scale, so we fall back to 100%.
function loadPersisted(): number {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return DEFAULT_PERCENT; // storage disabled/unavailable
  }
  if (raw == null) return DEFAULT_PERCENT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_PERCENT;
  const rounded = Math.round(parsed);
  if (rounded < MIN_PERCENT || rounded > MAX_PERCENT) return DEFAULT_PERCENT;
  return rounded;
}

function persist(percent: number) {
  try {
    localStorage.setItem(STORAGE_KEY, String(percent));
  } catch {
    // Non-fatal: zoom still applies for this session.
  }
}

async function apply(percent: number): Promise<void> {
  current = percent;
  await getCurrentWebview().setZoom(percent / 100);
}

// Steps snap to the 10% grid so the sequence is stable in both directions
// even from the clamped 75% end: 75, 80, 90, 100, ... 200.
export async function zoomIn(): Promise<void> {
  const next = clamp(Math.floor(current / STEP) * STEP + STEP);
  if (next === current) return;
  await apply(next);
  persist(next);
}

export async function zoomOut(): Promise<void> {
  const next = clamp(Math.ceil(current / STEP) * STEP - STEP);
  if (next === current) return;
  await apply(next);
  persist(next);
}

export async function resetZoom(): Promise<void> {
  await apply(DEFAULT_PERCENT);
  persist(DEFAULT_PERCENT);
}

/** Applies the persisted zoom (or 100%) during startup. */
export async function restoreZoom(): Promise<void> {
  await apply(loadPersisted());
}

// The menu accelerators cover Ctrl+= / Ctrl+- / Ctrl+0. On a US layout the
// "+" glyph needs Shift, and muda can only attach ONE accelerator per item, so
// Ctrl+Shift+= (and the numpad keys) would otherwise not zoom. We fill in only
// those extra combinations here - deliberately NOT Ctrl+= or Ctrl+-, which the
// menu already owns, so a single press is never handled twice.
export function installExtraZoomShortcuts() {
  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    // e.key is the produced character, so Ctrl+Shift+= arrives as "+".
    if (e.key === "+" || e.code === "NumpadAdd") {
      e.preventDefault();
      void zoomIn();
    } else if (e.code === "NumpadSubtract") {
      e.preventDefault();
      void zoomOut();
    }
  });
}
