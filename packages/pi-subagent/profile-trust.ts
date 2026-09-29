import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { selectScrollable } from "../pi-common";
import { profileHash, type AgentProfile } from "./agents";
import { getSubagentConfigPath, loadConfig, subagentConfigSchema, type SubagentConfig } from "./config";

type TrustedProfile = SubagentConfig["trustedProfiles"][number];

const DENY = "Deny";
const ALLOW_ONCE = "Allow once";
const TRUST_VERSION = "Trust this version";

function display(text: string): string {
  return text.replace(
    /[\x00-\x1f\x7f-\x9f]/g,
    (character) => `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
}

function verifyProfile(profile: AgentProfile): void {
  if (
    realpathSync(profile.path) !== profile.path ||
    profileHash(readFileSync(profile.path, "utf8")) !== profile.sha256
  ) {
    throw new Error(`Agent profile changed; run /reload before delegating: ${profile.path}`);
  }
}

/** Manages approval and persistent trust for a profile's pre-run shell commands. */
export class ProfileTrust {
  private tail: Promise<void> = Promise.resolve();

  /** Require approval before running the commands in this exact profile version. */
  async authorize(profile: AgentProfile, ctx: ExtensionContext, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    verifyProfile(profile);
    if (profile.commands.length === 0) return;

    await this.serialized(async () => {
      signal.throwIfAborted();
      verifyProfile(profile);
      const trusted = loadConfig().trustedProfiles.some(
        (entry) => entry.path === profile.path && entry.sha256 === profile.sha256,
      );
      if (!trusted) {
        const message = [
          `Agent: ${display(profile.name)} (${profile.source})`,
          `Profile: ${display(profile.path)}`,
          `Working directory: ${display(ctx.cwd)}`,
          `SHA-256: ${profile.sha256}`,
          "",
          "Commands (in execution order):",
          ...profile.commands.map((command, index) => `  ${index + 1}. ${display(command)}`),
          "",
          "Trust this version applies to this profile in all working directories.",
          "This approval covers only these pre-run commands, not the subagent's tools.",
        ].join("\n");
        const choice = await selectScrollable(
          ctx,
          "Allow subagent profile commands?",
          message,
          [DENY, ALLOW_ONCE, TRUST_VERSION],
          { signal },
        );
        signal.throwIfAborted();
        verifyProfile(profile);

        if (choice !== ALLOW_ONCE && choice !== TRUST_VERSION) {
          throw new Error(
            ctx.hasUI
              ? `Profile commands declined for subagent "${profile.name}"`
              : `Profile commands require interactive approval for subagent "${profile.name}"`,
          );
        }
        if (choice === TRUST_VERSION) {
          const config = loadConfig();
          const entries = config.trustedProfiles.filter((entry) => entry.path !== profile.path);
          entries.push({ path: profile.path, sha256: profile.sha256 });
          this.save({ ...config, trustedProfiles: entries });
        }
      }
      signal.throwIfAborted();
      verifyProfile(profile);
    }, signal);
  }

  /** List saved profile versions, including entries whose files are no longer present. */
  list(): TrustedProfile[] {
    return [...loadConfig().trustedProfiles];
  }

  /** Persist the selected versions of visible profiles, preserving profiles outside this catalog. */
  async saveSelection(profiles: AgentProfile[], selectedPaths: ReadonlySet<string>): Promise<void> {
    await this.serialized(() => {
      for (const profile of profiles) verifyProfile(profile);
      const visiblePaths = new Set(profiles.map((profile) => profile.path));
      const config = loadConfig();
      const entries = config.trustedProfiles.filter((entry) => !visiblePaths.has(entry.path));
      for (const profile of profiles) {
        if (selectedPaths.has(profile.path)) entries.push({ path: profile.path, sha256: profile.sha256 });
      }
      this.save({ ...config, trustedProfiles: entries });
    });
  }

  private save(config: SubagentConfig): void {
    const path = getSubagentConfigPath();
    const validated = subagentConfigSchema.parse(config);
    mkdirSync(dirname(path), { recursive: true });
    writeFileAtomic.sync(path, `${JSON.stringify(validated, null, 2)}\n`);
  }

  private async serialized<T>(operation: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Keep the chain ordered even if a waiter aborts before acquiring the lock.
    this.tail = previous.then(() => gate);

    let removeAbort: (() => void) | undefined;
    try {
      if (signal) {
        await Promise.race([
          previous,
          new Promise<void>((_resolve, reject) => {
            const abort = () => reject(signal.reason ?? new Error("Subagent aborted"));
            signal.addEventListener("abort", abort, { once: true });
            removeAbort = () => signal.removeEventListener("abort", abort);
            if (signal.aborted) abort();
          }),
        ]);
        signal.throwIfAborted();
      } else {
        await previous;
      }
      return await operation();
    } finally {
      removeAbort?.();
      release();
    }
  }
}
