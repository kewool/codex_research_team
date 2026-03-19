// @ts-nocheck
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

function readJsonFile(path: string): any {
  const raw = readFileSync(path, "utf8").replace(/^\ufeff/, "");
  return JSON.parse(raw);
}

function readModelsCache(): { models: string[]; fetchedAt: string | null } {
  const cachePath = join(codexHome(), "models_cache.json");
  if (!existsSync(cachePath)) {
    return { models: [], fetchedAt: null };
  }
  try {
    const payload = readJsonFile(cachePath);
    const models = Array.isArray(payload?.models)
      ? payload.models
          .map((model: any) => String(model?.slug ?? "").trim())
          .filter(Boolean)
      : [];
    return { models, fetchedAt: String(payload?.fetched_at ?? "").trim() || null };
  } catch {
    return { models: [], fetchedAt: null };
  }
}

function readConfigModels(): string[] {
  const configPath = join(codexHome(), "config.toml");
  if (!existsSync(configPath)) {
    return [];
  }
  try {
    const raw = readFileSync(configPath, "utf8").replace(/^\ufeff/, "");
    const matches = [...raw.matchAll(/^\s*model\s*=\s*["']([^"']+)["']\s*$/gm)];
    return matches.map((match) => String(match[1] ?? "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export function loadCodexModelCatalog(): { models: string[]; source: string; fetchedAt: string | null } {
  const cache = readModelsCache();
  const configModels = readConfigModels();
  const models = [...new Set([...cache.models, ...configModels])];
  const source = cache.models.length > 0 && configModels.length > 0
    ? "models_cache+config"
    : cache.models.length > 0
      ? "models_cache"
      : configModels.length > 0
        ? "config"
        : "none";
  return {
    models,
    source,
    fetchedAt: cache.fetchedAt,
  };
}
