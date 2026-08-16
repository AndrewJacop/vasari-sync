import { confirm, input, password, select } from "@inquirer/prompts";
import { readGlobalConfig, secretKey, setSecret, writeGlobalConfig } from "../core/globalConfig.js";
import { availableBackends, createBackend } from "../storage/registry.js";
import type { BackendConfig } from "../storage/types.js";
import { ghAuth } from "../utils/gh.js";
import { withSpinner } from "../utils/progress.js";

export interface ConfigCommandOptions {
  show?: boolean;
  setDefault?: string;
  /** Non-interactive setup: backend name (falls back to the saved default). */
  backend?: string;
  /** Non-interactive setup: repeatable `key=value` non-secret settings. */
  set?: string[];
  /** Non-interactive setup: repeatable `key=value` secrets (argv-visible). */
  secret?: string[];
  json?: boolean;
}

/** One prompted field per backend. Drives the interactive flow and the
 * secret/non-secret split (secret fields never reach profile settings). */
interface BackendField {
  name: string;
  label: string;
  required?: boolean;
  secret?: boolean;
  kind?: "text" | "boolean" | "number";
}

/** Field specs mirror each handler's Config interface; handlers remain the
 * real trust boundary — this table only shapes the prompts. */
const BACKEND_FIELDS: Record<string, BackendField[]> = {
  "local-fs": [{ name: "basePath", label: "Storage directory path", required: true }],
  s3: [
    { name: "region", label: "Region", required: true },
    { name: "bucket", label: "Bucket", required: true },
    { name: "endpoint", label: "Custom endpoint (blank for AWS)" },
    { name: "accessKeyId", label: "Access key ID", required: true, secret: true },
    { name: "secretAccessKey", label: "Secret access key", required: true, secret: true },
    { name: "forcePathStyle", label: "Use path-style addressing", kind: "boolean" },
  ],
  sftp: [
    { name: "host", label: "Host", required: true },
    { name: "port", label: "Port (blank for 22)", kind: "number" },
    { name: "username", label: "Username", required: true },
    { name: "password", label: "Password", secret: true },
    { name: "privateKeyPath", label: "Private key path (optional, instead of password)" },
    { name: "remoteBasePath", label: "Remote base path", required: true },
  ],
  webdav: [
    { name: "url", label: "WebDAV URL", required: true },
    { name: "username", label: "Username" },
    { name: "password", label: "Password", secret: true },
    { name: "remoteBasePath", label: "Remote base path", required: true },
  ],
  "github-repo": [
    { name: "owner", label: "Storage repo owner (user or org)", required: true },
    {
      name: "repo",
      label:
        "Storage repo (private repo vsync commits your files into — just the name, or paste its URL)",
      required: true,
    },
    { name: "branch", label: "Branch (blank for repo default)" },
    { name: "token", label: "Personal access token", required: true, secret: true },
    { name: "remoteBasePath", label: "Directory inside the storage repo" },
  ],
};

export async function runConfigCommand(
  options: ConfigCommandOptions,
  homeDir?: string,
): Promise<void> {
  if (options.show) return showConfig(homeDir, options.json === true);
  if (options.setDefault !== undefined) return setDefaultBackend(options.setDefault, homeDir);
  if (options.backend || (options.set?.length ?? 0) > 0 || (options.secret?.length ?? 0) > 0)
    return nonInteractiveSetup(options, homeDir);
  return interactiveSetup(homeDir);
}

async function showConfig(homeDir?: string, json = false): Promise<void> {
  const config = await readGlobalConfig(homeDir);
  if (json) {
    const profiles: Record<string, unknown> = {};
    for (const [name, profile] of Object.entries(config.profiles)) {
      const secretFields = Object.keys(config.secrets)
        .filter((k) => k.startsWith(`${name}/`))
        .map((k) => k.slice(name.length + 1))
        .sort();
      profiles[name] = {
        backend: profile.backend,
        settings: profile.settings,
        secrets: secretFields,
      };
    }
    console.log(
      JSON.stringify({ defaultBackend: config.defaultBackend ?? null, profiles }, null, 2),
    );
    return;
  }
  console.log(`Default backend: ${config.defaultBackend ?? "(none)"}`);
  const names = Object.keys(config.profiles);
  if (names.length === 0) {
    console.log("No configured backends — run `vsync config` to set one up.");
    return;
  }
  for (const name of names) {
    const profile = config.profiles[name];
    console.log(`\nProfile '${name}' (backend: ${profile.backend}):`);
    for (const [key, value] of Object.entries(profile.settings)) console.log(`  ${key}: ${value}`);
    for (const key of Object.keys(config.secrets)) {
      if (key.startsWith(`${name}/`)) console.log(`  ${key.slice(name.length + 1)}: [redacted]`);
    }
  }
}

async function setDefaultBackend(name: string, homeDir?: string): Promise<void> {
  const available = availableBackends();
  if (!available.includes(name)) {
    throw new Error(`Unknown backend '${name}', available: ${available.join(", ")}`);
  }
  const config = await readGlobalConfig(homeDir);
  if (!config.profiles[name]) {
    console.warn(
      `[vsync] No saved profile for '${name}' yet — run \`vsync config\` to configure it.`,
    );
  }
  config.defaultBackend = name;
  await writeGlobalConfig(config, homeDir);
  console.log(`Default backend set to '${name}'.`);
}

/** Extract owner/repo from SSH URLs, HTTPS URLs, or `owner/repo`.
 * Returns `{ repo }` (verbatim) when the input is a bare name. */
function parseRepoRef(raw: string): { owner?: string; repo: string } {
  const v = raw.trim();
  const url =
    v.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/) ?? v.match(/^([\w.-]+)\/([\w.-]+)$/);
  return url ? { owner: url[1], repo: url[2] } : { repo: v };
}

/** camelCase field name → CONSTANT_CASE env var suffix
 * (accessKeyId → ACCESS_KEY_ID; token → TOKEN). */
export function toEnvVarName(field: string): string {
  return field.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

/** Parses a `key=value` CLI pair. Throws naming the malformed pair. */
function parseKeyValue(pairs: string[], flag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new Error(`Malformed ${flag} value '${pair}' — expected key=value.`);
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

/** Coerces a raw string to the field's kind (text/boolean/number). */
function coerceValue(field: BackendField | undefined, raw: string): unknown {
  if (field?.kind === "boolean") {
    if (["true", "1", "yes"].includes(raw.toLowerCase())) return true;
    if (["false", "0", "no"].includes(raw.toLowerCase())) return false;
    throw new Error(`Field '${field.name}' expects true/false, got '${raw}'.`);
  }
  if (field?.kind === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n))
      throw new Error(`Field '${field.name}' expects a number, got '${raw}'.`);
    return n;
  }
  return raw.trim();
}

/** Collects secrets from --secret pairs and VSYNC_SECRET_<FIELD> env
 * vars (env looked up per declared field: accessKeyId →
 * VSYNC_SECRET_ACCESS_KEY_ID). --secret beats env (explicit over ambient). */
function collectSecrets(
  backend: string,
  flagPairs: Record<string, string>,
): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const field of BACKEND_FIELDS[backend] ?? []) {
    if (!field.secret) continue;
    const env = process.env[`VSYNC_SECRET_${toEnvVarName(field.name)}`];
    if (env) secrets[field.name] = env;
  }
  return Object.assign(secrets, flagPairs);
}

/**
 * Non-interactive `vsync config`: every input arrives as flags/env. Mirrors
 * interactiveSetup's merge order (--set over saved settings; --secret/env
 * over saved secrets; gh CLI token only when no token was supplied) but
 * resolves every prompt by rule — a failed connection test is fatal (an
 * agent can't answer "save anyway?"; fix credentials and retry).
 */
async function nonInteractiveSetup(options: ConfigCommandOptions, homeDir?: string): Promise<void> {
  const config = await readGlobalConfig(homeDir);
  const backend = options.backend ?? config.defaultBackend ?? undefined;
  if (!backend)
    throw new Error(
      "Non-interactive config: pass --backend <name> " +
        `(available: ${availableBackends().join(", ")}).`,
    );
  if (!availableBackends().includes(backend))
    throw new Error(`Unknown backend '${backend}', available: ${availableBackends().join(", ")}.`);

  const setPairs = parseKeyValue(options.set ?? [], "--set");
  const secretPairs = parseKeyValue(options.secret ?? [], "--secret");

  const existingSettings = config.profiles[backend]?.settings ?? {};
  const existingSecrets: Record<string, string> = {};
  for (const key of Object.keys(config.secrets)) {
    if (key.startsWith(`${backend}/`))
      existingSecrets[key.slice(backend.length + 1)] = config.secrets[key];
  }

  const newSecrets = collectSecrets(backend, secretPairs);
  // gh CLI token: the default the interactive confirm offers — reuse it
  // when nothing else supplies a token (agents get SSO logins for free).
  if (
    backend === "github-repo" &&
    newSecrets.token === undefined &&
    existingSecrets.token === undefined
  ) {
    const gh = await ghAuth();
    if (gh.token) newSecrets.token = gh.token;
  }

  const settings: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(setPairs)) {
    const field = BACKEND_FIELDS[backend].find((f) => f.name === key);
    if (field?.secret) {
      // A secret supplied via --set auto-routes to secret storage —
      // never the plaintext profile (same guarantee the prompt flow has).
      if (raw.trim()) newSecrets[key] = raw.trim();
      continue;
    }
    if (!raw.trim() && !field?.required) continue; // empty optional value = leave unset
    settings[key] = coerceValue(field, raw);
  }
  // A pasted repo URL beats a bare name, same as the interactive flow.
  if (backend === "github-repo" && typeof settings.repo === "string") {
    const parsed = parseRepoRef(settings.repo);
    if (parsed.owner) {
      settings.repo = parsed.repo;
      settings.owner = parsed.owner; // URL owner always wins (deliberate form)
    }
  }

  // Required secrets must exist AFTER all sources (flags, env, gh, saved,
  // --set auto-routing) — checked late so routing is visible to it.
  const missing = (BACKEND_FIELDS[backend] ?? [])
    .filter(
      (f) =>
        f.required &&
        f.secret &&
        newSecrets[f.name] === undefined &&
        existingSecrets[f.name] === undefined,
    )
    .map((f) => `--secret ${f.name}=<…> or VSYNC_SECRET_${toEnvVarName(f.name)}`);
  if (missing.length > 0) {
    throw new Error(
      `Non-interactive config: missing required secret(s) for '${backend}': ${missing.join("; ")}.`,
    );
  }

  const backendConfig: BackendConfig = {
    ...existingSettings,
    ...settings,
    ...existingSecrets,
    ...newSecrets,
  };
  const result = await withSpinner("Testing connection", () =>
    createBackend(backend, backendConfig).testConnection(),
  );
  if (!result.ok)
    throw new Error(
      `Connection test failed: ${result.message ?? "unknown error"} — nothing saved ` +
        `(non-interactive mode never saves an untested profile; fix credentials and retry).`,
    );

  config.defaultBackend = backend;
  config.profiles[backend] = { backend, settings: { ...existingSettings, ...settings } };
  await writeGlobalConfig(config, homeDir);
  for (const [field, value] of Object.entries(newSecrets)) {
    await setSecret(backend, field, value, homeDir);
  }
  const storedFields = Object.keys(newSecrets).sort();
  if (options.secret?.length)
    console.warn(
      "[vsync] Secrets passed via --secret are visible in process listings — prefer VSYNC_SECRET_* env vars.",
    );
  if (options.json) {
    console.log(JSON.stringify({ backend, saved: true, secretsStored: storedFields }, null, 2));
    return;
  }
  console.log(`Connection OK (${result.message ?? backend}).`);
  console.log(
    `Saved '${backend}' profile` +
      (storedFields.length > 0
        ? ` (${storedFields.map((f) => secretKey(backend, f)).join(", ")} stored as secrets)`
        : "") +
      " and set it as your default backend.",
  );
}

async function interactiveSetup(homeDir?: string): Promise<void> {
  const config = await readGlobalConfig(homeDir);
  const backends = availableBackends();
  const backend = await select({
    message: "Which storage backend?",
    choices: backends.map((b) => ({ name: config.profiles[b] ? `${b} (saved)` : b, value: b })),
    default:
      config.defaultBackend && backends.includes(config.defaultBackend)
        ? config.defaultBackend
        : undefined,
  });

  const existingSettings = config.profiles[backend]?.settings ?? {};
  const existingSecrets: Record<string, string> = {};
  for (const key of Object.keys(config.secrets)) {
    if (key.startsWith(`${backend}/`))
      existingSecrets[key.slice(backend.length + 1)] = config.secrets[key];
  }

  // Reuse an existing gh CLI login when one exists — no new PAT to mint.
  // ponytail: stored token is a copy; gh auth refresh can stale it → rerun config.
  const gh = backend === "github-repo" ? await ghAuth() : {};
  let ghToken: string | undefined;
  if (gh.token) {
    ghToken = (await confirm({
      message: `Use the token from your gh CLI login${gh.login ? ` (signed in as ${gh.login})` : ""}?`,
      default: true,
    }))
      ? gh.token
      : undefined;
    if (ghToken) console.log("Using gh CLI token — no personal access token needed.");
  } else if (backend === "github-repo" && !existingSecrets.token) {
    // No gh to lean on and nothing saved yet — say what's needed and how
    // to never need it again.
    console.log(
      "No gh CLI login found — a personal access token (repo scope) is needed. " +
        "Tip: install the GitHub CLI and run `gh auth login`, then rerun `vsync config` to reuse that login.",
    );
  }

  const settings: Record<string, unknown> = {};
  const newSecrets: Record<string, string> = {};
  for (const field of BACKEND_FIELDS[backend]) {
    // gh defaults: owner defaults to the login (it's your vault); the repo
    // is typed deliberately — prefilling the cwd project repo would point the
    // vault at the very repo secrets must never land in.
    const ghDefault = field.name === "owner" ? gh.login : undefined;
    const prior = existingSettings[field.name];
    if (field.secret && field.name === "token" && ghToken) {
      newSecrets.token = ghToken;
      continue;
    }
    if (field.kind === "boolean") {
      settings[field.name] = await confirm({ message: field.label, default: prior === true });
    } else if (field.secret) {
      const keep = existingSecrets[field.name];
      const answer = await password({
        message:
          field.label + (keep ? " (blank keeps existing)" : field.required ? "" : " (optional)"),
      });
      if (answer.trim()) newSecrets[field.name] = answer.trim();
      else if (!keep && field.required) throw new Error(`${field.label} is required.`);
    } else {
      const answer = await input({
        message: field.label + (field.required ? "" : " (optional)"),
        default: typeof prior === "string" ? prior : ghDefault,
        validate: field.required
          ? (v: string) => (v.trim() ? true : `${field.label} is required`)
          : field.kind === "number"
            ? (v: string) =>
                v.trim() === "" || Number.isFinite(Number(v)) ? true : "Enter a number"
            : undefined,
      });
      if (answer.trim())
        settings[field.name] = field.kind === "number" ? Number(answer) : answer.trim();
      // A pasted repo URL into the repo field beats a bare name: extract
      // owner + repo from SSH/HTTPS/owner-repo forms so the API call can't
      // be fed a URL (the 404 users hit before this existed).
      if (backend === "github-repo" && field.name === "repo" && answer.trim()) {
        const parsed = parseRepoRef(answer);
        if (parsed.owner) {
          settings.repo = parsed.repo;
          settings.owner = parsed.owner;
          console.log(`Parsed storage repo: ${parsed.owner}/${parsed.repo}`);
        }
      }
    }
  }

  const backendConfig: BackendConfig = { ...settings, ...existingSecrets, ...newSecrets };
  const result = await withSpinner("Testing connection", () =>
    createBackend(backend, backendConfig).testConnection(),
  );
  if (result.ok) {
    console.log(`Connection OK (${result.message ?? backend}).`);
  } else {
    // When the gh CLI token itself is the suspect (wrong account, missing
    // repo scope), point at the fix instead of a generic failure.
    const scopeHint = ghToken
      ? " — using your gh CLI token: check scopes with `gh auth status`, or rerun `vsync config` and decline the gh token to enter a PAT"
      : "";
    const proceed = await confirm({
      message: `Connection test failed: ${result.message ?? "unknown error"}${scopeHint}. Save anyway?`,
      default: false,
    });
    if (!proceed) {
      console.log("Aborted — nothing saved.");
      return;
    }
  }

  config.defaultBackend = backend;
  config.profiles[backend] = { backend, settings };
  await writeGlobalConfig(config, homeDir);
  for (const [field, value] of Object.entries(newSecrets)) {
    await setSecret(backend, field, value, homeDir);
  }
  console.log(
    `Saved '${backend}' profile${
      Object.keys(newSecrets).length > 0
        ? ` (${Object.keys(newSecrets)
            .map((f) => secretKey(backend, f))
            .join(", ")} stored as secrets)`
        : ""
    } and set it as your default backend.`,
  );
}
