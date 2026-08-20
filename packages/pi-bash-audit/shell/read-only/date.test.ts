import { describe, expect, it } from "vitest";

import { validateDate } from "./date";

describe("validateDate", () => {
  it.each([[], ["-u"], ["+%Y-%m-%d"], ["-u", "+%Y-%m-%dT%H:%M:%SZ"]])("allows %j", (...args) => {
    expect(validateDate(args)).toBe(true);
  });

  it.each([
    ["-R"],
    ["now"],
    ["+%Y", "extra"],
    ["-u", "-R"],
    ["-u", "%Y"], // 缺少 `+` 前缀
    ["+%Y", "-u"], // 顺序错误
  ])("rejects %j", (...args) => {
    expect(validateDate(args)).toBe(false);
  });
});
