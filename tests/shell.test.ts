import { describe, expect, test } from "vitest";

import { resolveLoginShell } from "../src/shell.js";

describe("resolveLoginShell", () => {
  test("uses the user's configured shell when present", () => {
    expect(resolveLoginShell({ SHELL: "/bin/zsh" })).toBe("/bin/zsh");
  });

  test("falls back to bash when SHELL is missing", () => {
    expect(resolveLoginShell({})).toBe("bash");
  });
});
