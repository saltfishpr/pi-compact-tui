import { describe, expect, it } from "vitest";

import { validateGo } from "./go";

describe("validateGo", () => {
  describe("version", () => {
    it.each([
      ["version"],
      ["version", "-m", "./bin/foo"], // 显示模块版本
      ["version", "-json", "./bin/foo"],
    ])("allows %j", (...args) => {
      expect(validateGo(args)).toBe(true);
    });

    it.each([
      ["version", "-x"],
      ["version", "-w"],
    ])("rejects %j", (...args) => {
      expect(validateGo(args)).toBe(false);
    });
  });

  describe("doc", () => {
    it.each([
      ["doc"],
      ["doc", "fmt"],
      ["doc", "-all", "fmt"],
      ["doc", "-src", "fmt.Println"],
      ["doc", "-u", "-cmd", "pkg"],
      ["doc", "--all", "fmt"],
    ])("allows %j", (...args) => {
      expect(validateGo(args)).toBe(true);
    });

    it.each([
      ["doc", "-http"],
      ["doc", "-unknown"],
      ["doc", "-all=true"],
    ])("rejects %j", (...args) => {
      expect(validateGo(args)).toBe(false);
    });
  });

  describe("env", () => {
    it.each([
      ["env"],
      ["env", "-json"], // 显示环境变量 JSON 格式
      ["env", "-changed"],
      ["env", "GOPATH"],
      ["env", "-json", "GOROOT", "GOPATH"],
    ])("allows %j", (...args) => {
      expect(validateGo(args)).toBe(true);
    });

    it.each([
      ["env", "-w", "GOPATH=/tmp"],
      ["env", "-u", "GOPATH"],
    ])("rejects %j", (...args) => {
      expect(validateGo(args)).toBe(false);
    });
  });

  describe("list", () => {
    it.each([
      ["list"],
      ["list", "./..."],
      ["list", "-m", "all"],
      ["list", "-json", "-deps", "./..."],
      ["list", "-f", "{{.ImportPath}}", "./..."],
      ["list", "-f={{.ImportPath}}", "./..."],
      ["list", "-m", "-u", "-versions", "all"],
    ])("allows %j", (...args) => {
      expect(validateGo(args)).toBe(true);
    });

    it.each([
      ["list", "-f"], // 缺失取值
      ["list", "-x"],
      ["list", "-json=true"], // 无值标志不能带 `=`
    ])("rejects %j", (...args) => {
      expect(validateGo(args)).toBe(false);
    });
  });

  describe("mod", () => {
    it.each([
      ["mod", "graph"],
      ["mod", "graph", "-x"],
      ["mod", "graph", "-go=1.21"],
      ["mod", "graph", "-go", "1.21"],
      ["mod", "why", "golang.org/x/text"],
      ["mod", "why", "-m", "-vendor", "golang.org/x/text"],
      ["mod", "verify"],
    ])("allows %j", (...args) => {
      expect(validateGo(args)).toBe(true);
    });

    it.each([
      ["mod"], // 缺少子命令
      ["mod", "tidy"],
      ["mod", "download"],
      ["mod", "edit"],
      ["mod", "vendor"],
      ["mod", "init", "example.com/x"],
      ["mod", "verify", "extra"],
      ["mod", "graph", "-unknown"],
      ["mod", "graph", "-go"], // -go 需要取值
    ])("rejects %j", (...args) => {
      expect(validateGo(args)).toBe(false);
    });
  });

  describe("unknown subcommand", () => {
    it.each([
      [], // go
      ["build"],
      ["run", "."],
      ["test", "./..."],
      ["get", "pkg"],
      ["install", "pkg"],
    ])("rejects %j", (...args) => {
      expect(validateGo(args)).toBe(false);
    });
  });

  describe("positional dash handling", () => {
    it("allows `-` as positional in list", () => {
      expect(validateGo(["list", "-"])).toBe(true);
    });

    it("treats `--` as end-of-options", () => {
      expect(validateGo(["list", "--", "./..."])).toBe(true);
    });
  });
});
