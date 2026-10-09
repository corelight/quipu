# Quipu tests

This directory holds tests that exercise Quipu as a running application, from the outside. Unit tests live with the code they cover (`cargo test` under `app/src-tauri`); everything here needs a real window on a real X server.

At present there is one suite: `ui/`, an end-to-end harness for the native application menu and the behaviour hanging off it.

## Why this exists in this form

Quipu's menu bar is a *native* GTK menu, built through `muda` from `app/src/menu.ts`. That choice has a consequence for testing: the menu is not in the DOM. WebDriver, Playwright and anything else that drives the webview cannot see it, cannot click it, and cannot read its enabled or checked state. Neither can they observe the accelerators, because those are handled by GTK before the webview is involved.

So the suite works one level down: it synthesises real pointer and keyboard input at the X server via XTEST, and observes the result by capturing pixels and watching side effects. That is heavier than a DOM test, and the trade is deliberate - it is the only approach that covers the menu at all.

Three things follow from that, and they shape everything below:

- **Assertions must be objective.** A screenshot proves a human looked at it once. So where the claim is about behaviour rather than appearance, the suite asserts on evidence the UI cannot fake: inotify events for "saved exactly once", the localStorage database for "zoom was persisted", ink contrast for "this item is disabled".
- **Coordinates rot.** Anything hardcoded about where a widget sits is the part that breaks when the UI changes. Those constants are collected in one place and called out as such.
- **Isolation is correctness, not hygiene.** Synthesised input goes to whatever has focus, and some app state is persisted between runs. Both have produced convincing false failures. Isolation is also what keeps the suite off your own Quipu profile. See [Isolation and state](#isolation-and-state).

## Layout

```
test/ui/
  xdriver.py         X11 input, window discovery, capture, and the probes.
                     Knows nothing about Quipu's layout.
  session.py         Brings up an X server, a throwaway XDG profile, a Quipu
                     build and a scratch workspace; tears them all down again.
  menu_scenarios.py  The acceptance walk as executable scenarios, plus the
                     layout constants. This is the part that rots.
```

The split matters when you come to extend it: `xdriver.py` is the reusable half and should stay Quipu-agnostic, while `menu_scenarios.py` owns every assumption about where things are on screen.

## Requirements

- `python3-xlib`, `python3-pil`
- `xvfb` for the preferred headless automation path; `xserver-xephyr` for
  watchable runs and automatic fallback
- `xclip` for atomic native-chooser path entry and for reading back the
  Preferences dialog's copyable effective cache path
- A working Quipu build. `--mode dev` runs `npm run tauri dev` (cold start compiles Rust, hence the generous startup timeout); `--mode release` runs `app/src-tauri/target/release/quipu` and starts in seconds. `--mode debug` runs the prebuilt debug binary with embedded frontend assets, built using `npm run tauri -- build --debug --no-bundle -- --locked`; it does not start a Vite server.

No network access is needed. Capture goes through X `GetImage` directly rather than shelling out to `xwd`, and the write watcher is `ctypes` inotify rather than `inotify-tools`; `xclip` enters temporary folder paths atomically and verifies the exact read-only path displayed by Preferences.

## Running it

```
cd test/ui
python3 menu_scenarios.py --list                 # what exists, one line each
python3 menu_scenarios.py --all                  # whole suite; Xvfb if available
python3 menu_scenarios.py save_fires_once        # one scenario
python3 menu_scenarios.py --all --server xvfb    # require headless Xvfb
python3 menu_scenarios.py --all --server xephyr  # require watchable Xephyr
python3 menu_scenarios.py --all --mode release   # against a built binary
python3 session.py                               # bring up an app and leave it
                                                 # running, for interactive poking
```

Artefacts (captures, and a `FAIL-<name>.png` for every failure) go to `--artifacts`, default `/tmp/quipu-ui-artifacts`, and deliberately outlive the run - they are what you read after a failure. Everything else the run creates lives in a `quipu-ui-test-*` temporary directory that is removed on the way out; see [Isolation and state](#isolation-and-state). Exit status is non-zero if any scenario failed, and one failure does not abort the rest of the run.

The default `--server auto` policy prefers headless Xvfb and falls back to Xephyr
when Xvfb is unavailable. Pass `--server xephyr` for a watchable diagnostic run;
pass either concrete server name in automation when silently changing server type
would be undesirable. The standalone `session.py` launcher remains Xephyr-first
because its purpose is interactive poking.

Whole-suite runtime is a few minutes, dominated by deliberate settle pauses and by `zoom_survives_restart` starting the app twice.

## What is covered

The suite is a transcription of the manual acceptance walk done when the menu was implemented. Each scenario's docstring states what it proves and, where relevant, which specific regression it guards - those notes are the useful part and are worth keeping current.

| Scenario | Claim |
| --- | --- |
| `menu_shape` | All four menus render with the expected number of items. |
| `save_fires_once` | One Ctrl+S on a dirty file produces exactly one write; on a clean file, none; after re-editing, one again. |
| `zoom_stepping` | One keypress is one 10% step, and the range clamps at 75% and 200%. |
| `zoom_persistence` | A non-default zoom reaches the persistent store. |
| `scan_enables_after_compile` | Scan Target is disabled until a compile succeeds, then enabled. |
| `view_toggles_and_reset` | Explorer and results panes toggle, and Reset Layout restores default widths without collapsing the grid or discarding state. |
| `rename_rekeys_and_saves` | After a rename the file stays active and subsequent saves write only to the new path. |
| `about_dialog` | About opens, shows a runtime version, and closes on Escape. |
| `zoom_survives_restart` | A zoom set in one session is read back *and applied to the webview* on the next startup. Restarts the app, so it runs outside the shared session. |
| `about_links_open_externally` | The About credit links hand the correct URL to the OS browser and never navigate the app's own webview. Owns its session, because the `xdg-open` shim has to be on `PATH` before the app starts. |
| `report_issue_opens_externally` | Help > Report an Issue hands the exact GitHub issue-chooser URL to the OS browser. Owns its session, because the `xdg-open` shim has to be on `PATH` before the app starts. |
| `quit_guards_unsaved_work` | File > Quit asks before discarding a dirty scratch buffer; cancelling leaves the process running with working menus, and confirming closes the window and exits. Owns its session, because it ends by terminating the app. |
| `close_workspace_confirms_discard` | Leaving a project asks about unsaved work in a dialogue that is really on screen: Open Folder asks after its picker, Close Workspace asks, cancelling either keeps the same project, text and menus, and approving closes the workspace. Owns its session, because it ends with no project open. |
| `preferences_dialog` | File > Preferences is enabled, opens its bundled modal, reports the exact effective cache path beneath its isolated XDG cache root, and closes with Escape. Owns its profile so the expected backend path is known. |
| `documentation_window` | Help > Documentation loads the bundled Zola site, whose Quick Start link navigates the same resizable window. Native close dismisses help, Help > Quick Start recreates it, and File > Quit closes both windows. |
| `documentation_native_close` | Repeats the help lifecycle with a native close request on the main window, verifying that both windows close. |

`menu_shape` expects 9 labels in File, Quit included. Quit is worth knowing about: `muda`'s `is_item_supported!` accepts only `Separator | Copy | Cut | Paste | SelectAll | About` on GTK, so the *predefined* Quit item is silently dropped there - and on macOS the predefined one maps to `terminate:`, which exits the process without the window ever being asked to close, taking the unsaved-work guard with it. `menu.ts` therefore builds a regular menu item on every platform, so the File count and `LABEL_INDEX["file.quit"]` need no platform conditions if the suite is ever run on macOS.

`quit_guards_unsaved_work` and `close_workspace_confirms_discard` are what cover the confirmations' *wiring* - the menu item, the close listener on the real window and the confirmation dialogue - which the unit tests in `app/src/closing.ts`'s suite cannot see. Two things about it generalise to any dialogue-driven scenario:

- **The confirmation is a native dialog, not `window.confirm`.** `window.confirm` returns `true` in this webview without displaying anything, which is why every confirmation in the app - Quit, leaving a project, saving over a conflict, Reload from Disk - asks through the dialog plugin instead. The dialog is an ordinary GTK toplevel, so it is found the same way the folder chooser is: a viewable window that is not the app window.
- **Escape cancels it; OK has to be clicked.** No response is focused as the default, so `Return` does nothing. The scenario clicks the right-hand half of the button row, addressed as a proportion of the dialog rather than as fixed pixels.

Because those dialogues are awaited, what an answer is still allowed to do is decided in `app/src/authorising.ts` and held to `app/src/authorising.test.mjs`; these scenarios prove the window exists and is connected, not what the gates decide.

`documentation_window` also covers closing a clean main window through File > Quit
while an auxiliary window is open.

### Chromium layout regression

`python3 test/ui/layout_regression.py` checks the real app shell markup and CSS in
headless Chromium. It needs Python Playwright (`pip install playwright` and
`playwright install chromium`). It checks root overflow and chevron reachability
at four window sizes with both side panes shown/hidden, and verifies that an
overflowing editor pane still scrolls. This catches the Windows outer-scrollbar
regression without requiring Tauri. It does not exercise Monaco or native window
behaviour; the native suite and Windows desktop smoke tests cover those.

### Monaco editor regression

`python3 test/ui/editor_regression.py` builds a production Vite fixture using
the real `Workspace`, YARA LSP adapter, Monaco configuration and worker. It needs
Python Playwright 1.59.0 and Chromium (`python3 -m pip install playwright==1.59.0`
and `python3 -m playwright install chromium`). CI runs it in the frontend job.

Only the native IPC boundary is mocked, with deterministic LSP responses. The
test checks rendering, Monarch highlighting, requests for full-document semantic
tokens, visible completion and hover, pushed diagnostics, typing/undo/find,
dirty edits across switching and renaming, closing models, and a real editor
worker round trip. It runs under the app's Content Security Policy and fails on
browser errors or worker fallback warnings. The fixture is built in a temporary
directory and is not included in the shipped app. A failure screenshot is saved
to `/tmp/quipu-editor-regression-failure.png` and uploaded by CI.

This catches import/feature-registration failures that the model-free unit tests
cannot see. Monaco 0.57 removes `edcore.main`, changes package export paths, and
omits the full-document semantic-token controller from `features/register.all`;
Quipu registers that controller explicitly. The standalone dark theme also needs
semantic highlighting enabled explicitly. Native tests and manual desktop checks
remain necessary for WebKitGTK/WebView2 behavior and the actual YARA language server.

The folder-chooser driver explicitly focuses its X11 window and switches to
filesystem browsing before pasting the workspace path. A fresh CI profile can
otherwise leave the chooser in an empty Recent view; relying on remembered
locations or window-manager focus makes Open Folder automation unreliable.

## Menu callback lifetime regression

Tauri 2.12.1 removes a menu item's JavaScript callback when its Rust wrapper is
dropped. Nested option objects create temporary wrappers, so menus can render
normally while clicks and accelerators do nothing. `menu.ts` creates items with
explicit constructors, attaches the resulting resources, and caches those
original handles for state updates. `menu_shape` alone cannot detect this:
`about_dialog` fails against the affected DEB and the action scenarios exercise
the repaired callbacks.

## The probes

These are the reason the suite can assert anything beyond "it did not crash". Each exists because a claim could not be checked any other way, and each has a failure mode worth knowing before you reach for it.

**`WriteWatcher`** - inotify over the workspace directory. The decisive tool for single-save: nothing in the UI distinguishes one write from two, but the event log does. Use it as a context manager tightly around the gesture, then `drain()` before counting.

**`read_localstorage()` / `await_localstorage()`** - reads WebKit's localStorage sqlite directly, so persistence claims do not depend on the UI reporting itself honestly. It reads the *isolated* profile: the directory comes from `QUIPU_UITEST_XDG_DATA_HOME`, which `quipu_session()` sets for the life of a session, and there is deliberately no fallback, so calling it outside a session raises rather than reading the developer's real profile. Three traps, all hit in practice: the database is in WAL mode, so the `-wal` and `-shm` sidecars must be copied alongside the main file or you read stale values; values are UTF-16LE blobs, not text; and the flush is *asynchronous*, so a single read straight after a keypress may see the previous value or no database at all. Always use `await_localstorage()`, never a bare read - sampling once is what made `zoom_stepping` intermittently claim "one Ctrl+= gave 100, expected 110" when the zoom had in fact applied.

**`text_rows()`** - finds horizontal bands of ink, returning `(top, bottom)` pairs. Used to locate menu rows from rendered pixels instead of an assumed item pitch, because GTK item height varies with theme, font and scale, and because separators occupy space visually while producing no label band. The returned list therefore indexes *visible labels*, which is why `LABEL_INDEX` is keyed that way. Miscounting separators against `menu.ts` is precisely how a manual check once activated the disabled "Includes View" while aiming at "Reset Layout".

**`row_contrast()`** - standard deviation of ink within a text band: high for enabled text, low for disabled. Use this for enabled-state assertions, *not* absolute luminance. The GTK popup is light-themed while the webview is dark, so a disabled label is lighter than an enabled one in the menu and darker in the webview; a brightness threshold tuned on one gets the sign backwards on the other. Contrast moves the same way under both. Assert *separation* (every disabled label measures below every enabled one in the same popup) rather than a constant, since absolute values depend on theme and font - measured here at 30-35 disabled against 51-59 enabled.

**`colour_spans()`** - bounding boxes of pixels near a given colour, grouped left to right. For clicking something whose colour is distinctive when its position is not: the About dialog's links are found by `--link`, so rewording the sentence around them does not break the scenario. Check the colour really is unique in the region first - `--link` (`#4daafc`) and `--accent` (`#0e639c`) are only 63 apart on the red channel, so a tolerance much above 60 starts matching filled buttons.

**`mean_luminance()`** - average brightness of a region. Fine for comparing two captures of the same box to detect a state change; not fine as an absolute threshold, for the theme reason above.

**`_paste_folder_path()`** - gives GTK's folder chooser the complete temporary
path through a one-request `xclip` owner, avoiding inline autocomplete and
character-by-character XTEST loss. The owner is reaped after Paste. If Ctrl+V is
dropped, its bounded wait returns an attempt failure so `open_workspace()` can
dismiss the modal chooser and retry the whole gesture.

### Lost and duplicated input

XTEST synthesis is not lossless. On a loaded machine the nested server has dropped keystrokes (`/tmp/quipu-ui-test-lwg1nc/ws` for `.../quipu-ui-test-6zlwg1nc/ws`), duplicated one (`quipu-ui-test-33q14fp6_`), and swallowed a menu-bar click outright. A controlled five-trial probe typed the same paths cleanly every time on an idle machine, so this is load-dependent, not a systematic completion bug - which means a single lost gesture must not be reported as an application defect. Three places retry, and each says so where it does:

- `Menu.open()` re-clicks the menu bar up to three times, because a click that produces no popup is not a claim about the menu.
- `open_workspace()` retries the whole Open Folder gesture, captures the chooser to the artifacts directory on each failure, and always dismisses it before returning or raising. The chooser is *modal*, so one mistype left open used to swallow every subsequent click: one corrupted path was enough to fail four scenarios plus `zoom_stepping` ("zoom settled on 100, expected 110"), none of them the app's fault.
- `drive_zoom()` presses a zoom accelerator until storage reports the target value. Only for scenarios whose claim is the resulting *value* - `zoom_stepping` owns "one press is one step" and must keep pressing exactly once.

A dropped *first* gesture has its own cause: there is no window manager on the nested display, so keyboard focus follows the pointer. `quipu_session()` therefore clicks the centre of the window before yielding. Without it a session's first accelerator sometimes went nowhere, which surfaced as `zoom_survives_restart` reporting `<no store>` for a zoom the app had never been asked to change.

### Choosing a region to probe

`setZoom` scales the **webview only**. The GTK menu bar is a native widget outside it and never scales. An earlier version of `zoom_survives_restart` compared menu-bar pixels and reported "menu bar renders identically at 80% and 100%; zoom was not applied on load" - a broken probe reported as an application defect. `ZOOM_PROBE_STRIP` now starts below the menu bar for that reason.

The general rule: before trusting a pixel assertion, confirm the region you chose can actually change when the thing you are testing changes. The cheap way to establish that is to capture it in both states by hand and look at the numbers.

Prefer assertions that check the *right amount* of change over ones that check for any change at all. `zoom_survives_restart` asserts row positions scaled by roughly 0.8, not merely that they differ - "differs" would also pass if the content had simply reflowed for an unrelated reason.

## Isolation and state

Three hazards. Two have produced failures that looked like application bugs and were not; the third destroyed real data.

**Input goes wherever focus is.** The harness synthesises input at the X server, so running it against your live desktop means clicks land on whatever is under the pointer and keystrokes go to whatever has focus - including the terminal you launched it from. Always run against a nested or virtual server. `session.py` picks a free display between `:20` and `:99` and never touches `:0`.

**The suite must not touch your own Quipu profile.** It once did: `reset_persisted_state()` defaulted to `~/.local/share/com.corelight.quipu/localstorage` and deleted it, so every run wiped the developer's real zoom and view preferences to fix a test-fixture problem. Never write a path to the real application-data directory into this tree, and treat deleting anything outside a test-owned temporary directory as a bug.

What replaces it is `session.Profile`: each run gets a `tempfile.TemporaryDirectory` named `quipu-ui-test-*`, holding `data/`, `cache/`, `config/` and `ws/`. `App.start()` passes the first three to the Quipu child process as `XDG_DATA_HOME`, `XDG_CACHE_HOME` and `XDG_CONFIG_HOME`, which is where everything WebKit and the app persist actually goes. The whole tree is removed when the owning session ends, including after a failure.

- **HOME is untouched.** Repointing it would isolate far more than this needs - the npm cache, the Cargo and rustup homes `tauri dev` compiles against, the GTK bookmarks the file chooser reads - and would turn a two-minute suite into a cold rebuild. Three XDG variables are the smallest change that covers the app's own state.
- **`reset_persisted_state(data_home)` takes the root explicitly and has no default.** It refuses any path without a `quipu-ui-test-` component, raising rather than deleting. So an absent isolation root fails loudly instead of falling back to the real profile.
- **The localStorage probes fail closed.** `read_localstorage()` resolves its directory from `QUIPU_UITEST_XDG_DATA_HOME`, set by `quipu_session()` for the life of the session and restored afterwards. Unset means it raises; it never guesses a path.
- **The workspace is inside the profile too.** It used to be a fixed `/tmp/quipu-uitest-ws`, which two concurrent runs would fight over and a crashed run would leave behind.

**Zoom is global and persisted.** A scenario that ends at 80% leaves the whole webview rescaled, so every hardcoded coordinate in every later scenario lands on the wrong widget. That surfaced as `rename_rekeys_and_saves` renaming `b.yar` instead of `a.yar`, and as Ctrl+S apparently doing nothing - six of eight scenarios failing, with nothing wrong in the app. Three mechanisms address it, and a new scenario needs to respect all three:

- `reset_persisted_state()` clears the isolated profile's localStorage *before* startup, since the zoom is applied on load. (The store does not exist until the app's first write, so its absence early in a run is normal, not a fault.)
- `reset_view()` runs between scenarios: Escape, Ctrl+0, Reset Layout.
- Any scenario that changes the file set must put it back, and call `activate_file.invalidate()` so the workspace is re-opened. `activate_file()` addresses files by *row order*, so a leftover rename shifts every later click. `rename_rekeys_and_saves` is the worked example.

`make_workspace()` provides the fixture: `a.yar` (`alpha_rule`, matches `"malware"`), `b.yar` (`beta_rule`, matches `"benign"`), and `target.bin` containing `malware`, so a compile yields a predictable count and a scan a predictable match.

### Restart scenarios share one profile

A scenario that restarts the app needs the *same* persisted state in both processes, so it must own the profile rather than let each session create one:

```python
profile = Profile()
try:
    with quipu_session(profile=profile, reset_state=True) as (drv, win, ws):
        ...   # first process writes the value
    with quipu_session(profile=profile, reset_state=False) as (drv, win, ws):
        ...   # second process reads the same isolated profile
finally:
    profile.close()
```

`quipu_session()` creates and removes a profile only when it was not given one, so the tree survives between the two `with` blocks and is deleted once, after both. `reset_state=False` on the second session is what keeps the value the first wrote. Get either part wrong and the second process starts with an empty data home, finds nothing to restore, and the scenario fails while the app is working correctly. `zoom_survives_restart` is the worked example.

`python3 session.py` gets the same treatment: an isolated profile that lives until Ctrl+C and is then removed, so poking at the app by hand does not write to the real one either. It prints the profile path on startup.

## Adding a scenario

1. Write a function taking `(drv, win, ws, artifacts)` and decorate it with `@scenario`. It is registered by name automatically.
2. Give it a docstring saying what it proves. If it guards a specific regression, name that regression - it is what tells the next person whether a failure matters.
3. Reach a menu item through `Menu(drv, win).activate("View", LABEL_INDEX["view.reset-layout"])`. Never hardcode a row's y coordinate; rows are found from pixels.
4. Assert on a probe rather than a screenshot wherever the claim is behavioural. Save captures too - they are what you will actually read when it fails - but do not let a capture be the assertion.
5. Leave the UI as you found it. If you cannot, restore it explicitly and invalidate the workspace memo.
6. Run it twice in a row, and run it as part of `--all`. Order-dependent state leaks only show up the second way. Most defects found while building this suite were in the harness, not the app.

If the scenario needs its own application lifecycle - anything testing startup, restore or shutdown - add it to `LIFECYCLE_SCENARIOS` instead, with the signature `(artifacts, server, mode)`, and drive `quipu_session()` yourself. `zoom_survives_restart` is the model, including the shared `Profile` and `reset_state=False` for the second session described in [Restart scenarios share one profile](#restart-scenarios-share-one-profile).

A scenario whose claim is about the *process* - that it survived, or that it exited - has to go one level lower still and assemble `XServer`, `App`, `Profile` and `Driver` itself, because `quipu_session()` yields no handle on the child. `quit_guards_unsaved_work` is the model: it polls `app.proc.poll()`, so "the app survived a cancelled Quit" is a claim about the process rather than about a repaint, and it tears the same four things down in a `finally`.

`restoration_catch_up_overtakes_initial` is the focused compiled-cache lifecycle
scenario. It creates a real 8,000-rule cache under one throwaway profile, restarts,
and uses `--debug` records to prove coverage catch-up analysis B is accepted before
initial restore A, A's independently current hit still exits **Checking compiled
cache…**, and the owned initial-presentation transition sends the first document to
the LSP exactly once. Unit coverage separately holds B's file read pending while C
is accepted and proves C supersedes that pending attempt. The fixture size makes the
ordinary watcher window produce the A/B interleaving; no test hook or sleep chooses
the order. JSONL completion is polled as an observable condition, and both trace
files disappear with the profile.

## Keeping it working as the app changes

When a scenario starts clicking the wrong thing, check these in order.

**Layout constants, top of `menu_scenarios.py`.** `MENUBAR_X` and `MENUBAR_Y` (menu bar hit points), `EDITOR_CLICK`, `SCAN_BUTTON_BOX`, `ZOOM_PROBE_STRIP`, the explorer row pitch in `activate_file()`, and the region boxes inside individual scenarios. These are the intended failure point - a deliberate concentration of fragility in one readable place rather than spread through the assertions.

**`LABEL_INDEX` when `menu.ts` changes.** It maps command ids to positions among *visible labels*, separators excluded. Adding, removing or reordering an item means updating it, and the item counts in `menu_shape` along with it.

**External URLs, in three places that must agree.** The constants in `app/src/about.ts` and `app/src/reportissue.ts`, the opener scope in `app/src-tauri/capabilities/default.json`, and the expectations in `menu_scenarios.py` must name the same exact URLs. The scope is a literal URL glob, so changing a link without changing the capability makes it fail closed at runtime with `ForbiddenUrl` - which is the safe direction, but silent unless you are watching the console. `about_links_open_externally` and `report_issue_opens_externally` catch this.

**Enabled-state expectations.** All Help commands are enabled: Quick Start and Documentation are covered by `documentation_window`, Report an Issue by `report_issue_opens_externally`, and About by `about_links_open_externally`. File > Preferences is checked by the focused `preferences_dialog` scenario; project-scoped File commands still begin disabled through their ordinary state wiring.

**Startup failures.** A bare 90-second window timeout hides its cause, so the timeout path tails the app log into the exception; read that before anything else. The most common cause is a leftover vite holding port 1420, which makes `tauri dev` exit immediately - `dev_port_owner()` pre-flights that with an actionable message.

## Where this could go next

The suite is deliberately not a framework. If it grows, the options, in rough order of cost:

- **Wrap the scenarios in pytest.** They are already independent functions with clear names; a session-scoped fixture around `quipu_session()` would buy parametrisation, selection and reporting for very little work. The one thing to preserve is the guarantee that `reset_view()` runs between scenarios.
- **Broaden CI coverage.** The reusable Linux workflow builds release packages and runs `menu_shape`, `about_dialog`, `save_fires_once`, and `view_toggles_and_reset` under Xvfb against the release binary, in both CI and Release. These exercise real native clicks, shortcuts, and state updates; harness unit tests alone cannot catch disconnected menu callbacks. Failed runs upload captures and the app log. Other scenarios remain available for local acceptance testing.
- **AT-SPI introspection via `pyatspi`.** GTK exposes menu items as accessibility objects with names and states, which would replace the pixel probes for menu structure and enabled state with something far less brittle. It is the most promising single improvement to this harness. It does not remove the need for XTEST, since accelerators still need real key events.
- **`webkit2gtk-driver` for the webview.** Proper WebDriver access to the DOM, worth having for pane and editor behaviour where a DOM assertion beats a luminance comparison. It is blind to the native menu, so it complements this suite rather than replacing it.
