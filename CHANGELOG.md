# Changelog

All notable changes to this extension are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/).

## [0.2.1](https://github.com/MeirBen/commit-draft/compare/v0.2.0...v0.2.1) (2026-11-09)


### Fixed

* show sizes just under 1 MB as 1 MB instead of 1024 KB ([66883a9](https://github.com/MeirBen/commit-draft/commit/66883a97b524db2d406a65a2c65262a5fbda9270))

## [0.2.0] - 2026-11-09

First Marketplace release.

### Added in 0.2.0

- Large diffs are condensed to fit instead of being rejected: every changed file is listed with its line counts, long patches are shortened, and lock and minified files are listed only.
- Provider failures show the provider's own reason, such as an unknown model or an expired sign-in.
- A missing executable or a timeout offers an **Open Settings** button that opens the setting that fixes it.
- The progress notification shows which changes are used, how many files and how large the diff is, and whether it was condensed.
- The provider picker marks the current provider.

### Changed in 0.2.0

- Renamed to **Commit Draft** (extension ID `meirb.commit-draft`). Setting names are unchanged.
- The **Generate** button is in the Source Control title bar. The button inside the message box needed a proposed VS Code API, which Marketplace extensions cannot use.
- `commitDraft.maxDiffBytes` now defaults to 256 KB (was 100 KB) and sets the size sent in full rather than a hard limit.
- Git commands may take up to 60 seconds (was 15) in large repositories.

### Removed in 0.2.0

- The **Stop** button inside the message box. Use **Cancel** on the progress notification instead.

## [0.1.2] - 2026-11-07

Not published.

### Added in 0.1.2

- Experimental **Generate** and **Stop** buttons inside the commit-message box, using a proposed VS Code API.

## [0.1.1] - 2026-11-07

Not published.

### Added in 0.1.1

- Generation waits for VS Code's Git extension to finish starting.
- Settings are validated before anything runs, with an **Open Settings** button on errors.

### Changed in 0.1.1

- Clearer messages when Git is disabled, no repository is open, or a command times out.

## [0.1.0] - 2026-11-07

Not published.

### Added in 0.1.0

- Commit-message drafts from staged or tracked unstaged changes, using the Codex CLI or Claude Code.
- **Generate** button in the Source Control title bar and a command to select the provider.
- Optional Conventional Commits format, custom executable paths and models, and timeout and size settings.
