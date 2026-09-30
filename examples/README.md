# Quipu example projects

Each directory here is a complete, self-contained Quipu project: rule files, an optional `quipu.toml` manifest, and a small text file under `targets/` to scan. They exist to be opened from **File > Open Example...**, and they are also the fixtures the backend's example tests analyse, compile and scan.

## The catalog

The catalog is fixed in Rust, in `app/src-tauri/src/examples.rs`. There is deliberately no second copy in TypeScript: the chooser asks the backend for the list, so the two cannot drift. An entry names the directory below, the sample target inside it, and a working-copy revision.

| Directory | Shown as | Demonstrates |
| --- | --- | --- |
| `basic-text-match` | Basic text match | A project with no manifest at all, so Quipu infers the entrypoint |
| `nested-includes` | Nested includes | A declared entrypoint, an include directory, and a two-level include graph |
| `multiple-entrypoints` | Multiple entrypoints | Several independent entrypoints compiled in the order the manifest declares |

## Source tree, package, working copy

The same tree exists in three places, and only the last one is editable:

1. **This directory** is the source of truth. It is committed, and it is what the tests read.
2. **The packaged resource** is a copy made at build time. `bundle.resources` in `app/src-tauri/tauri.conf.json` maps `../../examples` to the resource path `examples`, so a bundled Quipu finds a project at `<resources>/examples/<directory>`. `tauri-build` also copies it into the Cargo target directory, which is where a development build resolves the same resource path.
3. **The working copy** is what Quipu actually opens: `<app-local-data>/examples/<id>/v<revision>/`. The packaged resource is a read-only template and is never opened or edited in place. The first open copies it; every later open of the same revision reuses the copy, so edits survive. Raising an entry's `revision` in the catalog gives the next open a new directory rather than overwriting a copy someone has edited.

So editing a file in an example inside Quipu changes the working copy only. To change what new users get, edit the files here.

### How the working copy is created

The copy is committed, not assembled in place. Quipu copies the template into a staging directory of its own beside the destination, writes a `.quipu-example` marker file last, and only then moves the finished tree onto `v<revision>` with an atomic no-replace rename. So the directory Quipu opens is only ever absent or complete, and the marker inside it is what a later open looks for. Two Quipu windows opening the same example meet only at that rename: one installs its copy and the other reuses it, after checking that what is there really is a marked working copy. No-replace is the point of it - an ordinary rename would replace an existing empty directory - so the rename itself is what refuses, not a check beforehand.

Nothing is ever deleted or replaced to make room. If something is already at that path without an acceptable marker, Quipu preserves it and reports that it refused to replace the directory - it cannot be a half-finished copy of Quipu's own, since a copy in progress never has that name, so it is a restored backup, a directory somebody created, or a working copy whose marker has gone. Deleting the whole directory is how to start again from the packaged template; deleting only the marker is not, and leaves a directory Quipu will refuse to use. An attempt that is killed mid-copy leaves its own staging directory behind, which is inert - it has a name no open looks for, and removing another attempt's staging directory could destroy a copy still being made.

## Writing another example

* Keep it deterministic and platform-independent: text targets, no absolute paths, no symlinks, no generated artifacts, no binaries.
* Write your own rules. Nothing here is a third-party rule collection, and no target is a real sample.
* Give the project a `README.md` explaining what it demonstrates and stating the exact expected matches.
* Repeat those instructions as a comment at the top of the rule file Quipu opens first, which is the first readable rule file in identity order (`/`-separated relative path, sorted lexicographically). `README.md` and `targets/` never appear in the rule-files tree, so the comment is the only in-app instruction.
* Add the entry to `EXAMPLES` in `app/src-tauri/src/examples.rs` and to the expectation table in `app/src-tauri/src/examples/tests.rs`, which asserts the documented compile and scan results.
