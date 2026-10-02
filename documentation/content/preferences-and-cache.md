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

## Windows Defender and missing cache entries

Compiled YARA rules contain detection patterns that Microsoft Defender can mistake for malicious content. If a successful compilation is lost after restarting Quipu, or cache files disappear, open **Windows Security → Virus & threat protection → Protection history**. Look for a detection involving a `rules-…yarc` file under Quipu's cache location, shown in **File → Preferences…**.

When Defender quarantines that file, Quipu can no longer restore the ruleset and removes the metadata that referenced it. A missing artifact can therefore appear in older debug logs as a corrupt cache entry.

If Protection history confirms a false positive, add an exclusion for **only Quipu's compiled-cache directory**:

1. Copy the cache location from **File → Preferences…**. The default is `%LOCALAPPDATA%\com.corelight.quipu\compiled\v1`.
2. Open **Start**, search for **Windows PowerShell**, and choose **Run as administrator**. Accept the elevation prompt.
3. In that window, run the following command. It uses the default location for the account running PowerShell; if your cache location differs or you elevated using a different administrator account, substitute the full location copied from Quipu.

```powershell
Add-MpPreference -ExclusionPath "$env:LOCALAPPDATA\com.corelight.quipu\compiled\v1"
```

Alternatively, add that folder under **Windows Security → Virus & threat protection → Manage settings → Exclusions → Add or remove exclusions**. Organisation policy may require your administrator to make the change. Quipu does not configure Defender exclusions itself.

Reopen Quipu and choose **Compile Workspace** to recreate the missing cache. Restart and open the unchanged project again; it should restore to **Compiled**. The exclusion applies to this cache folder, so keep rule repositories and scan targets elsewhere.

To remove the exclusion later, run this in an elevated PowerShell window using the same folder you excluded:

```powershell
Remove-MpPreference -ExclusionPath "$env:LOCALAPPDATA\com.corelight.quipu\compiled\v1"
```

Next: [Reference and troubleshooting](/docs/reference/index.html).
