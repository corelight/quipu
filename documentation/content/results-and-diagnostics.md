+++
title = "Results and diagnostics"
description = "Read matches, inspect bytes, and navigate to problems"
weight = 5
template = "page.html"
+++

The right-hand results pane contains **Matches** and **Problems**. Show or hide the pane with **View → Results Pane** or <kbd>Ctrl</kbd>+<kbd>J</kbd> (<kbd>Cmd</kbd>+<kbd>J</kbd> on macOS), and drag its divider to resize it.

## Matches

After a scan, Matches reports the number of target bytes scanned and the number of matching rules. Each rule can contain one or more match rows. A row shows:

- the pattern identifier, such as `$header`
- the byte offset in hexadecimal
- the length of the match in bytes

Rule tags and namespaces are displayed when present.

Use different parts of the tree for different tasks:

- Select the disclosure arrow to expand or collapse a rule.
- Select the **rule name** to find its definition in the editor.
- Select the **pattern identifier** to find that string definition.
- Select the remainder of a **match row** to inspect the target bytes.

## Hex viewer

Selecting a match row opens a full-width dock below the main panes. It shows hexadecimal and printable ASCII views of the bytes around the match. Matching bytes are highlighted, and the title identifies the rule, pattern, offset, and length.

Select the close button in the dock when you have finished inspecting the bytes.

## Problems

The Problems tab contains messages produced by a full compile, along with operational errors Quipu needs to keep visible. Compiler entries show their severity, code, file, line, and column. Select an entry with a source location to open the file and reveal that position.

Quipu limits the rendered list for very large compilations. When more messages exist, the bottom of the list says how many were omitted from the display.

Successful compiled-cache restoration also restores the warnings from the original compilation, so Problems remains consistent with the loaded ruleset.

## Three places problems appear

Quipu reports each kind of issue where it has the most useful context:

| Location | What it reports |
| --- | --- |
| **Editor** | Live syntax and semantic diagnostics while you type. |
| **Includes view** | Project structure problems such as invalid configuration, missing includes, cycles, unreadable sources, and external dependencies. |
| **Problems tab** | Full compiler warnings and errors, plus operational failures from compile, scan, or file access. |

If **Compile Workspace** produces no ruleset, check both Includes and Problems: the first explains whether Quipu could construct a valid compilation plan, and the second shows compiler output when compilation was reached.

Next: [Preferences and cache](/docs/preferences-and-cache/index.html).
