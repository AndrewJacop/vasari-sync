# vasari-sync (`vsync`)

A cross-platform CLI for syncing the project files that must **never** touch
version control — `.env` files, secrets, internal docs, per-machine config —
to storage **you already own**: your own S3 bucket, your own SFTP server,
your own WebDAV share, or a private GitHub repo.

## Why this exists

Every project has a handful of files that are too sensitive for a shared
git repo but still need to follow you between machines: your laptop and
your desktop, or you and a teammate. The usual answers are bad ones:

- **Commit them** — leaks secrets into history forever.
- **Recreate by hand** on every machine — drifts, gets forgotten, breaks
  at the worst moment.
- **A shared cloud drive** — works until you want S3, or SFTP, or a repo
  you already run.

`vsync` closes that gap. `git clone` carries your committed files; one
`vsync pull` carries the rest.

## ⚠️ Security model — read this first

**`vsync` does not encrypt anything.** Files are uploaded to your backend
exactly as they are on disk. The security model is simple:

> Trust the backend, not the tool.

- Use a **private** backend (a private bucket, your own server, a private
  repo). `vsync` is _not_ a "safe to push to a public repo" tool.
- Credentials (S3 keys, SFTP passwords, GitHub tokens) are stored locally
  in `~/.vsync/config.json` with `0600` permissions (owner-only) — readable
  by your user account and anything running as it. There is no OS-keychain
  integration in v1; the file permission is the boundary.
- `vsync status` and `vsync diff` print **paths only** by default. Content
  diffs are opt-in (`vsync diff --show-values`) and print actual values to
  your terminal.

## Requirements

- Node.js ≥ 22.13
- `git` on your PATH (file discovery uses real `.gitignore` semantics)

## Install

```sh
npm install -g vasari-sync
```

Or run it without installing:

```sh
npx vasari-sync --help
```

## Quickstart

**Machine A (first time):**

```sh
# 1. Point vsync at storage you own (interactive; tests the connection
#    before saving). Secrets go to ~/.vsync/config.json, never the project.
vsync config

# 2. Inside your project (a git repo): pick a project ID and which
#    git-ignored files to track — a folder tree; suggested files (.env*,
#    *.pem, id_rsa*, *secret*, ...) are pre-checked, folders select whole
#    subtrees. Nested git repos ignored by the parent are scanned too.
vsync init

# 3. Upload the tracked files.
vsync push

# Later — see what changed and sync it:
vsync status        # paths only, cheap (one backend listing)
vsync diff          # differing paths + untracked candidates
vsync push
```

`init` writes `.vsync/manifest.json` (backend name, tracked paths +
hashes) and keeps `.vsync/` out of git — the manifest lists your secret
_paths_, so it must never reach the repo. Nothing machine-specific
enters the project: each machine resolves settings and credentials from
its own `~/.vsync/config.json` profile.

**Machine B (or a fresh clone):**

```sh
git clone <your-repo> my-project && cd my-project

vsync config        # once per machine: save backend settings + credentials
vsync link my-project   # rebuild the manifest from the backend, then pull
                        # (project ID = what `vsync list` shows on machine A)
```

From then on, the loop on any machine is: work → `vsync push`; sit down
elsewhere → `vsync pull`. If both sides changed the same file,
`vsync status` flags a **conflict** and `push`/`pull` refuse that file
until you resolve it or explicitly pass `--force`.

Full command reference: [docs/commands.md](docs/commands.md).

## Supported backends

| Backend       | For                                                                                                                                | Fields prompted by `vsync config`                                                                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `s3`          | AWS S3, MinIO, Cloudflare R2, Backblaze B2, DigitalOcean Spaces, any S3-compatible store                                           | `region`, `bucket`, `endpoint` (blank = AWS), `accessKeyId` \*, `secretAccessKey` \*, `forcePathStyle`                                                                     |
| `sftp`        | Your own SSH/SFTP server                                                                                                           | `host`, `port` (default 22), `username`, `password` \*, `privateKeyPath` (instead of password), `remoteBasePath`                                                           |
| `webdav`      | Nextcloud, Apache/nginx DAV, any WebDAV share                                                                                      | `url`, `username`, `password` \*, `remoteBasePath`                                                                                                                         |
| `github-repo` | A private GitHub repo — the only backend with **native versioning** (git history)                                                  | `owner` (defaults to `gh` login), `repo` (name or URL), `branch` (blank = repo default), `token` \* (reused from the `gh` CLI when signed in), `remoteBasePath` (optional) |
| `local-fs`    | A plain directory — test/eval backend; also handy for sync via a mounted/synced folder (Dropbox-style folders, mounted NAS shares) | `basePath`                                                                                                                                                                 |

\* = secret; stored only in `~/.vsync/config.json` (0600), never in the
project config that gets committed.

Remote layout: every project's files live under a `<projectId>/` prefix at
the backend (`<remoteBasePath>/<projectId>/<project-relative-path>`), so
several projects can share one bucket/server without colliding.

## What lives where

| Path                             | Contents                                                                                       | Committed to git?                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `.vsync/manifest.json` (project) | backend name, tracked paths, content hashes, last-synced times                                 | **no** — git-ignored, rebuilt via `vsync link` |
| `~/.vsync/config.json` (machine) | backend profiles, credentials (0600), local project registry (checkout paths for `vsync list`) | no                                             |

## Which files does `init` suggest?

`vsync init` scans what git ignores (project, nested, and global
excludesfile semantics — via `git status --ignored`) and classifies:

- **Suggested (pre-checked):** `.env*`, `*secret*`, `*credential*`,
  `*.pem`, `*.key`, `id_rsa*`, `config.local.*` — under 50 KB.
- **Shown (unchecked):** every other ignored file under 10 MB.
- **Never shown:** anything inside `node_modules/`, `dist/`, `build/`,
  `.next/`, `target/`, `vendor/`, `__pycache__/`, cache/log dirs, or over
  10 MB.

Selection happens in a **folder-tree checklist**: folders show
`[ ]`/`[~]`/`[x]` (none/some/all selected) and toggling one selects or
clears its whole subtree; `→`/`←` expand/collapse, `a`/`n` select
all/none.

### Nested git repos

Projects sometimes contain **other git repos** ignored by the parent
(the umbrella-repo pattern: parent `.gitignore` has `/some-subrepo/`).
`init` scans those too — the sub-repo's own `.gitignore` decides what
counts as a candidate, so a `.env` ignored inside it is offered under its
project-relative path (`some-subrepo/.env`) while the sub-repo's tracked
files never are. In the tree picker those folders are tagged
`nested repo`. This is exactly how you sync `.env`/`CLAUDE.md` files from
checked-out sub-repos under one umbrella project.

## Scripting & agents

Every command runs without a TTY. Each interactive prompt has a flag
twin: a flag wins, a TTY prompts as before, and with no TTY the missing
flag either takes a safe default or fails fast naming the flag — nothing
hangs. Every command also takes `--json` for machine-readable output
(exactly one object on stdout; warnings, progress, and errors go to
stderr; exit codes: 0 success, 1 failure). On a partial push/pull the
result object is still printed _before_ the error, so agents get per-file
detail plus exit 1.

### Flag matrix

| Command                                       | Non-interactive flags                                                                                                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `config`                                      | `--backend <name>`, `--set key=value` (repeatable), `--secret key=value` (repeatable) — or the `VSYNC_SECRET_*` env vars; a failed connection test aborts (nothing saved)                              |
| `init`                                        | `--project-id <id>` (default: folder name), `--backend <name>` (default: global default), `--files a,b` (repeatable; omitted = track nothing), `--yes` (re-init), `--list` (print candidates and exit) |
| `link`                                        | `--pull` (pull right after linking; without a TTY the pull is simply skipped — exit 0)                                                                                                                 |
| `update`                                      | `-y/--yes` (without it and no TTY: error)                                                                                                                                                              |
| `add`, `rm`, `status`, `diff`, `push`, `pull` | already non-interactive (`--force` on push/pull, `--show-values` on diff)                                                                                                                              |

### Secrets for `config`

Each backend's secret fields can arrive via flag or env var (constant-case
field name, `VSYNC_SECRET_` prefix). `--secret` beats the env var; both
beat a previously saved secret. A secret supplied through `--set` is
auto-routed to secret storage, never the plaintext profile. A `gh` CLI
token is reused automatically for `github-repo` when no other token is
supplied.

```sh
VSYNC_SECRET_ACCESS_KEY_ID=AKIA... \
VSYNC_SECRET_SECRET_ACCESS_KEY=... \
  vsync config --backend s3 --set region=us-east-1 --set bucket=my-bucket --json
```

| Backend       | Secret fields                                                  |
| ------------- | -------------------------------------------------------------- |
| `s3`          | `VSYNC_SECRET_ACCESS_KEY_ID`, `VSYNC_SECRET_SECRET_ACCESS_KEY` |
| `sftp`        | `VSYNC_SECRET_PASSWORD`                                        |
| `webdav`      | `VSYNC_SECRET_PASSWORD`                                        |
| `github-repo` | `VSYNC_SECRET_TOKEN`                                           |

(`--secret` argv values are visible in process listings — prefer env vars.)

### JSON shapes (stable; additive changes only)

- `status` → `{projectId, backend, files: [{path, status, note?}]}`
  — `status` ∈ `conflict | local-modified | remote-modified | missing-locally | remote-missing | unchanged`
- `diff` → `{projectId, backend, files: [{path, status}], candidates: [{path, size, classification, rule?}], patches?: [{path, patch}]}` (`patches` only with `--show-values`)
- `list` → `{projects: [{projectId, backend, fileCount|null, linked, path?, lastSyncedAt?, missingOnDisk?}], unreachable: [string]}`
- `init` → `{projectId, backend, files: [string]}`; `init --list` → `{candidates: [...]}`
- `link` → `{projectId, backend, files: [string], pull?: <pull result>}` (`pull` present only with `--pull`)
- `push`/`pull` → `{projectId, backend, files: [{path, outcome, note?}], summary: {<outcome>: count}}`
- `add` → `{added: [string]}`; `rm` → `{removed: [string]}`
- `config` → `{backend, saved: true, secretsStored: [string]}`; `config --show` → `{defaultBackend, profiles: {name: {backend, settings, secrets: [fieldNames]}}}`
- `update` → `{current, latest, updated}`

### Typical agent session

```sh
vsync config --backend local-fs --set basePath=/srv/vsync --json </dev/null
cd myproject
vsync init --list --json </dev/null            # discovery: what's trackable
vsync init --project-id myproject --files .env --json </dev/null
vsync status --json                            # paths + statuses only
vsync push --json
vsync pull --json                              # on the next machine after `link`
```

## Updating

```sh
vsync update   # checks npm, confirms, installs — or: npm install -g vasari-sync@latest
```

## Development

```sh
npm install
npm run build      # tsc → dist/
npm test           # vitest (unit + integration, all against fakes/local-fs)
npm run lint
npm run typecheck
```

See [local-docs/PLAN.md](local-docs/PLAN.md) for the task breakdown and
[docs/commands.md](docs/commands.md) for the full command reference.

## License

MIT
