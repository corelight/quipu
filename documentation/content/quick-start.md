+++
title = "Quick Start"
description = "Open an example, compile its rules, and scan a target"
weight = 1
template = "page.html"
+++

This walkthrough uses a project that ships with Quipu. It works entirely offline and cannot change your own rule repositories.

## 1. Open an example

Choose **File → Open Example…**, then open **Basic text match**. Quipu makes an editable working copy and selects the sample target included with it.

The **Files** view contains one file, `text_indicators.yar`. On a first open, the status below the editor settles on **Not compiled**. If you compiled this unchanged working copy before, Quipu may restore it from the compiled-rules cache instead.

> Example working copies are persistent. If you have opened and changed this example before, Quipu reopens your existing copy and your results may differ from the ones below.

## 2. Explore the rule

Select `text_indicators.yar`. It contains two rules:

- `example_encoded_command` looks for text describing a Base64 decode piped into a shell.
- `example_suspicious_url` looks for a quiet download over plain HTTP.

Hover over rule elements to see language information. The editor reports syntax and semantic issues as you type.

## 3. Make and save an edit

Change some metadata without changing the rule's behaviour—for example, add a few words to one of the `description` strings. Choose **File → Save**, or press <kbd>Ctrl</kbd>+<kbd>S</kbd> (<kbd>Cmd</kbd>+<kbd>S</kbd> on macOS).

The dot beside the file name disappears after the file is saved.

## 4. Compile the workspace

Choose **Rules → Compile Workspace**, or press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> (<kbd>Cmd</kbd> on macOS). A successful compile reports **Compiled ✓ — 2 rules** and enables scanning.

If compilation fails, open **Problems** and select a diagnostic to jump to its source. Correct the rule and compile again.

On Windows, if a successful compilation is forgotten after restarting, check the [Defender cache guidance](/docs/preferences-and-cache/index.html#windows-defender-and-missing-cache-entries).

## 5. Scan the prepared target

The example has already selected `targets/sample.txt`. Choose **Rules → Scan Target**, or press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Enter</kbd> (<kbd>Cmd</kbd> on macOS).

The **Matches** tab opens and reports two matching rules: `example_encoded_command` and `example_suspicious_url`.

## 6. Inspect the result

In **Matches**:

- Select a rule name to return to that rule in the editor.
- Select a pattern identifier such as `$decode` to go to its string definition.
- Select the rest of a match row to open the hex viewer and inspect the matched bytes in context.

You have now exercised Quipu's shortest complete workflow: open, edit, save, compile, scan, and inspect.

Next, read [Workspaces and projects](/docs/workspaces/index.html), or use [Compiling and scanning](/docs/compiling-and-scanning/index.html) as a more detailed reference.
