import { confirm, input, password, select } from "@inquirer/prompts";
import { readGlobalConfig, secretKey, setSecret, writeGlobalConfig } from "../core/globalConfig.js";
import { availableBackends, createBackend } from "../storage/registry.js";
import type { BackendConfig } from "../storage/types.js";
import { ghAuth } from "../utils/gh.js";

export interface ConfigCommandOptions {
  show?: boolean;
  setDefault?: string;
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
  if (options.show) return showConfig(homeDir);
  if (options.setDefault !== undefined) return setDefaultBackend(options.setDefault, homeDir);
  return interactiveSetup(homeDir);
}

async function showConfig(homeDir?: string): Promise<void> {
  const config = await readGlobalConfig(homeDir);
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
  const result = await createBackend(backend, backendConfig).testConnection();
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
