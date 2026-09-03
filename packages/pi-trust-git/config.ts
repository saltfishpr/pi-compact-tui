import { getGlobalConfigPath, loadJSONConfig } from "../pi-common";
import * as z from "zod";

const CONFIG_FILE_NAME = "trust.json";

export const trustConfigSchema = z.object({
  domains: z
    .array(z.string())
    .default([])
    .transform((list) => list.map((item) => item.trim().toLowerCase()).filter(Boolean)),
  usernames: z
    .array(z.string())
    .default([])
    .transform((list) => list.map((item) => item.trim().toLowerCase()).filter(Boolean)),
});

export type TrustConfig = z.infer<typeof trustConfigSchema>;

export function loadConfig(): TrustConfig {
  const globalPath = getGlobalConfigPath(CONFIG_FILE_NAME);
  return loadJSONConfig(globalPath, trustConfigSchema);
}
