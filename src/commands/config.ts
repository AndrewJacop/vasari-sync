import { confirm, input, password, select } from "@inquirer/prompts";
import { readGlobalConfig, secretKey, setSecret, writeGlobalConfig } from "../core/globalConfig.js";
import { availableBackends, createBackend } from "../storage/registry.js";
import type { BackendConfig } from "../storage/types.js";

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
    { name: "owner", label: "Owner (user or org)", required: true },
    { name: "repo", label: "Repo", required: true },
    { name: "branch", label: "Branch (blank for repo default)" },
    { name: "token", label: "Personal access token", required: true, secret: true },
    { name: "remoteBasePath", label: "Remote base path (optional)" },
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

  const settings: Record<string, unknown> = {};
  const newSecrets: Record<string, string> = {};
  for (const field of BACKEND_FIELDS[backend]) {
    const prior = existingSettings[field.name];
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
        default: typeof prior === "string" ? prior : undefined,
        validate: field.required
          ? (v: string) => (v.trim() ? true : `${field.label} is required`)
          : field.kind === "number"
            ? (v: string) =>
                v.trim() === "" || Number.isFinite(Number(v)) ? true : "Enter a number"
            : undefined,
      });
      if (answer.trim())
        settings[field.name] = field.kind === "number" ? Number(answer) : answer.trim();
    }
  }

  const backendConfig: BackendConfig = { ...settings, ...existingSecrets, ...newSecrets };
  const result = await createBackend(backend, backendConfig).testConnection();
  if (result.ok) {
    console.log(`Connection OK (${result.message ?? backend}).`);
  } else {
    const proceed = await confirm({
      message: `Connection test failed: ${result.message ?? "unknown error"}. Save anyway?`,
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
