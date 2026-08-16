# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-08-16

Initial release.

### Added

- Pluggable storage backends: S3-compatible (AWS/MinIO/R2/Spaces), SFTP,
  WebDAV, and private GitHub repo (with native version history).
- `vsync config` — interactive backend/credential setup with connection test.
- `vsync init` — gitignore-aware candidate scanning with boost/suppress
  scoring; manifest and project config creation.
- `vsync add` / `vsync rm` — per-file tracking management.
- `vsync status` — manifest-based change report with three-way conflict
  detection.
- `vsync diff` — tracked-file diff (`--show-values` opt-in) plus untracked
  candidate listing.
- `vsync push` / `vsync pull` — per-file sync with conflict refusal
  (`--force` override) and accurate partial-failure manifest state.
- `vsync list` — known projects from the global registry, with
  missing-on-disk detection.

### Security model

Files are synced **unencrypted** — the backend is expected to be private
storage you own. See README for details.

## Release process

1. Update this changelog: move `[Unreleased]` items into a new version
   heading, add a fresh `[Unreleased]` section.
2. Bump `version` in `package.json` (semver: breaking → major, feature →
   minor while 0.x, fix → patch).
3. Commit: `chore: release vX.Y.Z`.
4. Tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
5. The `Release` GitHub workflow builds, runs the full test suite, and
   publishes to npm using the `NPM_TOKEN` secret. Publishing happens **only**
   on a pushed version tag — never automatically from a branch.
6. Verify: `npx vasari-sync@latest --help` from a clean environment.
