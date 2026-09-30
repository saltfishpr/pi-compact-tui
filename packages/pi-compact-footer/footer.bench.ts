import {
  type AgentSession,
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  parseSessionEntries,
  type ReadonlyFooterDataProvider,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, bench, describe } from "vitest";
import { FooterComponent } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/footer.js";
import { initTheme, theme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { loadConfig } from "./config";
import { ConfigurableFooter } from "./index";

// PI_SESSION_FILE=/path/to/session.jsonl pnpm bench:footer
const sessionFile = process.env.PI_SESSION_FILE;
if (!sessionFile) throw new Error("Set PI_SESSION_FILE to the session JSONL file to benchmark.");

const options = { time: 500, iterations: 100, warmupTime: 100, warmupIterations: 20 };
const widths = [80, 120, 200];
let agentDir: string;
let session: AgentSession;
let manager: SessionManager;
let settings: SettingsManager;
let createCompactFooter: () => ConfigurableFooter;
const compactFooters = new Map<number, ConfigurableFooter>();
const officialFooters = new Map<number, FooterComponent>();
let invalidatedCompact: ConfigurableFooter;
let invalidatedOfficial: FooterComponent;
let leaves: [string, string];
let nextLeaf = 0;

beforeAll(async () => {
  // Read once: an active session can grow while the benchmark is running.
  const snapshot = readFileSync(sessionFile, "utf8");
  const entries = parseSessionEntries(snapshot);
  const header = entries.find((entry) => entry.type === "session");
  assert.ok(header, "Session snapshot must have a valid header");
  manager = SessionManager.inMemory(header.cwd, undefined, entries);
  assert.ok(manager.getLeafId(), "Session snapshot must contain entries");
  const originalEntryCount = manager.getEntryCount();
  const originalBranchCount = manager.getBranch().length;
  const originalLeaf = manager.getLeafId();

  // Empty, temporary auth/model storage keeps user credentials and discovery out of this replay.
  agentDir = mkdtempSync(join(tmpdir(), "pi-footer-bench-"));
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(agentDir, "models-cache.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const selection = manager.buildSessionContext().model;
  const provider = process.env.PI_PROVIDER ?? selection?.provider;
  const modelId = process.env.PI_MODEL ?? selection?.modelId;
  assert.ok(provider && modelId, "Session or PI_PROVIDER/PI_MODEL must identify the selected model");
  const model = modelRuntime.getModel(provider, modelId);
  assert.ok(model, `Selected model ${provider}/${modelId} is not in the installed catalog`);
  settings = SettingsManager.inMemory({ compaction: { enabled: true }, cacheWarming: "off" });
  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "",
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
  ({ session } = await createAgentSession({
    cwd: header.cwd,
    agentDir,
    sessionManager: manager,
    settingsManager: settings,
    modelRuntime,
    model,
    resourceLoader,
    tools: [],
  }));
  await session.bindExtensions({});
  const ctx = session.extensionRunner.createContext();
  const config = loadConfig();
  const statuses = new Map<string, string>();
  const footerData: ReadonlyFooterDataProvider = {
    getGitBranch: () => "benchmark",
    getExtensionStatuses: () => statuses,
    getAvailableProviderCount: () => 2,
    onBranchChange: () => () => {},
  };
  initTheme("dark", false);
  createCompactFooter = () => new ConfigurableFooter({
    ctx,
    theme,
    footerData,
    config,
    getAutoCompactEnabled: () => settings.getSettings().compaction?.enabled ?? true,
    getThinkingLevel: () => session.thinkingLevel,
  });

  // Two non-context entries let us invalidate by leaf without growing history on every iteration.
  leaves = [
    manager.appendCustomEntry("footer-benchmark", null),
    manager.appendCustomEntry("footer-benchmark", null),
  ];
  for (const width of widths) {
    const compact = createCompactFooter();
    const official = new FooterComponent(session, footerData);
    official.setAutoCompactEnabled(session.autoCompactionEnabled);
    for (const footer of [compact, official]) {
      const rendered = footer.render(width);
      assert.ok(rendered.length > 0, "Footer must produce output");
      assert.ok(rendered.every((line) => visibleWidth(line) <= width), "Footer output must fit terminal width");
      assert.deepEqual(footer.render(width), rendered, "Warm render must preserve output");
    }
    compactFooters.set(width, compact);
    officialFooters.set(width, official);
  }
  invalidatedCompact = createCompactFooter();
  invalidatedOfficial = new FooterComponent(session, footerData);
  invalidatedOfficial.setAutoCompactEnabled(session.autoCompactionEnabled);
  invalidatedCompact.render(120);
  invalidatedOfficial.render(120);

  console.log(JSON.stringify({
    snapshot: {
      sha256: createHash("sha256").update(snapshot).digest("hex"),
      bytes: Buffer.byteLength(snapshot),
      entries: originalEntryCount,
      branchEntries: originalBranchCount,
      leafId: originalLeaf,
      benchmarkOnlyEntries: 2,
    },
    environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model },
    model: `${model.provider}/${model.id}`,
    layout: { lines: config.lines.length, theme: "dark", statuses: statuses.size, widths },
  }, null, 2));
});

afterAll(() => {
  session?.dispose();
  if (agentDir) rmSync(agentDir, { recursive: true, force: true });
});

describe("footer / unchanged session", () => {
  for (const width of widths) {
    bench(`compact render / ${width} columns / warm cache`, () => {
      compactFooters.get(width)!.render(width);
    }, options);
    bench(`official render / ${width} columns / warm cache`, () => {
      officialFooters.get(width)!.render(width);
    }, options);
  }
});

describe("footer / cache misses", () => {
  bench("compact / new instance + first render / 120 columns", () => {
    createCompactFooter().render(120);
  }, options);
  bench("compact / change leaf + render / 120 columns", () => {
    manager.branch(leaves[nextLeaf++ % 2]);
    invalidatedCompact.render(120);
  }, options);
  bench("official / change leaf + render / 120 columns", () => {
    manager.branch(leaves[nextLeaf++ % 2]);
    invalidatedOfficial.render(120);
  }, options);
});

describe("footer / supporting operations", () => {
  bench("SessionManager.getEntries / shallow snapshot", () => {
    manager.getEntries();
  }, options);
  bench("AgentSession.getContextUsage / real context projection", () => {
    session.getContextUsage();
  }, options);
  bench("SettingsManager.getSettings / settings snapshot", () => {
    settings.getSettings();
  }, options);
});
