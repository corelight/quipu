import { confirm as askNatively } from "@tauri-apps/plugin-dialog";

import {
  cacheStatus,
  clearAllCaches,
  clearProjectCache,
  updateCacheSettings,
  type CacheStatus,
} from "./ipc";
import { PreferenceRequests, type PreferenceRequest } from "./preference-requests";
import { cacheClearControls, formatBytes, parseMaximumBytes } from "./preference-values";
import {
  authorizeAllCachesClear,
  authorizeCurrentCacheClear,
  runPreferenceClear,
} from "./preference-actions";

const BYTES_PER_MIB = 1024 * 1024;
const MAXIMUM_MIB = 1024 * 1024;

let dialog: HTMLDialogElement | null = null;
let currentRoot: () => string | null = () => null;
const requests = new PreferenceRequests();

export function configurePreferences(root: () => string | null): void {
  currentRoot = root;
}

function build(): HTMLDialogElement {
  const el = document.createElement("dialog");
  el.className = "preferences-dialog";
  el.id = "preferences-dialog";
  el.setAttribute("aria-labelledby", "preferences-title");
  el.innerHTML = `
    <h1 id="preferences-title" class="preferences-title">Preferences</h1>
    <section class="preferences-section" aria-labelledby="cache-preferences-title">
      <h2 id="cache-preferences-title">Compiled-rules cache</h2>
      <label class="preferences-check">
        <input id="cache-enabled" type="checkbox" autofocus />
        Enable compiled-rules cache
      </label>
      <label class="preferences-size" for="cache-maximum">
        <span>Maximum size</span>
        <span><input id="cache-maximum" type="number" min="1" max="${MAXIMUM_MIB}" step="1" inputmode="numeric" /> MiB</span>
      </label>
      <button id="cache-save" type="button">Save cache settings</button>
      <dl class="preferences-values">
        <div><dt>Current usage</dt><dd id="cache-total">Loading…</dd></div>
        <div><dt>Current workspace usage</dt><dd id="cache-project">Loading…</dd></div>
        <div><dt>Effective location</dt><dd><input id="cache-location" class="cache-location" type="text" readonly value="Loading…" aria-label="Effective cache location" /></dd></div>
      </dl>
      <p id="cache-warning" class="preferences-warning hidden" role="status"></p>
      <p id="cache-error" class="preferences-error hidden" role="alert"></p>
      <div class="preferences-cache-actions">
        <button id="cache-clear-current" type="button" disabled>Clear Current Workspace Cache</button>
        <button id="cache-clear-all" type="button" disabled>Clear All Caches</button>
      </div>
    </section>
    <div class="preferences-actions">
      <button type="button" id="preferences-close" class="primary">Close</button>
    </div>
  `;
  document.body.appendChild(el);
  el.querySelector<HTMLButtonElement>("#preferences-close")!.addEventListener("click", () =>
    el.close(),
  );
  el.querySelector<HTMLButtonElement>("#cache-save")!.addEventListener("click", () => {
    void saveSettings();
  });
  el.querySelector<HTMLButtonElement>("#cache-clear-current")!.addEventListener("click", () => {
    void clearCurrent();
  });
  el.querySelector<HTMLButtonElement>("#cache-clear-all")!.addEventListener("click", () => {
    void clearAll();
  });
  el.addEventListener("close", () => requests.close());
  return el;
}

export function showPreferences(): void {
  dialog ??= build();
  if (!dialog.open) dialog.showModal();
  setLoading();
  void load(requests.open(currentRoot()));
}

export function refreshPreferences(): void {
  const request = requests.refresh(currentRoot());
  if (request === null) return;
  setLoading();
  void load(request);
}

async function load(request: PreferenceRequest): Promise<void> {
  try {
    const status = await cacheStatus(request.root);
    if (!requests.isCurrent(request, currentRoot())) {
      if (requests.isOpen()) refreshPreferences();
      return;
    }
    applyStatus(status);
  } catch (err) {
    if (!requests.isCurrent(request, currentRoot())) return;
    showError(err);
    setBusy(false);
  }
}

async function saveSettings(): Promise<void> {
  if (dialog === null) return;
  const enabled = dialog.querySelector<HTMLInputElement>("#cache-enabled")!.checked;
  const maximum = parseMaximumBytes(
    dialog.querySelector<HTMLInputElement>("#cache-maximum")!.value,
  );
  if (!maximum.ok) {
    showError(maximum.error);
    return;
  }
  const request = requests.refresh(currentRoot());
  if (request === null) return;
  clearError();
  setBusy(true);
  try {
    const status = await updateCacheSettings(
      enabled,
      maximum.bytes,
      request.root,
    );
    if (!requests.isCurrent(request, currentRoot())) {
      if (requests.isOpen()) refreshPreferences();
      return;
    }
    applyStatus(status);
  } catch (err) {
    if (!requests.isCurrent(request, currentRoot())) return;
    // Do not call applyStatus: the values the user entered remain available for
    // correction or retry, while the backend retains its previous settings.
    showError(err);
    setBusy(false);
  }
}

async function clearCurrent(): Promise<void> {
  const request = requests.beginWork(currentRoot());
  if (request === null) return;
  let root: string | null;
  try {
    root = await authorizeCurrentCacheClear(request.root, () =>
      askNatively("Clear the compiled-rules cache for this workspace?", {
        title: "Clear Workspace Cache",
        kind: "warning",
      }),
    );
  } catch (err) {
    if (requests.isCurrent(request, currentRoot())) showError(err);
    return;
  }
  if (root === null) return;
  await runPreferenceClear({
    isCurrent: () => requests.isCurrent(request, currentRoot()),
    isOpen: () => requests.isOpen(),
    // `root` is deliberately the one named by the question. If the project
    // changes while the native dialog is open, the new project's cache is not
    // silently substituted underneath the user's answer.
    clear: () => clearProjectCache(root),
    setBusy,
    clearError,
    showError,
    refresh: refreshPreferences,
  });
}

async function clearAll(): Promise<void> {
  const request = requests.beginWork(currentRoot());
  if (request === null) return;
  let accepted: boolean;
  try {
    accepted = await authorizeAllCachesClear(() =>
      askNatively("Clear every compiled-rules cache entry?", {
        title: "Clear All Caches",
        kind: "warning",
      }),
    );
  } catch (err) {
    if (requests.isCurrent(request, currentRoot())) showError(err);
    return;
  }
  if (!accepted) return;
  await runPreferenceClear({
    isCurrent: () => requests.isCurrent(request, currentRoot()),
    isOpen: () => requests.isOpen(),
    clear: clearAllCaches,
    setBusy,
    clearError,
    showError,
    refresh: refreshPreferences,
  });
}

function applyStatus(status: CacheStatus): void {
  if (dialog === null) return;
  dialog.querySelector<HTMLInputElement>("#cache-enabled")!.checked = status.enabled;
  dialog.querySelector<HTMLInputElement>("#cache-maximum")!.value = String(
    status.maximumBytes / BYTES_PER_MIB,
  );
  dialog.querySelector<HTMLElement>("#cache-total")!.textContent = status.available
    ? formatBytes(status.totalBytes)
    : "Unavailable";
  dialog.querySelector<HTMLElement>("#cache-project")!.textContent = status.available
    ? formatBytes(status.currentProjectBytes)
    : "Unavailable";
  dialog.querySelector<HTMLInputElement>("#cache-location")!.value =
    status.effectivePath || "Unavailable";
  const warning = dialog.querySelector<HTMLElement>("#cache-warning")!;
  warning.textContent = status.warning ?? "";
  warning.classList.toggle("hidden", status.warning === null);
  const clears = cacheClearControls(status, currentRoot());
  dialog.querySelector<HTMLButtonElement>("#cache-clear-current")!.disabled =
    !clears.clearCurrent;
  dialog.querySelector<HTMLButtonElement>("#cache-clear-all")!.disabled = !clears.clearAll;
  clearError();
  setBusy(false);
}

function setLoading(): void {
  if (dialog === null) return;
  setBusy(false);
  dialog.querySelector<HTMLElement>("#cache-total")!.textContent = "Loading…";
  dialog.querySelector<HTMLElement>("#cache-project")!.textContent = "Loading…";
  dialog.querySelector<HTMLInputElement>("#cache-location")!.value = "Loading…";
  dialog.querySelector<HTMLButtonElement>("#cache-clear-current")!.disabled = true;
  dialog.querySelector<HTMLButtonElement>("#cache-clear-all")!.disabled = true;
  clearError();
}

function setBusy(busy: boolean): void {
  if (dialog === null) return;
  dialog.querySelector<HTMLButtonElement>("#cache-save")!.disabled = busy;
  if (busy) {
    dialog.querySelector<HTMLButtonElement>("#cache-clear-current")!.disabled = true;
    dialog.querySelector<HTMLButtonElement>("#cache-clear-all")!.disabled = true;
  }
}

function clearError(): void {
  if (dialog === null) return;
  const error = dialog.querySelector<HTMLElement>("#cache-error")!;
  error.textContent = "";
  error.classList.add("hidden");
}

function showError(error: unknown): void {
  if (dialog === null) return;
  const target = dialog.querySelector<HTMLElement>("#cache-error")!;
  target.textContent = String(error);
  target.classList.remove("hidden");
}
