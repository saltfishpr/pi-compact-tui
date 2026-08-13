/**
 * Vendored from https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/coding-agent/src/modes/interactive/interactive-mode.ts
 *
 * - `InteractiveMode.formatDisplayPath`
 * - `InteractiveMode.getShortPath`
 * - `InteractiveMode.getCompactPathLabel`
 * - `InteractiveMode.getCompactPackageSourceLabel`
 * - `InteractiveMode.getCompactExtensionLabel`
 * - `InteractiveMode.isPackageSource`
 *
 * 唯一改动：把类方法改写成模块级函数（去掉 ``），并去除与 UI 无关的
 * 字段访问；核心分支、正则、字符串处理与官方保持一致。升级 pi-coding-agent
 * 时请对照上述文件 diff 校准。
 */
import * as os from "node:os";
import * as path from "node:path";

import { parseGitUrl } from "./git";
import { SourceInfo } from "@earendil-works/pi-coding-agent";

function formatDisplayPath(p: string): string {
  const home = os.homedir();
  let result = p;
  // Replace home directory with ~
  if (result.startsWith(home)) {
    result = `~${result.slice(home.length)}`;
  }
  return result;
}

/**
 * Get a short path relative to the package root for display.
 */
function getShortPath(fullPath: string, sourceInfo?: SourceInfo): string {
  const normalizedFullPath = fullPath.replace(/\\/g, "/");
  const baseDir = sourceInfo?.baseDir;
  if (baseDir && isPackageSource(sourceInfo)) {
    const normalizedBaseDir = baseDir.replace(/\\/g, "/");
    const npmRootMatch = normalizedBaseDir.match(/^(.*\/node_modules)\/(@?[^/]+(?:\/[^/]+)?)$/);
    // If fullPath is under the same node_modules root as baseDir, preserve that relative topology.
    if (npmRootMatch?.[1] && normalizedFullPath.startsWith(`${npmRootMatch[1]}/`)) {
      return path.posix.relative(normalizedBaseDir, normalizedFullPath);
    }

    const relativePath = path.relative(path.resolve(baseDir), path.resolve(fullPath));
    if (
      relativePath &&
      relativePath !== "." &&
      !relativePath.startsWith("..") &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath)
    ) {
      return relativePath.replace(/\\/g, "/");
    }
  }

  const source = sourceInfo?.source ?? "";
  const npmMatch = normalizedFullPath.match(/node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/);
  if (npmMatch && source.startsWith("npm:")) {
    return npmMatch[2];
  }

  const gitMatch = normalizedFullPath.match(/git\/[^/]+\/[^/]+\/(.*)/);
  if (gitMatch && source.startsWith("git:")) {
    return gitMatch[1];
  }

  return formatDisplayPath(fullPath);
}

function getCompactPathLabel(resourcePath: string, sourceInfo?: SourceInfo): string {
  const shortPath = getShortPath(resourcePath, sourceInfo);
  const normalizedPath = shortPath.replace(/\\/g, "/");
  const segments = normalizedPath.split("/").filter((segment) => segment.length > 0 && segment !== "~");
  if (segments.length > 0) {
    return segments[segments.length - 1]!;
  }
  return shortPath;
}

function getCompactPackageSourceLabel(sourceInfo?: SourceInfo): string {
  const source = sourceInfo?.source ?? "";
  if (source.startsWith("npm:")) {
    return source.slice("npm:".length) || source;
  }

  const gitSource = parseGitUrl(source);
  if (gitSource) {
    return gitSource.path || source;
  }

  return source;
}

export function getCompactExtensionLabel(resourcePath: string, sourceInfo?: SourceInfo): string {
  if (!isPackageSource(sourceInfo)) {
    return getCompactPathLabel(resourcePath, sourceInfo);
  }

  const sourceLabel = getCompactPackageSourceLabel(sourceInfo);
  if (!sourceLabel) {
    return getCompactPathLabel(resourcePath, sourceInfo);
  }

  const shortPath = getShortPath(resourcePath, sourceInfo).replace(/\\/g, "/");
  const packagePath = shortPath.startsWith("extensions/") ? shortPath.slice("extensions/".length) : shortPath;
  const parsedPath = path.posix.parse(packagePath);

  if (parsedPath.name === "index") {
    return !parsedPath.dir || parsedPath.dir === "." ? sourceLabel : `${sourceLabel}:${parsedPath.dir}`;
  }

  return `${sourceLabel}:${packagePath}`;
}

function isPackageSource(sourceInfo?: SourceInfo): boolean {
  const source = sourceInfo?.source ?? "";
  return source.startsWith("npm:") || source.startsWith("git:");
}
