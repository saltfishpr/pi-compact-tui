import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as z from "zod";

const CONFIG_PATH = join(getAgentDir(), "extensions", "trust.json");

const trustConfigSchema = z.object({
  domains: z
    .array(z.string())
    .default([])
    .transform((list) => list.map((item) => item.trim().toLowerCase()).filter(Boolean)),
  usernames: z
    .array(z.string())
    .default([])
    .transform((list) => list.map((item) => item.trim().toLowerCase()).filter(Boolean)),
});

type TrustConfig = z.infer<typeof trustConfigSchema>;

export interface GitRemoteInfo {
  domain: string;
  username: string;
  repo: string;
}

function decodePathSegment(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function remotePathParts(pathname: string): string[] | undefined {
  const rawParts = pathname.split("/").filter(Boolean);
  if (rawParts.length < 2) return undefined;

  const parts = rawParts.map(decodePathSegment);
  if (parts.some((part) => part === undefined)) return undefined;
  return parts as string[];
}

/** Parses HTTPS, SSH URL, and SCP-like Git remote forms. */
export function parseGitRemoteUrl(remoteUrl: string): GitRemoteInfo | undefined {
  const value = remoteUrl.trim();
  if (!value) return undefined;

  let domain: string;
  let parts: string[] | undefined;

  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (!url.hostname || url.protocol === "file:") return undefined;
      domain = url.hostname.toLowerCase();
      parts = remotePathParts(url.pathname);
    } catch {
      return undefined;
    }
  } else {
    // Examples: git@github.com:owner/repo.git, github.com:owner/repo.git
    const match = /^(?:[^@\s/:]+@)?(\[[^\]]+\]|[^:\s/]+):(.+)$/.exec(value);
    if (!match) return undefined;

    domain = match[1].replace(/^\[|\]$/g, "").toLowerCase();
    parts = remotePathParts(match[2].split(/[?#]/, 1)[0]);
  }

  if (!parts) return undefined;

  const username = parts[0];
  const repoName = parts.at(-1)?.replace(/\.git$/i, "");
  if (!username || !repoName) return undefined;

  return { domain, username, repo: repoName };
}

function loadTrustConfig(): TrustConfig {
  if (!existsSync(CONFIG_PATH)) return trustConfigSchema.parse({});
  try {
    const value = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return trustConfigSchema.parse(value);
  } catch {
    return trustConfigSchema.parse({});
  }
}

function getOriginRemote(cwd: string): string | undefined {
  const result = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd,
    encoding: "utf8",
    timeout: 2_000,
  });

  if (result.status !== 0 || result.error) return undefined;
  return result.stdout.trim() || undefined;
}

export default function (pi: ExtensionAPI) {
  pi.on("project_trust", async (event, ctx) => {
    const config = loadTrustConfig();

    const remoteUrl = getOriginRemote(event.cwd);
    const remote = remoteUrl ? parseGitRemoteUrl(remoteUrl) : undefined;
    if (!remote) return { trusted: "undecided" };

    const domainTrusted = config.domains.includes(remote.domain.toLowerCase());
    const usernameTrusted = config.usernames.includes(remote.username.toLowerCase());

    // Either allowlist may grant trust. Otherwise Pi continues its normal trust flow.
    return domainTrusted || usernameTrusted ? { trusted: "yes" } : { trusted: "undecided" };
  });
}
