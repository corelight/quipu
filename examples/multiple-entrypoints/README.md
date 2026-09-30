# Multiple entrypoints

One project, two rulesets, compiled together.

`quipu.toml` declares two entrypoints, `scripts.yar` and `documents.yar`, and each pulls in a keyword set of its own from `parts/`. Neither includes the other, and nothing is included twice: shared dependencies between entrypoints are how a project earns a repeated-inclusion error, so this example keeps them apart.

The declared order is the compile order, and it is preserved rather than sorted. That is visible here because the manifest puts `scripts.yar` first while the Files view, which is sorted by path, puts `documents.yar` first. Open **View > Includes View** to see the two independent trees in the order the manifest declares them:

```
scripts.yar   -> parts/script_keywords.yar
documents.yar -> parts/document_keywords.yar
```

Reordering the `entrypoints` list in `quipu.toml` and pressing **Refresh** reorders the Includes view accordingly.

## Try it

1. **Rules > Compile Workspace** (Ctrl+Shift+B). It compiles 4 rules with nothing in the Problems tab: one reported rule and one private keyword set per entrypoint.
2. The Scan target is already set to `targets/sample.txt`. **Rules > Scan Target** (Ctrl+Shift+Enter).
3. Two matches, one from each entrypoint:
   * `example_office_macro_note`
   * `example_shell_script_note`

## Expected results

| Target | Matching rules |
| --- | --- |
| `targets/sample.txt` | `example_office_macro_note`, `example_shell_script_note` |

## Files

* `quipu.toml` - schema 1: both entrypoints, in the order they are compiled.
* `documents.yar` - the second entrypoint, and the file Quipu opens first because it sorts first by path.
* `scripts.yar` - the first entrypoint.
* `parts/document_keywords.yar`, `parts/script_keywords.yar` - one private keyword set each.
* `targets/sample.txt` - an incident note that satisfies both entrypoints.

Everything here is plain text describing commands. There is no sample and nothing executable.
