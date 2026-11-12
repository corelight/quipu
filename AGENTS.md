# Repository guidance

Follow [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and checks
relevant to the change.

## Rust build cache

- Use `app/src-tauri/target` for routine Cargo, Tauri, and UI harness builds
  and tests. Keep `CARGO_TARGET_DIR` unset and do not pass `--target-dir` for
  routine validation.
- Do not create alternate build caches under `/tmp` or elsewhere unless the
  task requires build isolation. Remove any such temporary cache when the
  investigation is finished.
