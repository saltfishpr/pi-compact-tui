import { describe, expect, it, vi } from "vitest";

vi.mock("./logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { inChildSessionContext, runInChildSessionContext } from "./child-context";
import {
  isSelfSubagentExtension,
  resolveSessionTools,
  resolveWhitelistExtensions,
} from "./child-session";

describe("extensions whitelist filtering", () => {
  const selfDir = "/repo/packages/pi-subagent";
  const candidates = [
    "/repo/packages/pi-web-search/index.ts",
    "/repo/packages/pi-subagent/index.ts",
    "/home/tester/.pi/agent/extensions/custom-tool.ts",
    "builtin:mcp",
  ];

  it("matches builtin names, directory names, file basenames, and enabled entry paths", () => {
    const result = resolveWhitelistExtensions(
      ["mcp", "builtin:codemode", "pi-web-search", "custom-tool", "~/.pi/agent/extensions/custom-tool.ts", "./packages/pi-web-search"],
      candidates,
      {
        cwd: "/repo",
        homeDir: "/home/tester",
        selfDir,
      },
    );

    expect(result.builtinNames).toEqual(["mcp", "codemode"]);
    expect(result.extensionPaths).toEqual([
      "/repo/packages/pi-web-search/index.ts",
      "/home/tester/.pi/agent/extensions/custom-tool.ts",
    ]);
    expect(result.unmatched).toEqual([]);
    expect(result.excludedSelf).toEqual([]);
  });

  it("rejects arbitrary filesystem directories and non-enabled paths", () => {
    const result = resolveWhitelistExtensions(
      ["/repo/packages", "~/.pi/agent/extensions", "~/.pi/agent/extensions/unenabled.ts"],
      candidates,
      {
        cwd: "/repo",
        homeDir: "/home/tester",
        selfDir,
      },
    );

    expect(result.extensionPaths).toEqual([]);
    expect(result.unmatched).toEqual([
      "/repo/packages",
      "~/.pi/agent/extensions",
      "~/.pi/agent/extensions/unenabled.ts",
    ]);
  });

  it("always excludes pi-subagent itself by name or path", () => {
    expect(isSelfSubagentExtension("/repo/packages/pi-subagent/index.ts", selfDir)).toBe(true);
    expect(isSelfSubagentExtension("/other/pi-subagent/index.ts", selfDir)).toBe(true);
    expect(isSelfSubagentExtension("/repo/packages/pi-web-search/index.ts", selfDir)).toBe(false);

    const result = resolveWhitelistExtensions(
      ["pi-subagent", "./packages/pi-subagent/index.ts", "pi-web-search"],
      candidates,
      {
        cwd: "/repo",
        homeDir: "/home/tester",
        selfDir,
      },
    );

    expect(result.extensionPaths).toEqual(["/repo/packages/pi-web-search/index.ts"]);
    expect(result.excludedSelf).toEqual(["pi-subagent", "./packages/pi-subagent/index.ts"]);
    expect(result.unmatched).toEqual([]);
  });

  it("reports unmatched whitelist specs without throwing", () => {
    const result = resolveWhitelistExtensions(["non-existent-ext", "pi-web-search"], candidates, {
      cwd: "/repo",
      homeDir: "/home/tester",
      selfDir,
    });

    expect(result.extensionPaths).toEqual(["/repo/packages/pi-web-search/index.ts"]);
    expect(result.unmatched).toEqual(["non-existent-ext"]);
  });
});

describe("resolveSessionTools", () => {
  it("enables all platform built-ins when profile.tools is omitted", () => {
    expect(resolveSessionTools(undefined, [])).toEqual([
      "read", "bash", "edit", "write", "grep", "find", "ls",
      ...(process.platform === "win32" ? ["powershell"] : []),
    ]);
    expect(resolveSessionTools(["read", "grep"], [])).toEqual(["read", "grep"]);
  });

  it("adds enabled extension tools without dropping built-ins when profile.tools is omitted", () => {
    expect(resolveSessionTools(undefined, ["web_search"])).toEqual([
      ...resolveSessionTools(undefined, []),
      "web_search",
    ]);
  });

  it("merges extension tools with explicit allowlist tools", () => {
    expect(resolveSessionTools(["read", "grep"], ["web_search", "read"])).toEqual([
      "read",
      "grep",
      "web_search",
    ]);
  });

  it("preserves SDK +name/-name modifier lists without mixing plain tool names", () => {
    expect(resolveSessionTools(["+grep", "-bash"], ["web_search"])).toEqual(["+grep", "-bash"]);
  });

  it("respects explicit empty tool list", () => {
    expect(resolveSessionTools([], ["web_search"])).toEqual([]);
  });
});

describe("childSessionContext recursion guard", () => {
  it("isolates inChildSessionContext() inside runInChildSessionContext()", async () => {
    expect(inChildSessionContext()).toBe(false);
    const inside = await runInChildSessionContext(async () => {
      await Promise.resolve();
      return inChildSessionContext();
    });
    expect(inside).toBe(true);
    expect(inChildSessionContext()).toBe(false);
  });
});
