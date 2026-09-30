+++
title = "Compiling and scanning"
description = "Build a ruleset, select one target, and run a scan"
weight = 4
template = "page.html"
+++

Quipu separates compilation from scanning. Compile the rules once, then scan targets with the in-memory ruleset until a rule or project change makes it stale.

## Build states

The status above the editor tells you whether scanning is available:

| Status | Meaning |
| --- | --- |
| **Not compiled** | No usable ruleset is loaded. |
| **Checking compiled cache…** | Quipu is checking whether an unchanged project can be restored. |
| **Compiling…** | A compile is in progress. |
| **Compiled ✓** | The displayed ruleset is ready to scan. |
| **Stale — rules changed, recompile** | The project changed after the last usable compile. |

Scanning is enabled only in the **Compiled** state.

## Compile a workspace

Choose **Rules → Compile Workspace**, click **Compile**, or press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> (<kbd>Cmd</kbd> on macOS).

For an open project, Quipu:

1. Safely saves modified sources that belong to the project's include graph.
2. Reads a fresh project definition and source graph from disk.
3. Reuses a fully validated compiled-cache entry when one is available, or compiles the plan with YARA-X.
4. Installs the resulting ruleset in memory and reports the rule count.

Compilation stops if a dirty source no longer agrees with the file on disk and you do not authorise the replacement. Resolve the conflict with **Save** or **Reload from Disk**, then compile again.

For the scratch buffer, Quipu compiles the current editor text directly. Scratch text is not saved or cached.

Warnings and errors appear in **Problems**. A compile with errors leaves scanning disabled. A successful compile may still have warnings; the ruleset remains available.

## What makes a ruleset stale

Quipu invalidates compiled rules when the rule inputs may have changed, including after:

- an editor change
- creating or renaming a rule file
- a relevant change detected on disk
- **Refresh Project**
- opening or closing a workspace

Changing only the scan target does not require recompilation.

## Choose a target

Quipu scans one target at a time:

- Type or paste text into **Scan target** to scan its UTF-8 bytes.
- Choose **Choose file…** to read a single file as bytes. Its path and size appear below the target area; choose another file to replace it.
- Open an example to use the sample target supplied by that example.

The selected target is independent of the rules project and normally remains selected when you open or close a workspace. Quipu does not currently scan a directory or a batch of files.

## Run the scan

With a compiled ruleset loaded, choose **Rules → Scan Target**, click **Scan**, or press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Enter</kbd> (<kbd>Cmd</kbd> on macOS).

The Matches tab opens after every scan, including a scan with no matching rules. You can replace the target and scan again without recompiling, provided the rules have not changed.

Next: [Results and diagnostics](/docs/results-and-diagnostics/index.html).
