import { describe, expect, it } from "vitest";

import { validateGit } from "./git";

describe("validateGit", () => {
  describe("status", () => {
    it.each([
      ["status"],
      ["status", "-s"],
      ["status", "-sb"],
      ["status", "--short", "--branch"],
      ["status", "--porcelain"],
      ["status", "--ignore-submodules", "all"],
      ["status", "--ignore-submodules=all"],
      ["status", "--", "path"],
    ])("allows %j", (...args) => {
      expect(validateGit(args)).toBe(true);
    });

    it.each([
      ["status", "--unknown"],
      ["status", "--ignore-submodules"], // 缺失取值
    ])("rejects %j", (...args) => {
      expect(validateGit(args)).toBe(false);
    });
  });

  describe("diff/log/show", () => {
    it.each([
      ["diff"],
      ["diff", "--stat"],
      ["diff", "--cached"],
      ["diff", "-p"],
      ["log", "-10"], // -N 数字快捷
      ["log", "--oneline", "--graph"],
      ["log", "-n", "20"],
      ["log", "--since=yesterday"],
      ["log", "--author", "alice"],
      ["show", "HEAD"],
      ["show", "--stat", "HEAD"],
    ])("allows %j", (...args) => {
      expect(validateGit(args)).toBe(true);
    });

    it.each([
      ["diff", "--unknown"],
      ["log", "--author"], // 缺失取值
    ])("rejects %j", (...args) => {
      expect(validateGit(args)).toBe(false);
    });
  });

  describe("branch", () => {
    it.each([
      ["branch"],
      ["branch", "-v"],
      ["branch", "-vv"],
      ["branch", "--verbose"],
      ["branch", "-a"],
      ["branch", "-r"],
      ["branch", "--list"],
      ["branch", "--all", "--sort", "-committerdate"],
      ["branch", "--show-current"],
      ["branch", "-av"], // 合并含查询模式
      ["branch", "--merged", "main"],
    ])("allows %j", (...args) => {
      expect(validateGit(args)).toBe(true);
    });

    it.each([
      ["branch", "new-branch"], // 没有查询模式，形同创建
      ["branch", "-d", "old"],
      ["branch", "--delete", "old"],
      ["branch", "-D", "old"],
    ])("rejects %j", (...args) => {
      expect(validateGit(args)).toBe(false);
    });
  });

  describe("remote", () => {
    it.each([
      ["remote"],
      ["remote", "-v"],
      ["remote", "--verbose"],
      ["remote", "get-url", "origin"],
      ["remote", "get-url", "--push", "origin"],
      ["remote", "show", "origin"],
      ["remote", "show", "-n", "origin"],
    ])("allows %j", (...args) => {
      expect(validateGit(args)).toBe(true);
    });

    it.each([
      ["remote", "add", "origin", "url"],
      ["remote", "rm", "origin"],
      ["remote", "get-url", "--unknown", "origin"],
    ])("rejects %j", (...args) => {
      expect(validateGit(args)).toBe(false);
    });
  });

  describe("config", () => {
    it.each([
      ["config", "--get", "user.email"],
      ["config", "--get", "user.email", "default"],
      ["config", "--get-all", "remote.origin.url"],
      ["config", "--get-regexp", "^remote"],
      ["config", "--get-urlmatch", "credential", "https://example.com"],
      ["config", "--list"],
      ["config", "-l"],
    ])("allows %j", (...args) => {
      expect(validateGit(args)).toBe(true);
    });

    it.each([
      ["config"], // 没有 action
      ["config", "user.email", "me@x.com"], // 未指定读取模式
      ["config", "--get"], // 缺参数
      ["config", "--list", "extra"],
      ["config", "--unset", "user.email"],
    ])("rejects %j", (...args) => {
      expect(validateGit(args)).toBe(false);
    });
  });

  describe("unsupported subcommand", () => {
    it.each([[], ["commit"], ["push"], ["pull"], ["fetch"], ["checkout", "main"]])("rejects %j", (...args) => {
      expect(validateGit(args)).toBe(false);
    });
  });
});
