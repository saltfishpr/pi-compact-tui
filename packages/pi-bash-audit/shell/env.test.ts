import { describe, expect, it } from "vitest";

import { validateEnv } from "./env";

describe("validateEnv", () => {
  it("allows no args", () => {
    expect(validateEnv([])).toBe(true);
  });

  it.each([["FOO=bar"], ["-i"], ["--"], ["PATH"]])("rejects %j", (...args) => {
    expect(validateEnv(args)).toBe(false);
  });
});
