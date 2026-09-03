import {
  formatSize,
  truncateHead as piTruncateHead,
  type TruncationOptions,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export function truncateHead(content: string, options?: TruncationOptions): TruncationResult {
  const result = piTruncateHead(content, options);
  if (!result.truncated) return result;

  const path = writeFullOutput(content);
  const notice = [
    `[Output truncated: ${result.outputLines} of ${result.totalLines} lines`,
    `(${formatSize(result.outputBytes)} of ${formatSize(result.totalBytes)}).`,
    `Full output saved to: ${path}]`,
  ].join(" ");
  const output = `${result.content}\n\n${notice}`;

  return {
    ...result,
    content: output,
    outputLines: output.split("\n").length,
    outputBytes: Buffer.byteLength(output),
  };
}

function writeFullOutput(content: string): string {
  const directory = "/tmp/pi-tool-output";
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  const path = join(directory, `web_search-${randomUUID()}.txt`);
  writeFileSync(path, content, { mode: 0o600 });
  return path;
}
