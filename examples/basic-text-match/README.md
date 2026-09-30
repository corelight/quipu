# Basic text match

The smallest useful Quipu project: one rule file, no manifest.

There is no `quipu.toml` here, which is a valid project. Quipu discovers every `.yar` and `.yara` file under the root and infers the entrypoints - the rule files that nothing else includes. `text_indicators.yar` is the only rule file, so it is the entrypoint, and the Includes view shows it as an inferred one.

## Try it

1. **Rules > Compile Workspace** (Ctrl+Shift+B). The status line should report a successful compile of 2 rules, and the Problems tab should be empty.
2. The Scan target is already set to `targets/sample.txt`. **Rules > Scan Target** (Ctrl+Shift+Enter).
3. Both rules match:
   * `example_encoded_command`
   * `example_suspicious_url`
4. Press **Choose file...** and pick `targets/clean.txt` in the same working copy, then Compile is still valid so Scan again: no matches.

## Expected results

| Target | Matching rules |
| --- | --- |
| `targets/sample.txt` | `example_encoded_command`, `example_suspicious_url` |
| `targets/clean.txt` | none |

## Files

* `text_indicators.yar` - both rules; the file Quipu opens first.
* `targets/sample.txt` - an incident note that matches both rules.
* `targets/clean.txt` - an ordinary note that matches neither.

Everything here is plain text describing commands. There is no sample and nothing executable.
