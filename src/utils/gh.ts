import { execFile } from "node:child_process";
import type { ExecFileException } from "node:child_process";

export interface GhAuth {
  /** Stored API token of the active gh login. */
  token?: string;
  /** Login of the authenticated user. */
  login?: string;
  /** owner/repo of the git repo in cwd, when gh can see one. */
  repo?: string;
}

/**
 * execFile with a promise wrapper (not util.promisify — execFile's custom
 * promisify symbol doesn't survive module mocks, default promisify would
 * resolve an array instead of {stdout}).
 */
function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: 5000 },
      (err: ExecFileException | null, stdout: string | Buffer) => {
        if (err) reject(err);
        else resolve((stdout ?? "").toString());
      },
    );
  });
}

/**
 * Best-effort GitHub CLI probe. Returns the signed-in token/login (and the
 * cwd repo) when `gh` is installed and authenticated; an empty object
 * otherwise. Never throws — no gh is a normal path, not an error.
 */
export async function ghAuth(): Promise<GhAuth> {
  let token: string;
  try {
    token = (await run("gh", ["auth", "token"])).trim();
  } catch {
    return {};
  }
  if (!token) return {};

  const out = async (...args: string[]): Promise<string | undefined> => {
    try {
      const stdout = (await run("gh", args)).trim();
      return stdout || undefined;
    } catch {
      return undefined;
    }
  };

  const [login, repo] = await Promise.all([
    out("api", "user", "--jq", ".login"),
    out("repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"),
  ]);
  return { token, login, repo };
}
