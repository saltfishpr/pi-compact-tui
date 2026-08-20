import { describe, expect, it } from "vitest";

import { validateHostname } from "./hostname";

describe("validateHostname", () => {
  it.each([[], ["-f"], ["-s"], ["-f", "-s"], ["-s", "-f"]])("allows %j", (...args) => {
    expect(validateHostname(args)).toBe(true);
  });

  it.each([
    ["-x"],
    ["myhost"], // 不允许设置主机名
    ["-i"],
    ["-f", "extra"],
    ["--help"],
  ])("rejects %j", (...args) => {
    expect(validateHostname(args)).toBe(false);
  });
});
