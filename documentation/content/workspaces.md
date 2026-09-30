+++
title = "Workspaces and projects"
description = "Open folders, understand discovery and includes, and configure a project"
weight = 2
template = "page.html"
+++

Quipu calls the folder on screen a **workspace**. Internally, a **project** is that folder together with the configuration and source graph derived from its files. In normal use they describe the same body of rules.

## Starting without a folder

Quipu opens with a scratch rule in the editor. You can edit, compile, and scan from this buffer immediately, which is useful for a quick experiment.

A scratch buffer has no path and cannot be saved. Open a folder before doing work you want to keep. Scratch compilation is held only in memory and is not added to the compiled-rules cache.

## Opening a folder

Choose **File → Open Folder…** and select the root of your rules project. Quipu recursively discovers regular files whose names end in `.yar` or `.yara`, ignoring the case of the extension.

The **Files** view shows the discovered project files as a directory tree. Select a file to open it. A dot marks an open file with unsaved edits; a conflict mark appears if its copy on disk changes or disappears.

Quipu watches the project and its dependencies for changes made by other tools. The views update automatically when watching is available. Use **File → Refresh Project** to force a fresh read; refreshing invalidates the compiled ruleset, even when no change is ultimately found.

Choose **File → Close Workspace** to return to the scratch buffer. Quipu asks before leaving a workspace with unsaved changes.

## Opening an example

**File → Open Example…** lists the projects included with Quipu:

- **Basic text match** is a one-file project with inferred configuration.
- **Nested includes** demonstrates a declared entrypoint and a two-level include graph.
- **Multiple entrypoints** demonstrates several entrypoints compiled in manifest order.

Quipu never edits the packaged templates. It creates an app-owned working copy of an example and reuses that copy later, so your changes persist.

## Entrypoints and includes

An **entrypoint** is a top-level rule source given to the compiler. An entrypoint may include other sources, which may include further sources in turn.

Open the **Includes** view to inspect this graph. It groups sources into entrypoints, other sources, and project problems. Its labels show declared or inferred entrypoints, dependencies outside the project, unresolved includes, cycles, and other conditions that can prevent compilation. Select a source to open it, or select an `include` directive to jump to that line.

Without a manifest, Quipu infers entrypoints: every discovered internal rule file that is not included by another file becomes a root. Independent files are therefore compiled as independent entrypoints.

Include resolution checks locations in this order:

1. The directory containing the file with the `include` directive.
2. Each configured include directory, in manifest order.

The first existing regular file wins. Dependencies outside the workspace are allowed and appear as **external** in the Includes view. Quipu lets you open an external source but does not offer to rename it.

## Configuring `quipu.toml`

A manifest is optional. To control entrypoints, include search paths, or discovery exclusions, create `quipu.toml` in the project root:

```toml
schema = 1
entrypoints = ["rules/main.yar"]
include_dirs = ["rules", "../shared"]
exclude = ["tests/**", "*.tmp.yar"]
```

| Key | Required | Default | Purpose |
| --- | --- | --- | --- |
| `schema` | Yes | — | Manifest format. The current value is `1`. |
| `entrypoints` | No | Inferred | Project-relative `.yar` or `.yara` files, in compilation order. |
| `include_dirs` | No | `["."]` | Search directories relative to the project root, in resolution order. `..` may name a directory outside the project. |
| `exclude` | No | `[]` | Globs applied while discovering project files. Use `**` to cross directory boundaries. |

Manifest paths use `/` separators on every platform. Entrypoints must remain inside the project. Unknown keys, duplicate entrypoints, missing include directories, invalid globs, and unsupported schema values are reported in the Includes view.

An exclusion affects discovery, not include resolution. A source matched by `exclude` can still become a compilation dependency when a reachable file includes it.

Quipu does not currently provide a manifest editor. Edit `quipu.toml` in a text editor, then let Quipu detect the change or choose **Refresh Project**.

Next: [Writing rules](/docs/writing-rules/index.html).
