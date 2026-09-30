+++
title = "Documentation"
sort_by = "weight"
template = "section.html"
+++

Quipu is a local desktop workbench for writing, validating, compiling, and testing YARA rules. It combines a project explorer, a YARA-aware editor, the YARA-X compiler, and a focused results viewer in one application.

> This guide is bundled with Quipu and is available without a network connection.

## Start here

New to Quipu? The [Quick Start](/docs/quick-start/index.html) takes you through the complete workflow using a safe example included with the application.

## The basic workflow

1. **Open a folder** of `.yar` and `.yara` files, or open one of Quipu's examples.
2. **Write and validate** rules in the editor. Quipu supplies completion, hover information, and live diagnostics through its embedded YARA-X language server.
3. **Compile the workspace.** Quipu saves modified project files, analyses the include graph, and compiles the resulting ruleset with YARA-X.
4. **Choose a target** file or enter text, then scan it with the compiled rules.
5. **Inspect the result.** Navigate from diagnostics and matches back to rule definitions, and view matched bytes in context.

## Guide

<div class="doc-grid">
  <a class="doc-card" href="/docs/workspaces/index.html"><strong>Workspaces and projects</strong><span>Folders, examples, discovery, includes, and <code>quipu.toml</code>.</span></a>
  <a class="doc-card" href="/docs/writing-rules/index.html"><strong>Writing rules</strong><span>The editor, file operations, saving, and disk conflicts.</span></a>
  <a class="doc-card" href="/docs/compiling-and-scanning/index.html"><strong>Compiling and scanning</strong><span>Build state, scan targets, and the compile-to-scan cycle.</span></a>
  <a class="doc-card" href="/docs/results-and-diagnostics/index.html"><strong>Results and diagnostics</strong><span>Matches, byte context, compiler output, and project problems.</span></a>
  <a class="doc-card" href="/docs/preferences-and-cache/index.html"><strong>Preferences and cache</strong><span>Fast ruleset restoration, storage limits, and cache controls.</span></a>
  <a class="doc-card" href="/docs/reference/index.html"><strong>Reference and troubleshooting</strong><span>Menus, keyboard shortcuts, current limits, and common fixes.</span></a>
</div>

## How Quipu treats your files

Quipu edits ordinary files in the folder you open. It does not copy a normal project into a private format, and it does not add generated state to the project. The optional `quipu.toml` file describes how the project should be discovered and compiled; compiled cache data is kept in Quipu's application data instead.

Examples are the exception: Quipu copies each shipped example to an editable, app-owned working directory. Your changes to that working copy are kept for the next time you open the example.
