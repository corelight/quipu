import { Menu } from "@tauri-apps/api/menu";
import type { CheckMenuItem, MenuItem, Submenu } from "@tauri-apps/api/menu";

// The native application menu.
//
// Built from the FRONTEND (@tauri-apps/api/menu) rather than in Rust: every
// command it invokes already lives in main.ts and reads frontend state
// (workspace dirtiness, buildState, drawer visibility). A Rust-built menu would
// have to mirror all of that across IPC just to decide what is enabled. Here
// `action` callbacks call the commands directly, and setEnabled/setChecked let
// us push state changes onto the live menu without rebuilding it.
//
// Item ids are stable and explicit ("file.open-folder") so state updates and
// future Rust-side handling key off a documented contract rather than array
// positions.

export interface MenuCommands {
  openFolder: () => void;
  openExample: () => void;
  closeWorkspace: () => void;
  refreshProject: () => void;
  newRule: () => void;
  saveActive: () => void;
  renameActiveRule: () => void;
  compileWorkspace: () => void;
  scanTarget: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  toggleExplorer: () => void;
  toggleResults: () => void;
  showIncludesView: () => void;
  resetLayout: () => void;
  showPreferences: () => void;
  showQuickStart: () => void;
  showDocumentation: () => void;
  reportIssue: () => void;
  showAbout: () => void;
  quit: () => void;
}

/** The subset of app state the menu's enabled/checked flags derive from. */
export interface MenuState {
  // Not "hasProject": a project can be open and still be loading, and creating a
  // rule in it then races the load. Named for the command it gates, so it can say
  // no for a reason other than there being no project.
  canCreateRule: boolean;
  canSave: boolean;
  canRename: boolean;
  // Both true exactly when a project is open. Separate flags because they gate
  // separate commands, and because "is a project open" is not the only thing
  // either could ever depend on.
  canCloseWorkspace: boolean;
  canRefreshProject: boolean;
  canCompile: boolean;
  canScan: boolean;
  explorerVisible: boolean;
  resultsOpen: boolean;
}

// Items whose enabled state tracks app state. Placeholders are absent: they are
// created disabled and never updated.
const STATEFUL_IDS = {
  newRule: "file.new-rule",
  save: "file.save",
  rename: "file.rename-rule",
  refreshProject: "file.refresh-project",
  closeWorkspace: "file.close-workspace",
  compile: "rules.compile",
  scan: "rules.scan",
} as const;

const CHECK_IDS = {
  explorer: "view.explorer",
  results: "view.results-pane",
} as const;

let menu: Menu | null = null;
// Cached item handles. Each `menu.get(id)` is an IPC round-trip, so resolving
// them once at build time keeps syncMenuState() cheap enough to call on every
// keystroke-driven state change.
const items = new Map<string, MenuItem>();
const checks = new Map<string, CheckMenuItem>();

/** Builds the native menu and installs it as the window (or app) menu. */
export async function initMenu(cmd: MenuCommands): Promise<void> {
  // How the finished menu is installed (bottom of this function): on Windows/Linux
  // the menu belongs to the window, on macOS it is app-wide and setAsWindowMenu is
  // unsupported.
  const isMac = navigator.userAgent.includes("Mac OS X");

  // Quit is a regular item on every platform, and neither predefined item would do.
  //
  // On GTK muda accepts only Separator, Copy/Cut/Paste/SelectAll and About as
  // predefined items, so `{ item: "Quit" }` is silently dropped and File > Quit
  // simply does not appear. On macOS it does appear, and does the wrong thing:
  // muda maps it to `terminate:`, which ends the process without the window ever
  // being asked to close - so the frontend's close-requested guard never runs and
  // a window with unsaved work exits silently. A regular item routed through
  // cmd.quit requests a window close instead, which is the same request the title
  // bar makes, so all three ways out are guarded identically. The cost is that
  // macOS no longer supplies the label and accelerator itself; Cmd+Q is what it
  // would have used.
  const quit = {
    id: "file.quit",
    text: "Quit",
    accelerator: "CmdOrCtrl+Q",
    action: cmd.quit,
  };

  const built = await Menu.new({
    id: "app-menu",
    items: [
      {
        id: "file",
        text: "&File",
        items: [
          {
            id: "file.open-folder",
            text: "Open Folder…",
            accelerator: "CmdOrCtrl+O",
            action: cmd.openFolder,
          },
          {
            // Deliberately no accelerator: it opens a chooser rather than doing
            // anything, and Ctrl+O next to it is the shortcut for opening a
            // project. Always enabled - the examples ship with the application,
            // so there is no state in which there is nothing to choose from.
            id: "file.open-example",
            text: "Open Example…",
            action: cmd.openExample,
          },
          { item: "Separator" },
          {
            id: STATEFUL_IDS.newRule,
            text: "New Rule…",
            accelerator: "CmdOrCtrl+N",
            enabled: false,
            action: cmd.newRule,
          },
          {
            id: STATEFUL_IDS.save,
            text: "Save",
            accelerator: "CmdOrCtrl+S",
            enabled: false,
            action: cmd.saveActive,
          },
          {
            // Deliberately no F2: Monaco binds F2 to symbol rename whenever the
            // editor has focus, and a menu accelerator would shadow it.
            id: STATEFUL_IDS.rename,
            text: "Rename Rule…",
            enabled: false,
            action: cmd.renameActiveRule,
          },
          {
            // Deliberately no accelerator: CmdOrCtrl+R is the reload shortcut
            // users expect a webview to have, and F5 is close enough to it to be
            // worth leaving alone until the layout of this menu settles.
            id: STATEFUL_IDS.refreshProject,
            text: "Refresh Project",
            enabled: false,
            action: cmd.refreshProject,
          },
          { item: "Separator" },
          {
            id: STATEFUL_IDS.closeWorkspace,
            text: "Close Workspace",
            enabled: false,
            action: cmd.closeWorkspace,
          },
          {
            id: "file.preferences",
            text: "Preferences…",
            action: cmd.showPreferences,
          },
          { item: "Separator" },
          quit,
        ],
      },
      {
        id: "rules",
        text: "&Rules",
        items: [
          {
            id: STATEFUL_IDS.compile,
            text: "Compile Workspace",
            accelerator: "CmdOrCtrl+Shift+B",
            action: cmd.compileWorkspace,
          },
          {
            id: STATEFUL_IDS.scan,
            text: "Scan Target",
            accelerator: "CmdOrCtrl+Shift+Enter",
            enabled: false,
            action: cmd.scanTarget,
          },
        ],
      },
      {
        id: "view",
        text: "&View",
        items: [
          // Ctrl+= is the unshifted key that carries "+" on a US layout, and is
          // what browsers/editors accept for zoom-in. Ctrl+Shift+= and the
          // numpad variants are handled in zoom.ts, since muda allows only one
          // accelerator per item.
          {
            id: "view.zoom-in",
            text: "Zoom In",
            accelerator: "CmdOrCtrl+=",
            action: cmd.zoomIn,
          },
          {
            id: "view.zoom-out",
            text: "Zoom Out",
            accelerator: "CmdOrCtrl+-",
            action: cmd.zoomOut,
          },
          {
            id: "view.zoom-reset",
            text: "Reset Zoom",
            accelerator: "CmdOrCtrl+0",
            action: cmd.resetZoom,
          },
          { item: "Separator" },
          {
            id: CHECK_IDS.explorer,
            text: "Explorer",
            accelerator: "CmdOrCtrl+B",
            checked: true,
            action: cmd.toggleExplorer,
          },
          {
            id: CHECK_IDS.results,
            text: "Results Pane",
            accelerator: "CmdOrCtrl+J",
            checked: false,
            action: cmd.toggleResults,
          },
          { id: "view.reset-layout", text: "Reset Layout", action: cmd.resetLayout },
          { item: "Separator" },
          // Selects the Includes view inside the Explorer, revealing the pane if
          // it is hidden. Not a check item: it is a "go there" command, whereas
          // Explorer above is what shows and hides the pane itself.
          { id: "view.includes", text: "Includes View", action: cmd.showIncludesView },
        ],
      },
      {
        id: "help",
        text: "&Help",
        items: [
          { id: "help.quick-start", text: "Quick Start", action: cmd.showQuickStart },
          {
            id: "help.documentation",
            text: "Documentation",
            action: cmd.showDocumentation,
          },
          { id: "help.report-issue", text: "Report an Issue", action: cmd.reportIssue },
          { item: "Separator" },
          { id: "help.about", text: "About Quipu", action: cmd.showAbout },
        ],
      },
    ],
  });

  // Resolve the handles we mutate later. Items live inside submenus, so walk
  // the tree rather than calling built.get() (which only searches the top level).
  for (const sub of await built.items()) {
    if (sub.kind !== "Submenu") continue;
    for (const item of await (sub as Submenu).items()) {
      if (item.kind === "Check") checks.set(item.id, item as CheckMenuItem);
      else if (item.kind === "MenuItem") items.set(item.id, item as MenuItem);
    }
  }

  if (isMac) await built.setAsAppMenu();
  else await built.setAsWindowMenu();

  menu = built;
}

// Pushes the current app state onto the live menu. Cheap and idempotent, so
// callers fire it after any state transition rather than reasoning about which
// items a given change affects. A no-op until initMenu() has resolved.
export async function syncMenuState(state: MenuState): Promise<void> {
  if (!menu) return;
  const setEnabled = (id: string, enabled: boolean) => items.get(id)?.setEnabled(enabled);
  await Promise.all([
    setEnabled(STATEFUL_IDS.newRule, state.canCreateRule),
    setEnabled(STATEFUL_IDS.save, state.canSave),
    setEnabled(STATEFUL_IDS.rename, state.canRename),
    setEnabled(STATEFUL_IDS.refreshProject, state.canRefreshProject),
    setEnabled(STATEFUL_IDS.closeWorkspace, state.canCloseWorkspace),
    setEnabled(STATEFUL_IDS.compile, state.canCompile),
    setEnabled(STATEFUL_IDS.scan, state.canScan),
    checks.get(CHECK_IDS.explorer)?.setChecked(state.explorerVisible),
    checks.get(CHECK_IDS.results)?.setChecked(state.resultsOpen),
  ]);
}
