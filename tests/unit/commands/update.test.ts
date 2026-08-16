import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execCalls, state, confirmMock } = vi.hoisted(() => ({
  execCalls: [] as { args: string[] }[],
  state: { viewVersion: "9.9.9\n", failView: false },
  confirmMock: vi.fn<() => Promise<boolean>>(),
}));

vi.mock("node:child_process", () => ({
  execFile: (
    _cmd: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string) => void,
  ) => {
    execCalls.push({ args });
    if (args.includes("view") && state.failView) {
      setImmediate(() => cb(new Error("ETIMEDOUT"), ""));
    } else {
      setImmediate(() => cb(null, args.includes("view") ? state.viewVersion : ""));
    }
  },
}));

vi.mock("@inquirer/prompts", () => ({ confirm: confirmMock }));

import { runUpdateCommand, runningVersion } from "../../../src/commands/update.js";

let logs: string[] = [];

describe("vsync update", () => {
  beforeEach(() => {
    execCalls.length = 0;
    state.viewVersion = "9.9.9\n";
    state.failView = false;
    confirmMock.mockReset();
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("views, confirms, installs, and reports the upgrade", async () => {
    confirmMock.mockResolvedValue(true);

    await runUpdateCommand();

    expect(execCalls.map((c) => c.args)).toEqual([
      ["view", "vasari-sync", "version"],
      ["install", "-g", "vasari-sync@latest"],
    ]);
    expect(logs.join("\n")).toContain("Updated vasari-sync");
  });

  it("installs nothing when the user declines", async () => {
    confirmMock.mockResolvedValue(false);

    await runUpdateCommand();

    expect(execCalls).toHaveLength(1); // view only
    expect(logs.join("\n")).toContain("Skipped");
  });

  it("--yes skips the confirm", async () => {
    await runUpdateCommand(true);

    expect(confirmMock).not.toHaveBeenCalled();
    expect(execCalls.map((c) => c.args)).toContainEqual(["install", "-g", "vasari-sync@latest"]);
  });

  it("reports 'already up to date' when npm view returns the running version", async () => {
    state.viewVersion = `${runningVersion()}\n`;

    await runUpdateCommand();

    expect(logs.join("\n")).toContain("already up to date");
    expect(execCalls).toHaveLength(1);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("surfaces a registry outage as an actionable error", async () => {
    state.failView = true;

    await expect(runUpdateCommand()).rejects.toThrow("could not reach the npm registry");
  });

  it("--json emits {current, latest, updated:false} when already current", async () => {
    state.viewVersion = `${runningVersion()}\n`;

    await runUpdateCommand(false, true);

    const raw = logs.find((l) => l.trim().startsWith("{"));
    expect(raw).toBeDefined();
    expect(JSON.parse(raw as string)).toEqual({
      current: runningVersion(),
      latest: runningVersion(),
      updated: false,
    });
  });

  it("--json -y emits {current, latest, updated:true} after installing", async () => {
    await runUpdateCommand(true, true);

    const raw = logs.find((l) => l.trim().startsWith("{"));
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw as string) as {
      current: string;
      latest: string;
      updated: boolean;
    };
    expect(parsed.latest).toBe("9.9.9");
    expect(parsed.updated).toBe(true);
    expect(parsed.current).not.toBe(parsed.latest);
  });
});
