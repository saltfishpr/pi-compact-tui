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

import { Extension, SourceInfo } from "@earendil-works/pi-coding-agent";
import { parseGitUrl } from "./git";

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

function getCompactDisplayPathSegments(resourcePath: string): string[] {
  return formatDisplayPath(resourcePath)
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== "~");
}

function getCompactNonPackageExtensionLabel(
  resourcePath: string,
  index: number,
  allPaths: Array<{ path: string; segments: string[] }>,
): string {
  const segments = allPaths[index]?.segments;
  if (!segments || segments.length === 0) {
    return getCompactPathLabel(resourcePath);
  }

  for (let segmentCount = 1; segmentCount <= segments.length; segmentCount += 1) {
    const candidate = segments.slice(-segmentCount).join("/");
    const isUnique = allPaths.every((item, itemIndex) => {
      if (itemIndex === index) {
        return true;
      }
      return item.segments.slice(-segmentCount).join("/") !== candidate;
    });
    if (isUnique) {
      return candidate;
    }
  }

  return segments.join("/");
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

function getCompactExtensionLabel(resourcePath: string, sourceInfo?: SourceInfo): string {
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

export function getCompactExtensionLabelAdapter(extensions: readonly Extension[], extension: Extension): string {
  const nonPackageExtensions = extensions
    .map((extension) => {
      const segments = getCompactDisplayPathSegments(extension.path);
      const lastSegment = segments[segments.length - 1];
      if (segments.length > 1 && (lastSegment === "index.ts" || lastSegment === "index.js")) {
        segments.pop();
      }
      return {
        path: extension.path,
        sourceInfo: extension.sourceInfo,
        segments,
      };
    })
    .filter((extension) => !isPackageSource(extension.sourceInfo));

  if (isPackageSource(extension.sourceInfo)) {
    return getCompactExtensionLabel(extension.path, extension.sourceInfo);
  }

  const nonPackageIndex = nonPackageExtensions.findIndex((item) => item.path === extension.path);
  if (nonPackageIndex === -1) {
    return getCompactPathLabel(extension.path, extension.sourceInfo);
  }

  return getCompactNonPackageExtensionLabel(extension.path, nonPackageIndex, nonPackageExtensions);
}
