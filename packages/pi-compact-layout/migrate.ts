import { existsSync, readFileSync, unlinkSync } from "node:fs";
import writeFileAtomic from "write-file-atomic";
import * as z from "zod";
import { getGlobalConfigPath } from "../pi-common";
import { layoutConfigSchema } from "./config";

const legacyConfigSchema = z.object({
  separator: z.string(),
  lines: layoutConfigSchema.shape.footer.unwrap(),
});

/** Migrate footer.json, replacing the layout config before removing the legacy file. */
export function migrateConfig(): void {
  const legacyPath = getGlobalConfigPath("footer.json");
  if (!existsSync(legacyPath)) return;

  const legacy = legacyConfigSchema.parse(JSON.parse(readFileSync(legacyPath, "utf8")));
  const config = layoutConfigSchema.parse({ separator: legacy.separator, footer: legacy.lines });
  const configPath = getGlobalConfigPath("compact-layout.json");
  writeFileAtomic.sync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  unlinkSync(legacyPath);
}
