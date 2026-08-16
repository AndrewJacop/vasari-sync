import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * execFile mocked callback-style: promisify appends a callback to every
 * call, so the mock must invoke it (a promise-resolving mock never fires
 * and promisify's promise hangs).
 */
const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ execFile: execFileMock }));

import { ghAuth } from "../../../src/utils/gh.js";

type Cb = (err: Error | null, stdout?: string, stderr?: string) => void;

const reply =
  (stdout = "", err: Error | null = null) =>
  (_cmd: unknown, _args: unknown, _opts: unknown, cb: Cb) =>
    cb(err, stdout, "");

describe("ghAuth", () => {
  beforeEach(() => execFileMock.mockReset());

  it("returns token, login, and cwd repo when gh is authenticated", async () => {
    execFileMock
      .mockImplementationOnce(reply("ghp_testtoken\n")) // auth token
      .mockImplementationOnce(reply("octocat")) // api user
      .mockImplementationOnce(reply("octocat/vasari-sync")); // repo view

    expect(await ghAuth()).toEqual({
      token: "ghp_testtoken",
      login: "octocat",
      repo: "octocat/vasari-sync",
    });
    expect(execFileMock).toHaveBeenLastCalledWith(
      "gh",
      ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
      expect.anything(),
      expect.any(Function),
    );
  });

  it("returns {} when gh is not installed or not signed in", async () => {
    execFileMock.mockImplementationOnce(reply("", new Error("ENOENT")));
    expect(await ghAuth()).toEqual({});
  });

  it("keeps the token even when the api/repo lookups fail", async () => {
    execFileMock
      .mockImplementationOnce(reply("ghp_testtoken"))
      .mockImplementationOnce(reply("", new Error("401")))
      .mockImplementationOnce(reply("", new Error("no git repo")));

    expect(await ghAuth()).toEqual({ token: "ghp_testtoken", login: undefined, repo: undefined });
  });
});
