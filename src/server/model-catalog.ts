// @ts-nocheck
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function globalCodexHome(): string {
  return join(homedir(), ".codex");
}

function codexHome(preferredHome?: string | null): string {
  return preferredHome || process.env.CODEX_HOME || globalCodexHome();
}

function readJsonFile(path: string): any {
  const raw = readFileSync(path, "utf8").replace(/^\ufeff/, "");
  return JSON.parse(raw);
}

function readModelsCache(baseHome: string): { models: string[]; fetchedAt: string | null } {
  const cachePath = join(baseHome, "models_cache.json");
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

function readConfigText(baseHome: string): string {
  const configPath = join(baseHome, "config.toml");
  if (!existsSync(configPath)) {
    return "";
  }
  try {
    return readFileSync(configPath, "utf8").replace(/^\ufeff/, "");
  } catch {
    return "";
  }
}

function readConfigModels(baseHome: string): string[] {
  const raw = readConfigText(baseHome);
  if (!raw) {
    return [];
  }
  const matches = [...raw.matchAll(/^\s*model\s*=\s*["']([^"']+)["']\s*$/gm)];
  return matches.map((match) => String(match[1] ?? "").trim()).filter(Boolean);
}

function readMcpServers(baseHome: string): string[] {
  const raw = readConfigText(baseHome);
  if (!raw) {
    return [];
  }
  const matches = [...raw.matchAll(/^\s*\[mcp_servers\.([^\]]+)\]\s*$/gm)];
  return [...new Set(matches.map((match) => String(match[1] ?? "").trim()).filter(Boolean))];
}

export function loadCodexModelCatalog(preferredHome?: string | null): { models: string[]; source: string; fetchedAt: string | null } {
  const home = codexHome(preferredHome);
  const cache = readModelsCache(home);
  const configModels = readConfigModels(home);
  const fallbackCache = home === globalCodexHome() ? { models: [], fetchedAt: null } : readModelsCache(globalCodexHome());
  const fallbackConfigModels = home === globalCodexHome() ? [] : readConfigModels(globalCodexHome());
  const models = [...new Set([...cache.models, ...configModels, ...fallbackCache.models, ...fallbackConfigModels])];
  const source = cache.models.length > 0 && configModels.length > 0
    ? "models_cache+config"
    : cache.models.length > 0
      ? "models_cache"
      : configModels.length > 0
        ? "config"
        : fallbackCache.models.length > 0 || fallbackConfigModels.length > 0
          ? "global_fallback"
          : "none";
  return {
    models,
    source: preferredHome ? `${source}:${home}` : source,
    fetchedAt: cache.fetchedAt ?? fallbackCache.fetchedAt,
  };
}

export function loadCodexMcpCatalog(preferredHome?: string | null): { servers: string[]; source: string } {
  const home = codexHome(preferredHome);
  const localServers = readMcpServers(home);
  const globalServers = home === globalCodexHome() ? [] : readMcpServers(globalCodexHome());
  const servers = [...new Set([...localServers, ...globalServers])];
  const source = localServers.length > 0
    ? preferredHome
      ? `config:${home}`
      : "config"
    : globalServers.length > 0
      ? "global_config"
      : "none";
  return { servers, source };
}
