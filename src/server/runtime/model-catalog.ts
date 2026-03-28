// @ts-nocheck
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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

function toIsoFromEpochSeconds(value: unknown): string | null {
  const seconds = Number(value ?? 0);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return new Date(seconds * 1000).toISOString();
}

function toTimestampMs(value: string | null | undefined): number {
  const text = String(value ?? "").trim();
  if (!text) {
    return 0;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readSessionJsonlCandidates(baseHome: string): Array<{ path: string; mtimeMs: number }> {
  const sessionsRoot = join(baseHome, "sessions");
  if (!existsSync(sessionsRoot)) {
    return [];
  }
  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  for (const yearEntry of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!yearEntry.isDirectory()) {
      continue;
    }
    const yearPath = join(sessionsRoot, yearEntry.name);
    for (const monthEntry of readdirSync(yearPath, { withFileTypes: true })) {
      if (!monthEntry.isDirectory()) {
        continue;
      }
      const monthPath = join(yearPath, monthEntry.name);
      for (const dayEntry of readdirSync(monthPath, { withFileTypes: true })) {
        if (!dayEntry.isDirectory()) {
          continue;
        }
        const dayPath = join(monthPath, dayEntry.name);
        for (const fileEntry of readdirSync(dayPath, { withFileTypes: true })) {
          if (!fileEntry.isFile() || !fileEntry.name.endsWith(".jsonl")) {
            continue;
          }
          const filePath = join(dayPath, fileEntry.name);
          let mtimeMs = 0;
          try {
            mtimeMs = statSync(filePath).mtimeMs;
          } catch {
            mtimeMs = 0;
          }
          candidates.push({ path: filePath, mtimeMs });
        }
      }
    }
  }
  return candidates.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, 20);
}

function readLatestRateLimitsFromFile(filePath: string): { observedAt: string | null; payload: any | null } {
  try {
    const raw = readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
    const lines = raw.split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = String(lines[index] || "").trim();
      if (!line) {
        continue;
      }
      try {
        const parsed = JSON.parse(line);
        const payload = parsed?.payload;
        if (parsed?.type === "event_msg" && payload?.type === "token_count" && payload?.rate_limits) {
          return {
            observedAt: String(parsed?.timestamp ?? "").trim() || null,
            payload,
          };
        }
      } catch {
        continue;
      }
    }
  } catch {
    return { observedAt: null, payload: null };
  }
  return { observedAt: null, payload: null };
}

function mapRateLimitWindow(value: any): { usedPercent: number | null; windowMinutes: number | null; resetsAt: string | null } | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const usedPercent = Number(value.used_percent);
  const windowMinutes = Number(value.window_minutes);
  return {
    usedPercent: Number.isFinite(usedPercent) ? usedPercent : null,
    windowMinutes: Number.isFinite(windowMinutes) ? windowMinutes : null,
    resetsAt: toIsoFromEpochSeconds(value.resets_at),
  };
}

export function loadCodexUsageStatus(preferredHome?: string | null): {
  codexHomeDir: string;
  sourceFile: string | null;
  observedAt: string | null;
  available: boolean;
  planType: string | null;
  limitId: string | null;
  limitName: string | null;
  credits: number | null;
  primary: { usedPercent: number | null; windowMinutes: number | null; resetsAt: string | null } | null;
  secondary: { usedPercent: number | null; windowMinutes: number | null; resetsAt: string | null } | null;
} {
  const home = codexHome(preferredHome);
  let best: {
    candidatePath: string;
    observedAt: string | null;
    observedAtMs: number;
    mtimeMs: number;
    payload: any;
  } | null = null;
  for (const candidate of readSessionJsonlCandidates(home)) {
    const found = readLatestRateLimitsFromFile(candidate.path);
    if (!found.payload?.rate_limits) {
      continue;
    }
    const observedAtMs = toTimestampMs(found.observedAt);
    if (
      !best ||
      observedAtMs > best.observedAtMs ||
      (observedAtMs === best.observedAtMs && candidate.mtimeMs > best.mtimeMs)
    ) {
      best = {
        candidatePath: candidate.path,
        observedAt: found.observedAt,
        observedAtMs,
        mtimeMs: candidate.mtimeMs,
        payload: found.payload,
      };
    }
  }
  if (best?.payload?.rate_limits) {
    const rateLimits = best.payload.rate_limits;
    const credits = Number(rateLimits.credits);
    return {
      codexHomeDir: home,
      sourceFile: best.candidatePath,
      observedAt: best.observedAt,
      available: true,
      planType: String(rateLimits.plan_type ?? "").trim() || null,
      limitId: String(rateLimits.limit_id ?? "").trim() || null,
      limitName: String(rateLimits.limit_name ?? "").trim() || null,
      credits: Number.isFinite(credits) ? credits : null,
      primary: mapRateLimitWindow(rateLimits.primary),
      secondary: mapRateLimitWindow(rateLimits.secondary),
    };
  }
  return {
    codexHomeDir: home,
    sourceFile: null,
    observedAt: null,
    available: false,
    planType: null,
    limitId: null,
    limitName: null,
    credits: null,
    primary: null,
    secondary: null,
  };
}
