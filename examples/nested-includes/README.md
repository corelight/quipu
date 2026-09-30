# Nested includes

A project whose rules are split across a two-level include graph, with a manifest that says where to look.

`quipu.toml` declares one entrypoint, `main.yar`, and one include directory, `shared`. Quipu resolves an `include` against the including file's own directory first and only then against the declared include directories, which is exactly what YARA-X does. The embedded language server does not yet receive those declared include directories, so the first hop is temporarily written with an explicit project-relative path to keep live editor diagnostics accurate:

* `main.yar` asks for `"shared/base.yar"`, which is found relative to the entrypoint. Once the language server shares Quipu's include configuration, this can return to `"base.yar"` and resolve through the declared include directory.
* `shared/base.yar` asks for `"strings/keywords.yar"`, which is found beside it, at `shared/strings/keywords.yar`.

Open **View > Includes View** to see the graph: `main.yar` -> `shared/base.yar` -> `shared/strings/keywords.yar`.

## Try it

1. **Rules > Compile Workspace** (Ctrl+Shift+B). It compiles 4 rules with nothing in the Problems tab. Three of the four are `private`: they decide the answer without being reported.
2. The Scan target is already set to `targets/sample.txt`. **Rules > Scan Target** (Ctrl+Shift+Enter).
3. One match: `example_staged_downloader`.

## Expected results

| Target | Matching rules |
| --- | --- |
| `targets/sample.txt` | `example_staged_downloader` |

## Files

* `quipu.toml` - schema 1: the declared entrypoint and the include directory.
* `main.yar` - the entrypoint, and the file Quipu opens first.
* `shared/base.yar` - reached through the explicit project-relative include; includes the leaf.
* `shared/strings/keywords.yar` - two private keyword sets.
* `targets/sample.txt` - an incident note that satisfies all three rules.

Everything here is plain text describing commands. There is no sample and nothing executable.
