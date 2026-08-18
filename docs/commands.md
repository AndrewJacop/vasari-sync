# `vsync` command reference

`vsync` syncs git-ignored project files (`.env`, secrets, local config) to
storage you already own. Run `vsync --help` for the abbreviated list; this
document covers every command and flag with example output.

Conventions used below:

- Commands that operate on a project (`init`, `add`, `rm`, `status`,
  `diff`, `push`, `pull`) run against the current working directory and
  require it to be initialized (`vsync init` once, earlier). Otherwise
  they fail with:
  `[vsync] No .vsync/manifest.json found — run`vsync init`in this project first.`
- On failure the CLI prints `[vsync] <message>` to stderr and exits `1`.
- Paths in all output are project-relative and forward-slashed, even on
  Windows.
- Any potentially slow remote step (backend listings, connection tests,
  per-file transfers) shows a spinner naming what's happening; piped/CI
  output prints one plain progress line per step instead (on stderr).
- **Non-interactive:** every command runs without a TTY. Each prompt has
  a flag twin — a flag wins, a TTY prompts as before, and headless with
  no flag you get a safe default or a fast exit `1` naming the missing
  flag. See [Scripting & agents](#scripting--agents) below.
- **`--json`:** every command accepts it and prints exactly one
  machine-readable object on stdout (pretty-printed). Warnings, progress
  lines, and errors go to stderr; exit codes stay 0/1. On a partial
  push/pull the result object is printed _before_ the incomplete error,
  so callers get per-file detail plus exit 1.

Contents: [config](#vsync-config) · [init](#vsync-init) · [add](#vsync-add) ·
[rm](#vsync-rm) · [status](#vsync-status) · [diff](#vsync-diff) ·
[push](#vsync-push) · [pull](#vsync-pull) · [list](#vsync-list) ·
[update](#vsync-update) · [global flags](#global-flags)

---

## `vsync config`

One-time-per-machine setup: pick a storage backend, enter its settings and
credentials, test the connection, save. Interactive by default; fully
drivable by flags (see below) for agents and CI.

- Non-secret settings are saved to a **profile** in `~/.vsync/config.json`
  (`profiles.<backend>.settings`).
- Secrets (marked \* in the backend table below) are saved to the same
  file's separate `secrets` map with `0600` file permissions — never into
  any project file. The first time a secret is stored, a one-time notice
  is printed:

  ```text
  [vsync] No OS keychain integration is used — secrets are stored in ~/.vsync/config.json (0600). Treat that file like an SSH private key.
  ```

- The connection is tested via the backend's `testConnection` before
  anything is saved; on failure you're asked whether to save anyway.
- The configured backend also becomes your **default** (pre-selected by
  `init`).
- Re-running `vsync config` on an existing profile pre-fills non-secret
  fields; password-style prompts show `(blank keeps existing)` so you can
  keep stored secrets without retyping them.

#### GitHub CLI reuse (`github-repo`)

If the GitHub CLI (`gh`) is installed and signed in, `vsync config` offers
its stored token — no personal access token needed. The owner field
defaults to your `gh` login, and the repo field accepts a bare name or a
pasted URL (`git@github.com:owner/repo.git`, `https://github.com/owner/repo`),
which is parsed to `owner`/`repo` automatically. Without a `gh` login, a
tip points at `gh auth login`; when a reused token fails the connection
test, the failure suggests `gh auth status` (scopes) or declining the
reuse to enter a PAT.

An **empty** repository is a valid target — GitHub creates the default
branch on vsync's first push, so the connection test reports it as OK.

### Flags

| Flag                      | Effect                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| (none)                    | Interactive setup, as above                                                                         |
| `--show`                  | Print the saved config with secrets redacted                                                        |
| `--set-default <backend>` | Change the default backend without prompts                                                          |
| `--backend <name>`        | Non-interactive: which backend to configure (validated against the registry)                        |
| `--set <key=value>`       | Non-interactive: set a non-secret setting (repeatable). Secret fields passed this way auto-route to |
|                           | secret storage, never the plaintext profile. Values typed by the field's kind (yes/no, number)      |
| `--secret <key=value>`    | Non-interactive: set a secret (repeatable). Visible in process listings — prefer the env vars below |
| `--json`                  | Machine-readable output                                                                             |

Passing any of `--backend`/`--set`/`--secret` switches to the
non-interactive path: no prompts, and a **failed connection test aborts
without saving** (an agent can't answer "save anyway?" — fix credentials
and retry). `--backend` falls back to the saved default when omitted.

Secret fields can also arrive via environment variables — constant-case
field name with a `VSYNC_SECRET_` prefix. Precedence:
`--secret` > env var > previously saved secret. A `gh` CLI token is
reused automatically for `github-repo` when no other token is supplied.

| Backend       | Secret env vars                                                |
| ------------- | -------------------------------------------------------------- |
| `s3`          | `VSYNC_SECRET_ACCESS_KEY_ID`, `VSYNC_SECRET_SECRET_ACCESS_KEY` |
| `sftp`        | `VSYNC_SECRET_PASSWORD`                                        |
| `webdav`      | `VSYNC_SECRET_PASSWORD`                                        |
| `github-repo` | `VSYNC_SECRET_TOKEN`                                           |

The `repo` field accepts a pasted URL in `--set repo=...` exactly like the
interactive prompt — the URL's owner wins over a typed `--set owner`.

### Backend fields (prompt order)

| Backend       | Fields (asterisk = secret)                                                                                                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `s3`          | `region`, `bucket`, `endpoint` (blank = AWS), `accessKeyId` \*, `secretAccessKey` \*, `forcePathStyle` (yes/no — enable for MinIO and most S3-compatible stores)                                |
| `sftp`        | `host`, `port` (blank = 22), `username`, `password` \*, `privateKeyPath` (optional, instead of password), `remoteBasePath`                                                                      |
| `webdav`      | `url`, `username` (optional), `password` \*, `remoteBasePath`                                                                                                                                   |
| `github-repo` | `owner` (defaults to `gh` login), `repo` (bare name or paste its URL), `branch` (blank = repo default), `token` \* (reused from the `gh` CLI login when available), `remoteBasePath` (optional) |
| `local-fs`    | `basePath` (directory the files are stored under)                                                                                                                                               |

### Examples

```console
$ vsync config
? Which storage backend? s3
? Region us-east-1
? Bucket my-private-bucket
? Custom endpoint (blank for AWS) http://localhost:9000
? Access key ID ********************************
? Secret access key ********************************
? Use path-style addressing Yes
Connection OK (s3).
[vsync] No OS keychain integration is used — secrets are stored in ~/.vsync/config.json (0600). Treat that file like an SSH private key.
Saved 's3' profile (s3/accessKeyId, s3/secretAccessKey stored as secrets) and set it as your default backend.
```

```console
$ vsync config --show
Default backend: s3

Profile 's3' (backend: s3):
  region: us-east-1
  bucket: my-private-bucket
  endpoint: http://localhost:9000
  forcePathStyle: true
  accessKeyId: [redacted]
  secretAccessKey: [redacted]
```

```console
$ vsync config --set-default sftp
Default backend set to 'sftp'.
```

---

## `vsync init`

First-time setup inside a project (run from the project root; must be a
git repository). Interactive. Steps:

1. **Project ID** — defaults to the folder name; must be unique across
   your registered projects. It becomes the storage prefix, so projects
   sharing a backend never collide.
2. **Backend** — pre-selects your default; shows `(saved profile)` next to
   backends you've configured. Credentials are _not_ prompted here — they
   come from the profile saved by `vsync config` (init fails actionably if
   no profile exists yet).
3. **Connection test** — as in `config`; you may continue despite a
   failure.
4. **File selection** — a **folder-tree checklist** of everything git
   ignores, minus suppressed entries (`node_modules/`, `dist/`, other
   build/cache dirs, files > 10 MB). Files matching `.env*`, `*secret*`,
   `*credential*`, `*.pem`, `*.key`, `id_rsa*`, `config.local.*` (each
   ≤ 50 KB) are tagged `suggested` and **pre-checked**.

   | Key     | Action                                                                                                                       |
   | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
   | `↑`/`↓` | move (wraps around)                                                                                                          |
   | `space` | toggle a file; on a folder, select its whole subtree — or clear it when fully selected (`[ ]` none / `[~]` some / `[x]` all) |
   | `→`/`←` | expand / collapse a folder (all start collapsed)                                                                             |
   | `a`/`n` | select all / none                                                                                                            |
   | `enter` | confirm                                                                                                                      |

   **Nested git repos:** directories the parent repo ignores that are
   themselves git repos (the umbrella pattern — parent `.gitignore` has
   `/sub-repo/`) are scanned recursively: the sub-repo's own
   `.gitignore` decides its candidates, files appear under their
   project-relative paths (`sub-repo/.env`), and those folders are
   tagged `nested repo`. A sub-repo's _tracked_ files are never offered.

On confirm: writes `.vsync/manifest.json` (backend name + tracked-file
ledger) and registers the project in `~/.vsync/config.json` (what
`vsync list` shows). No per-project config file is written — backend
settings/credentials resolve from the global profile at runtime.

Re-running `init` on an initialized project warns first (re-initializing
replaces the tracked-file list; deselected files are untracked, never
deleted) and asks for confirmation (or takes `--yes`).

### Flags

| Flag                | Effect                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| `--project-id <id>` | Non-interactive: project ID (headless default: folder name)                                                |
| `--backend <name>`  | Non-interactive: backend for this project (headless default: the global default backend)                   |
| `--files <a,b>`     | Non-interactive: project-relative paths to track (repeatable, comma-split; omitted = track nothing). Every |
|                     | path must exist and be a regular file — validated all-or-nothing. The scorer's rules do NOT filter these — |
|                     | an explicit path is always honored                                                                         |
| `--yes`             | Re-initialize despite the existing manifest (headless without it: exit 1, nothing changed)                 |
| `--list`            | Print the candidate files (same scan as the picker: path, size, `boosted`/`shown` classification) and exit |
| `--json`            | Machine-readable output                                                                                    |

Headless defaults mirror the interactive ones: project ID ← folder name,
backend ← global default, files ← none (track later with `vsync add`).
A failed connection test aborts headless (nothing written) instead of
offering the continue-anyway confirm.

### Example (non-interactive)

```console
$ vsync init --project-id my-project --files .env,.env.staging
Connection OK (s3).
Initialized 'my-project' (backend: s3).
Tracking 2 file(s): .env, .env.staging. Nothing has been uploaded yet — run `vsync push`.
```

```console
$ vsync init --list
Candidate files (same scan as `vsync init`):
  .env (26 bytes) — suggested (pattern:.env*)
  local-notes.txt (16 bytes)
```

### Example

```console
$ vsync init
? Project ID my-project
? Which storage backend for this project? s3 (saved profile)
Connection OK (s3).
? Files to track — 3 selected
    ▸ [~] optolink-backend   nested repo · 4 files
    ▸ [x] optolink-portal    nested repo · 2 files
      [ ] local-notes.txt   16 B
Initialized 'my-project' (backend: s3).
Tracking 3 file(s): optolink-backend/.env, optolink-backend/.env.test, optolink-portal/.env. Nothing has been uploaded yet — run `vsync push`.
```

A project with no ignored files skips the checklist:

```console
Initialized 'my-project' (backend: s3).
No files tracked yet — add some later with `vsync add <path>` or re-run `vsync init`.
```

---

## `vsync link <projectId>`

The machine-B half of the model. The manifest never travels through git
(it lists secret file _paths_); `init` and `link` keep `.vsync/` in the
project's `.gitignore`. On a fresh clone, `link` rebuilds the manifest from
the backend: the tracked paths come from the backend's remote index
(`.vsync-index.json` — falling back to the raw file listing for backends
written by older vsync versions), the project joins `~/.vsync/config.json`,
and vsync offers to pull immediately.

The project ID is whatever `vsync list` shows on the machine that pushed
(it defaults to the project folder name at `init` time). Backend profiles
are scanned in config order — the first profile with files under the ID's
prefix wins.

### Flags

| Flag     | Effect                                                                                                                      |
| -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `--pull` | Pull the tracked files immediately after linking. Interactively this is the post-link prompt's default; headless without it |
|          | the pull is simply skipped — linking itself succeeded, so exit stays `0`                                                    |
| `--json` | Machine-readable output (with `--pull`, the nested pull result rides along under `pull`)                                    |

### Example (fresh clone)

```console
$ vsync link my-project
Linked 'my-project' (backend: s3) — 2 tracked file(s): .env, local-notes.txt.
? Pull the files now? Yes
  .env — pulled
  local-notes.txt — pulled
Summary: 2 pulled
```

Declining the pull leaves the tracked paths in place with no local
files: `vsync status` reports them as missing-locally until a pull
restores them, and a later pull only overwrites files that actually
differ from the backend.

---

## `vsync add`

`vsync add <path...>` — track files individually, outside the `init`
flow. Paths are relative to the project root (absolute paths inside the
project are accepted too). Adds manifest entries only: **nothing is
uploaded** and local files are untouched — `vsync push` does the upload.

All-or-nothing: if any listed path is already tracked, missing, or not a
regular file, nothing is added.

### Example

```console
$ vsync add config.local.json
Added 1 file(s) to tracking: config.local.json.
Nothing was uploaded — run `vsync push` to sync tracked files.

$ vsync add .env
[vsync] Cannot add: '.env' is already tracked. Nothing was added.
```

---

## `vsync rm`

`vsync rm <path...>` — stop tracking files. Removes the manifest entries
only: **local files are NOT deleted**, and copies already in storage stay
there until deleted on the backend itself.

All-or-nothing: if any listed path isn't tracked, nothing is removed.

### Example

```console
$ vsync rm local-notes.txt
Removed 1 file(s) from tracking: local-notes.txt.
Local files were NOT deleted, and any copies already pushed stay in storage until you delete them there.
```

---

## `vsync status`

Cheap, read-only report. Hashes every tracked file locally and compares
against the backend's **current state** — tracked in `.vsync-index.json`, a
small index file vsync maintains on the backend (one small fetch; no
per-file downloads) — grouping files most-urgent first. Prints **paths and
statuses only** — never contents or values.

### Sections (skipped when empty)

| Section header                                            | Meaning                                                                    |
| --------------------------------------------------------- | -------------------------------------------------------------------------- |
| `Differ (local ≠ remote — push or pull to align):`        | the local and remote copies differ; the direction you pick wins            |
| `Missing locally (pull restores; push deletes remotely):` | tracked, but no local file — `pull` restores it; `push` deletes the remote |
| `Not on remote (never pushed, or deleted there):`         | `vsync push` uploads it                                                    |
| `In sync:`                                                | nothing to do                                                              |

### Example

```console
$ vsync status
Project 'my-project' (backend: s3) — 3 tracked file(s)

Differ (local ≠ remote — push or pull to align):
  .env

Not on remote (never pushed, or deleted there):
  config.local.json

In sync:
  .env.production
```

A file missing on both sides (tracked locally deleted, never pushed) is
listed under _Missing locally_ with a `(no local copy either)` note.

---

## `vsync diff`

Like `status`, but limited to files that **differ** (no "In sync"
section), plus an **untracked candidates** section reusing the same scan
`init` uses — handy for noticing a newly created `.env` you haven't
tracked yet. Paths only by default.

### Flags

| Flag            | Effect                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| (none)          | Differing paths + untracked candidates                                                                      |
| `--show-values` | Additionally print real line-by-line content diffs (`-` = remote, `+` = local; binary files get a size/date |
|                 | summary). **This prints secret values to your terminal** — opt-in only                                      |

### Example (default)

```console
$ vsync diff
Differ (local ≠ remote — push or pull to align):
  .env
2 tracked file(s), 1 differ

Untracked candidates (same scan as `vsync init`):
  .env.staging (210 bytes) — suggested (pattern:.env*)
  local-notes.txt (16 bytes)
```

### Example (`--show-values`)

Git-style diffs under a per-file header. `-` lines are the remote copy,
`+` lines are the local one.

```console
$ vsync diff --show-values

── .env (differs) ──
--- a/.env remote
+++ b/.env local
@@ -1,2 +1,3 @@
 A=1
-B=2
+B=2
+C=3
```

Files missing one side get a note instead of a diff — e.g.
`(no remote copy — never pushed, or deleted on the backend)`. Binary
files get a summary line (sizes + remote push date) instead of garbage
diff output.

---

## `vsync push`

Make the backend match local (**mirror semantics**). The current local
files are compared against the backend's current state (the remote
index), then — on interactive terminals — the full plan is printed for
confirmation before anything transfers: uploads, overwrites, and
deletions, each with the local-edit and remote-push dates. Per-file
outcomes (never all-or-nothing — one failing file doesn't block the
others):

| Per-file line                                  | When                                                                        |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| `pushed`                                       | uploaded — new on the backend, or overwriting a differing remote copy       |
| `deleted on the backend (was missing locally)` | the local file was deleted; push mirrors that deletion remotely             |
| `skipped (unchanged)`                          | local content matches the backend                                           |
| `skipped (no local copy, no remote copy)`      | exists nowhere; nothing to do                                               |
| `FAILED (…)`                                   | backend error; the remote index stays accurate for everything that uploaded |

After any successful run, the remote index (`.vsync-index.json` on the
backend) is rewritten to describe exactly what the backend now holds —
only successful transfers are recorded, so a partial failure never
lies. Any failure exits `1` with `[vsync] Push incomplete — …` even
though the successful uploads stand.

While transfers run, a spinner names the file in flight
(`⠋ Uploading dump.sql (330 KB)`) so long uploads visibly aren't stuck;
non-interactive output (pipes, CI) prints one plain `Uploading x…` line
per file instead.

### Flags

| Flag          | Effect                                                             |
| ------------- | ------------------------------------------------------------------ |
| `-y, --yes`   | Skip the confirmation prompt (also implied by `--json`/piped runs) |
| `-f, --force` | Legacy alias for `--yes`                                           |

### Example

```console
$ vsync push
Project 'my-project' (backend: s3) — 3 tracked file(s)
Upload (new on the backend):
  config.local.json (local edited 2026-08-16 09:41)
Upload (OVERWRITE the remote copy — local wins):
  .env (local edited 2026-08-16 09:41, remote pushed 2026-08-15 10:22)
? Proceed with push? Yes
  .env — pushed
  .env.production — skipped (unchanged)
  config.local.json — pushed
Summary: 2 pushed, 1 skipped (unchanged)
```

---

## `vsync pull`

Make local match the backend (mirror of `push`). Downloads files whose
remote copy differs from local and files missing locally (restored);
local files with no remote copy are reported, never deleted. Interactive
runs show the plan (overwrites and restores, with dates on both sides)
and ask for confirmation first. Per-file outcomes:

| Per-file line                                                       | When                                                  |
| ------------------------------------------------------------------- | ----------------------------------------------------- |
| `pulled (local overwritten)`                                        | the remote copy differs — local replaced, remote wins |
| `restored (was missing locally)`                                    | no local file; fetched from the backend               |
| `skipped (unchanged)`                                               | local content matches the backend                     |
| `skipped (no remote copy — push to upload, or`vsync rm`to untrack)` | not on the backend                                    |
| `skipped (no local copy, no remote copy)`                           | exists nowhere                                        |
| `FAILED (…)`                                                        | backend error                                         |

A fresh `git clone` (which carries `.vsync/` but none of the secret
files) shows every tracked file as _missing locally_ — one `vsync pull`
restores them all. Transfers show the same spinner as `push`
(`⠋ Downloading x…`). `pull` never touches the remote index — the
backend didn't change. Any failure exits `1` (`[vsync] Pull incomplete —
…`) with successful downloads still applied.

### Flags

| Flag          | Effect                                                             |
| ------------- | ------------------------------------------------------------------ |
| `-y, --yes`   | Skip the confirmation prompt (also implied by `--json`/piped runs) |
| `-f, --force` | Legacy alias for `--yes`                                           |

### Example

```console
$ vsync pull
Project 'my-project' (backend: s3) — 3 tracked file(s)
Download (OVERWRITE the local file — remote wins):
  .env (local edited 2026-08-16 08:02, remote pushed 2026-08-16 09:58)
? Proceed with pull? Yes
  .env — pulled (local overwritten)
  .env.production — restored (was missing locally)
  config.local.json — skipped (unchanged)
Summary: 1 pulled, 1 restored, 1 skipped (unchanged)
```

---

## `vsync list`

Projects merged from **two sources**: every configured backend profile
is listed live (each top-level `<projectId>/` prefix is a project) and
the local registry (`~/.vsync/config.json`) adds the checkout path and
last-sync time. A fresh machine therefore sees projects it has never
linked — with a `vsync link <id>` hint — and machines that pushed show
full rows. A registered path that no longer exists (moved/deleted) is
marked `(missing on disk)`; a project absent from every backend shows
`—` instead of a file count. Unreachable profiles are warned about and
skipped — never an error.

One registry entry exists per project ID: pulling the same project from
a second checkout re-points the entry to that checkout's path.

### Example

```console
$ vsync list
Known projects (2):
  my-project   s3           3 files  2026-08-15 10:22  D:\code\my-project
  OPTOLINK     github-repo  7 files  not linked here — run `vsync link OPTOLINK`
```

With no profiles configured, `vsync list` points at `vsync init`; with
profiles but nothing pushed yet, it points at `init` + `push`.

---

## `vsync update`

Self-update: checks the npm registry for a newer `vasari-sync`, shows
`current → latest`, asks for confirmation, and runs
`npm install -g vasari-sync@latest`. `--yes` skips the prompt;
`--json` emits `{current, latest, updated}`.

```console
$ vsync update
? Update vasari-sync 0.3.0 → 0.4.0? Yes
Updated vasari-sync 0.3.0 → 0.4.0.
(the running session keeps the old version; new runs pick up the new one)
```

```console
$ vsync update
vasari-sync 0.4.0 — already up to date.
```

A registry/network outage fails with
`[vsync] could not reach the npm registry — <cause>` rather than
silently doing nothing.

---

## Global flags

| Flag              | Effect                                                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--config <file>` | Use this config file instead of `~/.vsync/config.json` — one file per user on a shared device (multi-profile). Accepted before or after the subcommand; equivalent to the `VSYNC_CONFIG` env var |
| `--version`       | Print the installed `vsync` version                                                                                                                                                              |
| `--help`          | Command list; `vsync <command> --help` for a single command's flags                                                                                                                              |
| `--json`          | On every command: one machine-readable object on stdout — see below                                                                                                                              |

### Multiple profiles (`--config`)

Every command reads its profiles, secrets, and project registry from one
config file — `~/.vsync/config.json` by default, or any file passed via
`--config <file>` (same value as the `VSYNC_CONFIG` env var). Two people
sharing a machine each keep their own file and never collide:

```console
$ VSYNC_SECRET_ACCESS_KEY_ID=… VSYNC_SECRET_SECRET_ACCESS_KEY=… \
    vsync --config ~/.vsync/alice.json config --backend s3 --set region=eu-west-1 --set bucket=alices-vault
Connection OK (s3).
Saved 's3' profile (…) and set it as your default backend.

$ alias va='vsync --config ~/.vsync/alice.json'
$ va init --project-id myapp --files .env
$ va push
```

While `--config` (or `VSYNC_CONFIG`) is set, `~/.vsync/config.json` is never
read or written — `vsync list` shows only that file's registry, and a
missing-profile error names the file in use.

---

## Scripting & agents

Every command runs without a TTY. Each interactive prompt has a flag
twin: a flag wins, a TTY prompts as before, and with no TTY the missing
flag either takes a safe default or fails fast naming the flag — nothing
hangs. Exit codes: `0` success, `1` failure (a partial push/pull is a
failure; its per-file results still print first).

### Behavior contract

- **stdout** carries exactly one JSON object (pretty-printed, 2-space
  indent) when `--json` is passed — nothing else ever lands there.
- **stderr** carries warnings, progress lines, and error messages.
- On a partial push/pull the result object is printed _before_ the
  incomplete error, so callers get per-file detail plus exit 1.
- JSON shapes are stable: additive changes only; breaking changes require
  a major version bump.

### JSON shapes per command

| Command         | Shape (top-level keys)                                                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`        | `{projectId, backend, files: [{path, status, note?}]}` — `status` ∈ `differs`/`missing-locally`/`remote-missing`/`unchanged`                          |
| `diff`          | `{projectId, backend, files: [{path, status}], candidates: [{path, size, classification, rule?}], patches?}` — `patches` only with `--show-values`    |
| `list`          | `{projects: [{projectId, backend, fileCount\|null, linked, path?, lastSyncedAt?, missingOnDisk?}], unreachable: [string]}`                            |
| `init`          | `{projectId, backend, files: [string]}`; `init --list` → `{candidates: [...]}`                                                                        |
| `link`          | `{projectId, backend, files: [string], pull?}` — `pull` (a full pull result) present only with `--pull`                                               |
| `push` / `pull` | `{projectId, backend, files: [{path, outcome, note?}], summary: {<outcome>: count}}`                                                                  |
| `add` / `rm`    | `{added: [string]}` / `{removed: [string]}`                                                                                                           |
| `config`        | `{backend, saved: true, secretsStored: [string]}`; `config --show` → `{defaultBackend, profiles: {name: {backend, settings, secrets: [fieldNames]}}}` |
| `update`        | `{current, latest, updated}`                                                                                                                          |

Secret values never appear in any JSON output — `config --show` lists
secret field _names_ only, `status`/`diff` carry paths and statuses only,
and `diff --show-values --json` embeds content diffs only when explicitly
requested (same opt-in as the prose mode).

### Example

```console
$ vsync status --json
{
  "projectId": "my-project",
  "backend": "s3",
  "files": [
    { "path": ".env", "status": "differs" },
    { "path": ".env.production", "status": "unchanged" }
  ]
}
```
