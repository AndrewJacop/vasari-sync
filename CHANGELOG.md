# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] - 2026-08-18

### Added

- **`--config <file>`: multiple profiles on one machine.** Every command
  accepts a global `--config` flag (or the `VSYNC_CONFIG` env var) pointing
  at a complete config file — profiles, credentials, project registry —
  instead of `~/.vsync/config.json`. Two people sharing a device each pass
  their own file (e.g. `alias vsync='vsync --config ~/.vsync/alice.json'`)
  and never collide; the shared default config is untouched while an
  override is active. Missing-profile errors now name the config file in
  use.

## [0.5.1] - 2026-08-16

### Fixed

- **The sync comparison was broken on every real backend.** The
  manifest's sha256 hash was compared against the backend's native
  change indicator (git blob SHA-1 for `github-repo`, MD5 etag for S3,
  opaque etags for WebDAV) — values that can never be equal, so every
  tracked file permanently showed as "changed remotely" and push/pull
  refused each other in a loop. Remote state is now tracked in a small
  `.vsync-index.json` sidecar vsync maintains on the backend itself: one
  hash format everywhere, and `status`/`diff` need a single small fetch
  instead of recursive backend listings.

### Changed

- **Simpler single-user sync model: live two-way compare, direction
  decides the winner.** `status`/`diff` now compare the current local
  files against the backend's current state and report `differs` /
  `missing-locally` / `remote-missing` / `unchanged` (the
  `conflict`/`local-modified`/`remote-modified` split is gone — for a
  single-user tool, "who changed" is always you). `push` makes the
  remote match local (files deleted locally are deleted on the backend);
  `pull` makes local match the remote. The old conflict refusals are
  replaced by a **confirmation-first flow**: interactive `push`/`pull`
  print the full plan — uploads, overwrites, deletions, with local-edit
  and remote-push dates — and ask before anything transfers. `-y/--yes`
  skips the prompt; `--force` is kept as a legacy alias for `--yes`.
- The project manifest is now a plain tracked-paths list — all hash
  bookkeeping lives in the backend-side index, so the manifest can never
  desync from the remote. Old manifests still parse; stale per-file
  fields are dropped on the next write. **After upgrading, the first
  `vsync push` re-uploads identical bytes once to create the index.**
- `link` rebuilds the manifest from the backend's remote index (raw
  file-listing fallback for backends written by older versions).
- `list` no longer counts the sidecar index as a project file.
- `diff --show-values`: `-` is always the remote copy and `+` the local
  one; binary files get a size/date summary instead of garbage diff
  lines.

## [0.5.0] - 2026-08-16

### Added

- **Fully non-interactive mode for every command** (AI agents, CI, and
  the future VS Code extension): each prompt has a flag twin, and with
  no TTY a missing flag either takes a safe default or fails fast naming
  the flag — nothing hangs.
  - `config --backend <name> --set key=value [--secret key=value]` —
    secrets also arrive via `VSYNC_SECRET_<FIELD>` env vars (e.g.
    `VSYNC_SECRET_ACCESS_KEY_ID`); `--secret` beats the env var; a secret
    passed via `--set` is auto-routed to secret storage. A failed
    connection test aborts without saving.
  - `init --project-id / --backend / --files a,b / --yes`, plus
    `init --list` to print candidate files (the agent discovery step).
  - `link --pull` (pull right after linking; headless without the flag
    skips the pull, exit 0).
- **`--json` on every command** — exactly one machine-readable object on
  stdout (warnings/progress/errors on stderr). Partial push/pull results
  are printed before the incomplete error, so agents get per-file detail
  plus exit 1. Non-TTY spinner lines moved to stderr to keep stdout pure.
- README "Scripting & agents" section documenting the flag matrix, secret
  env vars, and the stable JSON shapes.

## [0.4.0] - 2026-08-16

### Added

- `vsync update` — self-update: checks npm for a newer release, confirms,
  and installs it (`--yes` skips the prompt). A registry outage is an
  actionable error, never a silent no-op.
- **`vsync list` reads your backends, not just this machine's registry.**
  Projects are discovered by listing every configured backend profile and
  grouping by `<projectId>/` prefix, so a fresh machine sees every project
  ever pushed before linking anything (with a `vsync link <id>` hint).
  Local registry entries still enrich rows with checkout path, last-sync
  time, and a live file count; `—` marks projects not on any backend.
  Unreachable profiles are warned about and skipped.
- **Spinners on every slow remote step** — backend listings (the shared
  slow call in `status`/`diff`/`push`/`pull`/`link`/`list`), connection
  tests in `config`/`init`, per-file remote fetches in `diff
--show-values`, and `update`'s npm calls, in addition to push/pull
  transfers. Non-interactive output stays clean plain lines.

## [0.3.0] - 2026-08-16

### Added

- **Nested git repos are scanned under the umbrella project.** When the
  parent repo ignores a directory that is itself a git repo (the common
  "umbrella repo ignores `/sub-repo/`" pattern), `vsync init` now
  recurses into it: the sub-repo's own `.gitignore` decides what counts
  as a candidate, paths stay project-root-relative (`sub-repo/.env`),
  and the tree picker tags those folders as nested repos. Previously
  git's collapsed `!! dir/` entry surfaced as one fake file.
- **Tree-mode file picker in `vsync init`.** The flat checklist is now a
  collapsible folder tree: `space` toggles a file or selects/drops a
  whole folder (`[ ]`/`[~]`/`[x]` states), `→`/`←` expand/collapse,
  `a`/`n` select all/none. Suggested files stay pre-checked.
- `vsync push`/`vsync pull` show a transfer spinner naming the file in
  flight, so long uploads (database dumps) visibly aren't stuck. Piped/
  CI output falls back to one plain `Uploading x…` line per file.

### Changed

- `git` requirement for `init`'s scan: sub-repo candidates use each
  sub-repo's own ignore semantics; files tracked inside a sub-repo are
  never candidates (unchanged, now applies recursively too).

## [0.2.0] - 2026-08-16

Cross-device sync rebuilt around one principle: **the manifest never
reaches git** — it lists secret file paths, so it travels backend-side
and is rebuilt on each machine.

### Added

- `vsync link <projectId>` — machine-B bootstrap: rebuilds the manifest
  from the backend listing, registers the project, offers an immediate
  pull. `init` and `link` keep `.vsync/` in the project `.gitignore`.
- `vsync config` (github-repo): reuses the GitHub CLI login token when
  `gh` is signed in (confirm prompt), defaults `owner` to the `gh` login,
  and prints a `gh auth login` tip when no CLI login exists.
- `vsync config`: the github-repo storage-repo field accepts pasted
  SSH/HTTPS URLs, parsed to `owner`/`repo` automatically.

### Changed

- **Removed the per-project `.vsync/config.json`.** It was a snapshot of
  the global profile that could silently go stale; backend wiring now
  resolves at runtime from the manifest's backend name + the global
  profile + global secrets. Delete any leftover copies.
- `init` writes only the manifest; no project file besides it.

### Fixed

- github-repo: connection test accepts an **empty** repository (GitHub
  reports a default branch that doesn't exist until the first push).
- github-repo: Octokit's request-log no longer prints expected 404
  existence checks to the terminal.
- `link`: backend handlers are constructed with profile secrets merged
  in (constructor validation crashed on token-less settings).
- Candidate scanner never offers `.vsync/` metadata as sync candidates.

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
