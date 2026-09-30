+++
title = "Writing rules"
description = "Use the YARA-aware editor and safely manage rule files"
weight = 3
template = "page.html"
+++

Quipu's editor is powered by Monaco and an embedded YARA-X language server. No separate language server or YARA installation is required.

## Editor assistance

As you type, the editor provides:

- YARA syntax highlighting
- completion suggestions
- hover information
- syntax and semantic diagnostics

Live diagnostics are shown directly in the editor. Compilation performs a separate, complete validation of the workspace and puts compiler messages in the **Problems** tab.

A minimal rule looks like this:

```yara
rule example_greeting {
    strings:
        $hello = "hello" nocase
    condition:
        $hello
}
```

Compile it, type `Hello from Quipu` in the scan target, and scan to see the match.

## Navigating source

Select a file in **Files** or a source in **Includes** to open it. Quipu keeps open documents in the editor as you move around the project.

Several result views navigate back into source:

- A compiler diagnostic opens its file and reveals its location.
- An include row reveals the corresponding `include` directive.
- A matched rule name reveals the rule definition.
- A matched pattern identifier reveals that string's definition.

## Creating and renaming files

Choose **File → New Rule…** or press <kbd>Ctrl</kbd>+<kbd>N</kbd> (<kbd>Cmd</kbd>+<kbd>N</kbd> on macOS). Quipu creates an empty file in the project root. If the name has neither a `.yar` nor `.yara` suffix, Quipu adds `.yar`. It refuses to overwrite an existing file.

Choose **File → Rename Rule…** to rename the active project file in its current directory. You can also double-click a file row in the Files view. Renaming never replaces an existing destination.

External dependencies shown in Includes cannot be renamed from Quipu. Renaming a file also does not rewrite `include` directives or `quipu.toml`; update those references yourself when necessary.

Moving files between directories and deleting files are not currently offered in the UI. Make those changes with your file manager or another tool; Quipu normally detects them automatically.

## Saving

Choose **File → Save** or press <kbd>Ctrl</kbd>+<kbd>S</kbd> (<kbd>Cmd</kbd>+<kbd>S</kbd> on macOS). A filled dot beside the file name means the editor contains unsaved changes.

**Compile Workspace** also saves modified project sources before invoking the compiler. If several project files are dirty, Quipu treats them as one compile-time save operation.

## Changes made outside Quipu

When an open file changes on disk, Quipu preserves the text already in the editor and marks the conflict instead of silently replacing either version.

- **Save** writes the editor's version to disk. Quipu asks before replacing an externally changed version.
- **Reload from Disk** replaces the editor's text with the current file. Quipu asks first if that would discard unsaved work.

If the file was removed, the editor still holds its text. Saving recreates it; reloading cannot succeed until the path can be read again.

Changes to rules make a previously compiled ruleset **Stale**. Compile again before scanning.

Next: [Compiling and scanning](/docs/compiling-and-scanning/index.html).
