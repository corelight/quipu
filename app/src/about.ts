import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
// Vite resolves this to a bundled asset URL, so the icon travels with the
// frontend build (and the embedded dist/ in release builds) - no runtime file
// or network access needed.
//
// Imported straight from the icon master that tauri-build reads, rather than a
// copy under src/assets: the two were byte-identical, which is a
// source-of-truth problem waiting to happen the first time the artwork is
// revised. Both paths are inside the Vite root (app/), so no fs.allow entry is
// needed.
import iconUrl from "../src-tauri/icons/source.svg";

// The About box is frontend HTML rather than muda's predefined About item:
// PredefinedMenuItem::about() renders a GTK AboutDialog on Linux, which is
// styled by the system theme and can't be made to match the app's dark
// design. A native <dialog> gives us Escape-to-close and focus trapping for
// free while staying inside our own stylesheet.

// Credit links. Kept as constants because they must match the allow-list in
// src-tauri/capabilities/default.json exactly - the opener scope is a literal
// URL glob, so editing one without the other silently breaks the link.
const CORELIGHT_URL = "https://corelight.com/platform/yara-file-analysis";
const YARA_X_URL = "https://virustotal.github.io/yara-x/";

let dialog: HTMLDialogElement | null = null;

function build(): HTMLDialogElement {
  const el = document.createElement("dialog");
  el.className = "about-dialog";
  el.id = "about-dialog";
  el.setAttribute("aria-labelledby", "about-title");
  el.innerHTML = `
    <div class="about-head">
      <img class="about-icon" src="${iconUrl}" alt="" width="64" height="64" />
      <div>
        <h1 id="about-title" class="about-name">Quipu</h1>
        <p class="about-version" id="about-version">Version <span id="about-version-value">...</span></p>
      </div>
    </div>
    <p class="about-desc">A desktop workbench for writing, validating, compiling, and testing YARA rules.</p>
    <p class="about-powered">Built by <a href="${CORELIGHT_URL}">Corelight</a>. Powered by <a href="${YARA_X_URL}">YARA-X</a>.</p>
    <div class="about-actions">
      <button type="button" id="about-close" class="primary" autofocus>Close</button>
    </div>
  `;
  document.body.appendChild(el);
  el.querySelector<HTMLButtonElement>("#about-close")!.addEventListener("click", () => el.close());
  wireExternalLinks(el);
  return el;
}

// Hands external links to the OS default browser instead of letting the webview
// follow them.
//
// This is not a nicety. Quipu installs no navigation handler, so a plain click
// would load the remote page *into the app's own webview*, replacing the entire
// UI with no back button and no way to recover short of restarting. The href is
// still a real URL so the link stays keyboard-focusable and its target is
// visible on hover and copyable; only the default navigation is suppressed.
//
// The opener plugin's capability allows exactly these two URLs, so a typo here
// fails closed (ForbiddenUrl) rather than opening something unintended.
function wireExternalLinks(root: HTMLElement) {
  for (const link of root.querySelectorAll<HTMLAnchorElement>("a[href^='https://']")) {
    link.addEventListener("click", (ev) => {
      ev.preventDefault();
      void openUrl(link.href).catch((err) => console.error("About: failed to open", link.href, err));
    });
  }
}

/** Opens the About dialog, filling in the version reported by the Tauri app API. */
export async function showAbout(): Promise<void> {
  dialog ??= build();
  if (!dialog.open) dialog.showModal();
  // Fetched per open (and after showModal, so a slow IPC round-trip never
  // delays the dialog appearing). The version comes from the running app, not
  // a hardcoded string.
  const valueEl = dialog.querySelector<HTMLElement>("#about-version-value")!;
  try {
    valueEl.textContent = await getVersion();
  } catch (err) {
    valueEl.textContent = "unknown";
    console.error("About: failed to read app version", err);
  }
}
