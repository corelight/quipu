+++
title = "Reference and troubleshooting"
description = "Menu commands, shortcuts, current limits, and common fixes"
weight = 7
template = "page.html"
+++

On macOS, use <kbd>Cmd</kbd> wherever the tables show <kbd>Ctrl</kbd>.

## File menu

| Command | Shortcut | Action |
| --- | --- | --- |
| Open Folder… | <kbd>Ctrl</kbd>+<kbd>O</kbd> | Open a rules project from disk. |
| Open Example… | — | Open an editable working copy of a bundled example. |
| New Rule… | <kbd>Ctrl</kbd>+<kbd>N</kbd> | Create a rule file in the project root. |
| Save | <kbd>Ctrl</kbd>+<kbd>S</kbd> | Save the active project file. |
| Rename Rule… | — | Rename the active project-owned rule in its directory. |
| Refresh Project | — | Re-read project files, configuration, and includes from disk. |
| Close Workspace | — | Return to the scratch buffer. |
| Preferences… | — | Configure and inspect the compiled-rules cache. |
| Quit | <kbd>Ctrl</kbd>+<kbd>Q</kbd> | Close Quipu, asking before discarding unsaved work. |

## Rules and View menus

| Command | Shortcut | Action |
| --- | --- | --- |
| Compile Workspace | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> | Save project edits and build or restore the ruleset. |
| Scan Target | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Enter</kbd> | Scan the current target with the compiled rules. |
| Zoom In | <kbd>Ctrl</kbd>+<kbd>+</kbd> | Increase the application zoom. |
| Zoom Out | <kbd>Ctrl</kbd>+<kbd>-</kbd> | Decrease the application zoom. |
| Reset Zoom | <kbd>Ctrl</kbd>+<kbd>0</kbd> | Return to the default zoom. |
| Explorer | <kbd>Ctrl</kbd>+<kbd>B</kbd> | Show or hide the left pane. |
| Results Pane | <kbd>Ctrl</kbd>+<kbd>J</kbd> | Show or hide the right pane. |
| Reset Layout | — | Restore the default pane sizes and visibility. |
| Includes View | — | Reveal the Explorer and select its Includes view. |

The Help menu opens this guide in a separate window. **Quick Start** opens directly to the walkthrough; **Documentation** opens the overview. Links between documentation pages stay in the same window.

## Common problems

### Scan Target is disabled

The current rules are not compiled, a compile or scan is still running, or a change made the ruleset stale. Wait for the current operation if necessary, then choose **Compile Workspace**. A scan target change by itself does not require recompilation.

### The project says “not compilable”

Open **Includes**. Expand **Project problems** and the affected source nodes. Correct invalid `quipu.toml` settings, missing includes, include cycles, unreadable sources, or other blocking issues, then refresh or compile again.

### Compilation reports a disk conflict

An open source changed outside Quipu. Use **Save** to keep the editor's version, or **Reload from Disk** to take the external version. Quipu asks before discarding or overwriting divergent work.

### A file or include does not appear

Check that project files use a `.yar` or `.yara` extension and are not matched by an `exclude` glob. For includes, remember that Quipu searches the including file's directory before `include_dirs`. Choose **Refresh Project** if automatic watching is unavailable.

### Reopening an example kept old changes

This is intentional: examples are persistent working copies, not disposable previews. Your copy is separate from both the packaged template and your own projects.

### The cache cannot be used

Open **File → Preferences…** and read the warning and effective location. Cache trouble does not prevent fresh compilation. Disable the cache if desired and continue with **Compile Workspace**.

### Windows forgets a successful compilation after restarting

Microsoft Defender may have quarantined the compiled rules because they contain detection patterns. Check Protection history for Quipu's `rules-…yarc` file. See [Windows Defender and missing cache entries](/docs/preferences-and-cache/index.html#windows-defender-and-missing-cache-entries) for the scoped exclusion, administrator instructions, and recompilation steps.

## Current limits

- Quipu scans typed text or one selected file, not directories or file batches.
- `quipu.toml` must be edited outside Quipu.
- New rules are created in the project root; moving and deleting files are done outside the app.
- The scratch buffer can compile and scan but cannot be saved or cached.

[Return to Documentation](/docs/index.html)
