import { describe, expect, it } from "vitest";
import { isNonInteractive, requireTty } from "../../../src/utils/tty.js";

/** Sets process.stdin.isTTY for the duration of fn. */
function withStdin(isTty: boolean | undefined, fn: () => void): void {
  const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: isTty, configurable: true });
  try {
    fn();
  } finally {
    if (original) Object.defineProperty(process.stdin, "isTTY", original);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
  }
}

describe("isNonInteractive", () => {
  it("is true only when stdin is not a TTY", () => {
    withStdin(false, () => expect(isNonInteractive()).toBe(true));
    withStdin(undefined, () => expect(isNonInteractive()).toBe(true));
    withStdin(true, () => expect(isNonInteractive()).toBe(false));
  });
});

describe("requireTty", () => {
  it("throws naming the flag when there is no TTY", () => {
    withStdin(false, () => {
      expect(() => requireTty("--project-id <id>")).toThrow(
        /Non-interactive session: pass --project-id <id>/,
      );
    });
  });

  it("is a no-op on a TTY", () => {
    withStdin(true, () => {
      expect(() => requireTty("--project-id <id>")).not.toThrow();
    });
  });
});
