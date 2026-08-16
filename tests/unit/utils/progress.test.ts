import { stderr } from "node:process";
import { describe, expect, it, vi } from "vitest";
import { Spinner, withSpinner } from "../../../src/utils/progress.js";

describe("Spinner (non-TTY fallback)", () => {
  it("prints one plain stderr line per new message, keeps stdout clean", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const chunks: string[] = [];
    vi.spyOn(stderr, "write").mockImplementation((c) => {
      chunks.push(String(c));
      return true;
    });

    const sp = new Spinner(false);
    sp.start("Uploading .env");
    sp.update("Uploading .env"); // same message → no extra line
    sp.update("Uploading dump.sql");
    sp.stop();

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain("Uploading .env");
    expect(chunks[1]).toContain("Uploading dump.sql");
    expect(log).not.toHaveBeenCalled(); // stdout stays pure (JSON-friendly)

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
  it("prints the progress line to stderr and rethrows when fn fails", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const chunks: string[] = [];
    vi.spyOn(stderr, "write").mockImplementation((c) => {
      chunks.push(String(c));
      return true;
    });

    await expect(withSpinner("Working", () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );

    expect(chunks.join("\n")).toContain("Working"); // progress line still printed
    expect(log).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
