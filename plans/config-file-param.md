# Plan: `--config <file>` — multi-profile usage on a shared device

## Context

The global config (`~/.vsync/config.json`) holds **one profile per backend type**
(profiles are keyed by backend name: `s3`, `github-repo`, …). Two users sharing
a device/OS account collide on that single file — whoever runs `vsync config`
last wins, and the other's credentials and project registry are clobbered.

Goal: every command accepts a **config file path parameter**, so each user
passes their own profile file and the two never touch `~/.vsync/config.json`.

## Approach

A global `--config <path>` option plus a `VSYNC_CONFIG` env var. Both resolve to
a **full config-file path** that overrides the default `~/.vsync/config.json`.
Everything else in the codebase already routes through one choke point —
`globalConfigPath()` in `src/core/globalConfig.ts` — so a single precedence rule
makes every command (config, init, push, pull, status, diff, link, list)
profile-aware with no signature changes:

````text
globalConfigPath():
  explicit homeDir param (test isolation)
  > VSYNC_CONFIG env (full file path — set by --config)
  > VSYNC_HOME env (home redirect, existing)
  > ~/.vsync/config.json
```text

Verified with the installed commander v15: `.option(..., { global: true })` is
accepted **both before and after the subcommand**:

```text
vsync --config ~/.vsync/alice.json push
vsync push --config ~/.vsync/alice.json
```text

Per-user setup flow (one-time, reuses the existing non-interactive setup):

```text
vsync config --config ~/.vsync/alice.json --backend s3 \
  --set region=eu-west-1 --set bucket=... \
  --secret accessKeyId=... --secret secretAccessKey=...
alias vsync="vsync --config ~/.vsync/alice.json"   # per shell/user
```text

Each user's file is a complete standalone config: profiles + secrets + project
registry (`vsync list --config alice.json` shows only alice's projects), with
0600 permissions (writeGlobalConfig already mkdirs + chmods).

### Known limitation (out of scope)

`.vsync/manifest.json` is per-checkout. Two users working in the **same working
directory** interleave `lastSyncedHash` (false conflicts). The supported shape
is separate checkouts, each with its own manifest — the `--config` flag isolates
everything that lives machine-side.

### Skipped

- **Named profiles inside one file** (`profiles: {"alice-s3": …}`) — would
  break the manifest-names-backend/profile-key-is-backend-name contract and
  touch the schema. Two files is simpler and fully isolates registries too.
- **Ephemeral per-command params** (`vsync push --backend s3 --set bucket=…`)
  — repeats credentials in argv on every command (the codebase itself warns
  against argv-visible secrets); `vsync config --set/--secret` into a
  `--config` file already covers "pass backend data as params", once.

## Files to modify

1. **`src/core/globalConfig.ts`** — `globalConfigPath()`: insert
   `VSYNC_CONFIG` (as a resolved full file path) between the explicit
   `homeDir` param and `VSYNC_HOME`. Update the doc comment.
2. **`src/cli.ts`** — ~8 lines:
   - `program.option("--config <path>", "use this config file instead of ~/.vsync/config.json (multi-profile: one file per user)", undefined, { global: true })`
   - `program.hook("preAction", …)`: if set, validate non-empty and
     `process.env.VSYNC_CONFIG = resolve(path)`.
3. **`src/core/backendResolver.ts`** — the "No saved profile for 's3' — run
   `vsync config`" error gains the active config path + the `--config` hint
   when overridden, so a multi-profile failure points at the right file.

## Reuse (nothing new needed)

- `readGlobalConfig` / `writeGlobalConfig` / `setSecret` /
  `upsertProjectEntry` — all call `globalConfigPath()` internally; they
  inherit the override untouched.
- `nonInteractiveSetup` (`src/commands/config.ts`) — reused verbatim to seed
  per-user files; keeps connection-test-on-save and secret routing.
- The one-time secrets-fallback warning already prints the real path via
  `globalConfigPath()` → correct file named per profile.

## Steps

- [ ] 1. `globalConfigPath()`: honor `VSYNC_CONFIG` (resolve()d full path);
      precedence homeDir > VSYNC_CONFIG > VSYNC_HOME > home. Update comment.
- [ ] 2. `cli.ts`: global `--config <path>` option + `preAction` hook setting
      `VSYNC_CONFIG` (reject empty value with a clear error).
- [ ] 3. `backendResolver.ts`: include the active config file in the
      no-profile error when an override is in effect.
- [ ] 4. Unit tests (`tests/unit/core/globalConfig.test.ts`): read/write to a
      VSYNC_CONFIG path, missing file → empty config, corrupt → loud error,
      precedence over VSYNC_HOME, explicit homeDir still wins (test isolation).
- [ ] 5. Integration test — the two-users scenario: alice.json + bob.json
      (local-fs backends, different basePaths, separate clones): config both,
      push as alice, `vsync list` under each file shows separate registries,
      push/pull as bob unaffected by alice's state.
- [ ] 6. One spawned-CLI test (`tsx src/cli.ts … --config x.json`) proving the
      flag → env → override wiring end-to-end.
- [ ] 7. README: `--config` + `VSYNC_CONFIG` docs and the per-user alias
      recipe.

## Verification

- `npm run typecheck && npm run lint && npm test`
- Manual (local-fs): create alice.json + bob.json via
  `vsync config --config … --backend local-fs --set basePath=<dir>`; init +
  push with each; confirm `--show`, `list`, and push/pull use each file's own
  profile and never fall through to `~/.vsync/config.json`.
````
