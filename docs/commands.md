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

Contents: [config](#vsync-config) · [init](#vsync-init) · [add](#vsync-add) ·
[rm](#vsync-rm) · [status](#vsync-status) · [diff](#vsync-diff) ·
[push](#vsync-push) · [pull](#vsync-pull) · [list](#vsync-list) ·
[global flags](#global-flags)

---

## `vsync config`

One-time-per-machine setup: pick a storage backend, enter its settings and
credentials, test the connection, save. Interactive.

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

| Flag                      | Effect                                       |
| ------------------------- | -------------------------------------------- |
| (none)                    | Interactive setup, as above                  |
| `--show`                  | Print the saved config with secrets redacted |
| `--set-default <backend>` | Change the default backend without prompts   |

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
4. **File selection** — a checklist of everything git ignores, minus
   suppressed entries (`node_modules/`, `dist/`, other build/cache dirs,
   files > 10 MB). Files matching `.env*`, `*secret*`, `*credential*`,
   `*.pem`, `*.key`, `id_rsa*`, `config.local.*` (each ≤ 50 KB) are
   sorted to the top and **pre-checked**. Toggle anything, then confirm.

On confirm: writes `.vsync/manifest.json` (backend name + tracked-file
ledger) and registers the project in `~/.vsync/config.json` (what
`vsync list` shows). No per-project config file is written — backend
settings/credentials resolve from the global profile at runtime.

Re-running `init` on an initialized project warns first (re-initializing
replaces the tracked-file list; deselected files are untracked, never
deleted) and asks for confirmation.

### Examples

```console
$ vsync init
? Project ID my-project
? Which storage backend for this project? s3 (saved profile)
Connection OK (s3).
? Files to track (suggested files are pre-checked) .env, .env.local, local-notes.txt
Initialized 'my-project' (backend: s3).
Tracking 2 file(s): .env, .env.local. Nothing has been uploaded yet — run `vsync push`.
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
the backend: every file under the project's `<projectId>/` prefix becomes
a tracked entry, the project joins `~/.vsync/config.json`, and vsync offers
to pull immediately.

The project ID is whatever `vsync list` shows on the machine that pushed
(it defaults to the project folder name at `init` time). Backend profiles
are scanned in config order — the first profile with files under the ID's
prefix wins.

### Example (fresh clone)

```console
$ vsync link my-project
Linked 'my-project' (backend: s3) — 2 tracked file(s): .env, local-notes.txt.
? Pull the files now? Yes
  .env — pulled
  local-notes.txt — pulled
Summary: 2 pulled
```

Declining the pull leaves placeholder hashes in the manifest; if local
copies of the files already exist, `vsync status` reports them as
conflicts until a pull (or `--force`) resolves them — vsync never
silently overwrites either side.

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

Cheap, read-only report. Re-hashes every tracked file locally, makes one
backend listing scoped to `<projectId>/`, and groups files most-urgent
first. Prints **paths and statuses only** — never contents or values.

### Sections (skipped when empty)

| Section header                                                                         | Meaning                                                         |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `Conflicts (changed locally AND remotely since last sync — resolve before push/pull):` | both sides changed; `push`/`pull` will refuse without `--force` |
| `Changed locally (not yet pushed):`                                                    | run `vsync push`                                                |
| `Changed remotely (not yet pulled):`                                                   | run `vsync pull`                                                |
| `Missing locally (tracked, but no local file):`                                        | `vsync pull` restores it                                        |
| `Missing remotely (not on the backend — never pushed, or deleted there):`              | `vsync push` uploads it (never-pushed entries are noted)        |
| `In sync:`                                                                             | nothing to do                                                   |

### Example

```console
$ vsync status
Project 'my-project' (backend: s3) — 3 tracked file(s)

Changed locally (not yet pushed):
  .env

Missing remotely (not on the backend — never pushed, or deleted there):
  config.local.json (not pushed yet)

In sync:
  .env.production
```

---

## `vsync diff`

Like `status`, but limited to files that **differ** (no "In sync"
section), plus an **untracked candidates** section reusing the same scan
`init` uses — handy for noticing a newly created `.env` you haven't
tracked yet. Paths only by default.

### Flags

| Flag            | Effect                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| (none)          | Differing paths + untracked candidates                                                                           |
| `--show-values` | Additionally print real line-by-line content diffs. **This prints secret values to your terminal** — opt-in only |

### Example (default)

```console
$ vsync diff
Changed locally (not yet pushed):
  .env
2 tracked file(s), 1 differ

Untracked candidates (same scan as `vsync init`):
  .env.staging (210 bytes) — suggested (pattern:.env*)
  local-notes.txt (16 bytes)
```

### Example (`--show-values`)

Git-style diffs under a per-file header. `-` lines are the last-synced
base version; `+` lines are the side that changed since.

```console
$ vsync diff --show-values

── .env (local-modified) ──
--- a/.env remote
+++ b/.env local
@@ -1,2 +1,3 @@
 A=1
-B=2
+B=2
+C=3
```

Files missing one side get a note instead of a diff — e.g.
`(no remote copy — never pushed, or deleted on the backend)`.

---

## `vsync push`

Upload tracked files that changed since the last sync. Per-file outcomes
(never all-or-nothing — one failing file doesn't block or roll back the
others):

| Per-file line                                               | When                                                                                   |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `pushed`                                                    | uploaded; manifest stamped only after confirmed success                                |
| `skipped (unchanged)`                                       | local hash matches last sync                                                           |
| `REFUSED (conflict: …)`                                     | changed locally **and** remotely since last sync — needs `--force`                     |
| `REFUSED (changed remotely only — run`vsync pull`first, …)` | only the backend changed; pushing would destroy the other machine's work for zero gain |
| `skipped (no local file)`                                   | tracked but deleted locally — push never deletes remote copies                         |
| `FAILED (…)`                                                | backend error; the manifest stays accurate for everything that did upload              |

If anything was refused or failed, the command exits `1` with a summary
(`[vsync] Push incomplete — …`) even though the successful uploads stand.

### Flags

| Flag          | Effect                                                                                                                                                                                 |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-f, --force` | Overwrite the remote copy with your local version for refused files. Prints a loud `WARNING: --force …` naming every file whose remote-only changes will be lost **before** uploading. |

### Example

```console
$ vsync push
Project 'my-project' (backend: s3) — 3 tracked file(s)
  .env — pushed
  .env.production — skipped (unchanged)
  config.local.json — REFUSED (changed remotely only — run `vsync pull` first, or --force to overwrite)
Summary: 1 pushed, 1 skipped (unchanged), 1 refused (remote changed)
[vsync] Push incomplete — 1 changed remotely (pull first, or --force). The manifest records only successful uploads.
```

---

## `vsync pull`

Download tracked files that changed on the backend since the last sync.
Mirror of `push`, opposite direction. Per-file outcomes:

| Per-file line                                              | When                                                                                                                                                                          |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pulled`                                                   | downloaded; a missing local file is noted `(restored)`                                                                                                                        |
| `skipped (unchanged)`                                      | local hash matches last sync                                                                                                                                                  |
| `REFUSED (conflict: …)`                                    | both sides changed — needs `--force`                                                                                                                                          |
| `REFUSED (changed locally only — run`vsync push`first, …)` | only your copy changed; pulling would overwrite local work with a remote copy identical to the last sync                                                                      |
| `skipped (no remote copy)`                                 | never pushed (`never pushed`), deleted on the backend (`deleted on the backend — push to restore, or`vsync rm`to untrack`), or missing on both sides (`no local copy either`) |

A fresh `git clone` (which carries `.vsync/` but none of the secret
files) shows every tracked file as _missing locally_ — one `vsync pull`
restores them all.

Same exit-code behavior as `push`: refused/failed files → exit `1`, with
successful downloads still applied and recorded.

### Flags

| Flag          | Effect                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-f, --force` | Overwrite your **local** files with the remote version for refused files, with a loud pre-download warning naming what local-only changes will be lost. |

### Example

```console
$ vsync pull
Project 'my-project' (backend: s3) — 3 tracked file(s)
  .env — pulled
  .env.production — pulled (restored)
  config.local.json — skipped (unchanged)
Summary: 2 pulled, 1 skipped (unchanged)
```

---

## `vsync list`

Show every project registered on this machine (from `~/.vsync/config.json`):
project ID, backend, last sync time, and local path. A project whose path
no longer exists (moved or deleted) is marked `(missing on disk)` — never
an error. Projects with no successful sync yet show `never synced`.

One registry entry exists per project ID: pulling the same project from a
second checkout re-points the entry to that checkout's path.

### Example

```console
$ vsync list
Known projects (2):
  my-project  s3   2026-08-15 10:22  D:\code\my-project
  old-thing   sftp never synced      /home/me/old-thing  (missing on disk)
```

---

## Global flags

| Flag        | Effect                                                              |
| ----------- | ------------------------------------------------------------------- |
| `--version` | Print the installed `vsync` version                                 |
| `--help`    | Command list; `vsync <command> --help` for a single command's flags |
