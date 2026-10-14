# Changelog

This file records notable user-visible changes to Quipu. The public changelog
begins with the first open-source release; earlier versions were internal
development builds.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and Quipu uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Upgrade the YARA-X compiler, include parser, and language server together to
  1.21.0, including upstream scan correctness and parser memory improvements.
  Compiled caches from older engine versions require recompilation.

### Added

- Separate offline Windows NSIS and MSI installers with the full WebView2
  runtime installer embedded for air-gapped installation.
- Experimental macOS 15+ CI builds for Apple Silicon and Intel, with ad-hoc
  signed DMGs, package validation, and development instructions. These builds
  are not notarized and are not yet included in releases.

### Fixed

- Enable YARA semantic highlighting explicitly and retain editor features when
  upgrading Monaco to 0.57.
- Native menu commands and keyboard shortcuts losing their callbacks after the
  Tauri dependency update.
- Delayed macOS file-watcher notifications from Quipu's own writes unnecessarily
  invalidating compiled rules after the save fence ends.

## [0.3.0] - 2026-10-04

### Added

- Windows x86-64 builds with NSIS and MSI installers and WebView2 runtime setup.
- Windows CI tests and installer validation, with Linux and Windows packages
  collected together for releases and covered by a combined `SHA256SUMS` file.
- Windows installation, development, and Defender cache troubleshooting guidance.
- Debug trace details for cache persistence outcomes and missing artifacts.

### Fixed

- Late Windows file-watcher events from removed nested watches causing
  unnecessary project refreshes after coverage is narrowed.
- Help and Quick Start window creation deadlocking on Windows, leaving blank
  documentation and preventing the application from closing.
- Outer window scrollbars caused by the collapsed results-pane button extending
  beyond the viewport.
- Cache maintenance deleting valid entries after temporary read failures,
  including Windows file-sharing conflicts.

## [0.2.0] - 2026-10-01

### Added

- Initial open-source MVP for Linux x86-64.
- YARA rule workspaces with inferred or configured entrypoints and includes.
- Monaco-based editing with an embedded YARA-X language server.
- YARA-X compilation, single-target scanning, match navigation, and a hex
  viewer.
- Bundled example projects and offline documentation.
- A bounded compiled-rules cache.

[Unreleased]: https://github.com/corelight/quipu/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/corelight/quipu/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/corelight/quipu/releases/tag/v0.2.0
