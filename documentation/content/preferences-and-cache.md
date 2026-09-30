+++
title = "Preferences and cache"
description = "Control compiled-rules restoration and its local storage"
weight = 6
template = "page.html"
+++

Quipu can store a successful project compilation in a local cache. Reopening an unchanged project can then restore scan-ready rules without compiling them again.

## How restoration works

When you open a project, the build status briefly says **Checking compiled cache…**. Quipu still analyses the project and validates all compilation inputs. It uses an entry only when the manifest, entrypoints, include resolution, source contents, compiler compatibility, and other relevant inputs agree.

On a valid hit, Quipu restores the rules, rule count, and compilation diagnostics and enters the **Compiled** state. On a miss, it stays **Not compiled**; choose **Compile Workspace** as usual. Compile itself can also use an existing valid entry.

The cache is an optimisation only. If its storage is unavailable or an entry is invalid or corrupt, normal project editing and fresh compilation continue to work.

Cache entries are stored in Quipu's operating-system application cache, never in the rules project. Scratch-buffer compilations are not cached.

## Cache settings

Choose **File → Preferences…** to open **Compiled-rules cache** settings. The cache is enabled by default with a 1 GiB maximum.

The dialog lets you:

- enable or disable future cache reads and writes
- set the maximum storage size in whole MiB
- inspect total usage and the current workspace's usage
- see the effective cache location
- clear the current workspace's entry
- clear all compiled-rules entries

Select **Save cache settings** after changing the enabled state or maximum size.

When usage exceeds the configured maximum, Quipu removes older entries to bring usage back under its managed limit. The active project's entry is protected from ordinary maintenance where possible.

## Disabling and clearing

Disabling the cache stops future reads and writes but does not delete entries already on disk. Use **Clear Current Workspace Cache** or **Clear All Caches** to remove them; Quipu asks for confirmation first.

Clearing disk cache entries does not unload the ruleset already held in memory. If the current project was compiled before you cleared it, you can continue scanning until an edit, refresh, project change, or other normal invalidation makes that ruleset stale.

Next: [Reference and troubleshooting](/docs/reference/index.html).
