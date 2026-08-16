import { stderr } from "node:process";
import { describe, expect, it, vi } from "vitest";
import { Spinner, withSpinner } from "../../../src/utils/progress.js";

describe("Spinner (non-TTY fallback)", () => {
  it("prints one plain line per new message, keeps frames off stdout", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const write = vi.spyOn(stderr, "write").mockImplementation(() => true);

    const sp = new Spinner(false);
    sp.start("Uploading .env");
    sp.update("Uploading .env"); // same message → no extra line
    sp.update("Uploading dump.sql");
    sp.stop();

    const lines = log.mock.calls.map((c) => c.join(" "));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Uploading .env");
    expect(lines[1]).toContain("Uploading dump.sql");
    expect(write).not.toHaveBeenCalled(); // no control chars anywhere

    vi.restoreAllMocks();
  });
});

describe("Spinner (TTY animation)", () => {
  it("animates frames on stderr and clears the line on stop", async () => {
    vi.useFakeTimers();
    const chunks: string[] = [];
    const write = vi.spyOn(stderr, "write").mockImplementation((c) => {
      chunks.push(String(c));
      return true;
    });

    const sp = new Spinner(true);
    sp.start("Uploading dump.sql");
    await vi.advanceTimersByTimeAsync(80); // one tick → next frame
    sp.stop();

    const rendered = chunks.join("");
    expect(rendered).toContain("Uploading dump.sql");
    expect(rendered).toMatch(/⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/); // braille frame visible
    expect(chunks.at(-1)).toBe("\r\u001b[K"); // stop clears the line
    expect(write).not.toHaveBeenCalledWith(expect.stringContaining("…"), expect.anything());

    vi.restoreAllMocks();
    vi.useRealTimers();
  });
});

describe("withSpinner", () => {
  it("prints the progress line and rethrows when fn fails", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m) => lines.push(String(m)));

    await expect(withSpinner("Working", () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );

    expect(lines.join("\n")).toContain("Working"); // progress line still printed
    vi.restoreAllMocks();
  });
});
