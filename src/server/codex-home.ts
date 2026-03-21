// @ts-nocheck
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AppConfig } from "../shared/types";
import { ensureDir } from "./utils";

function readText(path: string): string {
  if (!existsSync(path)) {
    return "";
  }
  try {
    return readFileSync(path, "utf8").replace(/^\ufeff/, "").replace(/\r\n/g, "\n");
  } catch {
    return "";
  }
}

function splitTomlSections(raw: string): Array<{ name: string; text: string }> {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const headers: Array<{ index: number; name: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].trim().match(/^\[([^\]]+)\]\s*$/);
    if (match) {
      headers.push({ index, name: String(match[1] ?? "").trim() });
    }
  }
  return headers.map((header, index) => {
    const end = index + 1 < headers.length ? headers[index + 1].index : lines.length;
    const text = lines.slice(header.index, end).join("\n").trimEnd();
    return { name: header.name, text };
  });
}

function firstTomlPathSegment(value: string): string {
  const text = String(value ?? "").trim();
  if (!text) {
    return "";
  }
  const first = text[0];
  if (first === "'" || first === '"') {
    const closing = text.indexOf(first, 1);
    return closing > 1 ? text.slice(1, closing) : text.slice(1);
  }
  const dotIndex = text.indexOf(".");
  return dotIndex >= 0 ? text.slice(0, dotIndex) : text;
}

function mcpServerName(sectionName: string): string | null {
  const prefix = "mcp_servers.";
  if (!String(sectionName ?? "").startsWith(prefix)) {
    return null;
  }
  return firstTomlPathSegment(String(sectionName).slice(prefix.length)) || null;
}

function projectSectionName(sectionName: string): string | null {
  return String(sectionName ?? "").startsWith("projects.") ? String(sectionName) : null;
}

function collectGroupedSections(raw: string, groupForSection: (sectionName: string) => string | null): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const section of splitTomlSections(raw)) {
    const group = groupForSection(section.name);
    if (!group || !section.text.trim()) {
      continue;
    }
    const current = groups.get(group) ?? [];
    current.push(section.text.trimEnd());
    groups.set(group, current);
  }
  return groups;
}

function quoteTomlString(value: string): string {
  return `"${String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function renderTopLevelConfig(config: AppConfig): string[] {
  const lines: string[] = [];
  const model = String(config.defaults.model ?? "").trim();
  const reasoning = String(config.defaults.modelReasoningEffort ?? "").trim();
  lines.push(`web_search = ${quoteTomlString(config.defaults.search ? "live" : "disabled")}`);
  if (model) {
    lines.push(`model = ${quoteTomlString(model)}`);
  }
  if (reasoning) {
    lines.push(`model_reasoning_effort = ${quoteTomlString(reasoning)}`);
  }
  return lines;
}

function renderFeatureSection(hasMcpServers: boolean): string[] {
  if (!hasMcpServers) {
    return [];
  }
  return [
    "[features]",
    "rmcp_client = true",
  ];
}

export function globalCodexHomeDir(): string {
  return join(homedir(), ".codex");
}

export function effectiveCodexHomeDir(config: AppConfig): string {
  if (config.defaults.codexHomeMode === "project") {
    return resolve(String(config.defaults.codexHomeDir || join(process.cwd(), ".codex_research_team", "home")));
  }
  return globalCodexHomeDir();
}

export function effectiveCodexConfigPath(config: AppConfig): string {
  return join(effectiveCodexHomeDir(config), "config.toml");
}

function copyFileIfPresent(sourcePath: string, destinationPath: string): void {
  if (!existsSync(sourcePath)) {
    return;
  }
  ensureDir(dirname(destinationPath));
  cpSync(sourcePath, destinationPath, { force: true });
}

function replaceDirectoryIfPresent(sourcePath: string, destinationPath: string): void {
  if (!existsSync(sourcePath)) {
    return;
  }
  try {
    rmSync(destinationPath, { recursive: true, force: true });
  } catch {
    // ignore and retry via copy below
  }
  ensureDir(dirname(destinationPath));
  cpSync(sourcePath, destinationPath, { recursive: true, force: true });
}

function syncProjectRuntimeAssets(homeDir: string): void {
  const globalHomeDir = globalCodexHomeDir();
  const mirroredFiles = [
    "auth.json",
    "cap_sid",
    "version.json",
    "models_cache.json",
    "internal_storage.json",
    ".codex-global-state.json",
  ];

  for (const fileName of mirroredFiles) {
    copyFileIfPresent(join(globalHomeDir, fileName), join(homeDir, fileName));
  }

  replaceDirectoryIfPresent(join(globalHomeDir, "skills", ".system"), join(homeDir, "skills", ".system"));
  replaceDirectoryIfPresent(join(globalHomeDir, "vendor_imports"), join(homeDir, "vendor_imports"));
}

export function syncProjectCodexHome(config: AppConfig): string {
  const homeDir = effectiveCodexHomeDir(config);
  if (config.defaults.codexHomeMode !== "project") {
    return homeDir;
  }

  ensureDir(homeDir);
  syncProjectRuntimeAssets(homeDir);
  const configPath = join(homeDir, "config.toml");
  const globalConfigText = readText(join(globalCodexHomeDir(), "config.toml"));
  const existingConfigText = readText(configPath);
  const selectedServers = [...new Set((config.defaults.mcpServerNames || []).map((value) => String(value ?? "").trim()).filter(Boolean))];
  const mcpSections = collectGroupedSections(globalConfigText, mcpServerName);
  const projectSections = collectGroupedSections(existingConfigText, projectSectionName);

  const renderedBlocks: string[] = [];
  const topLevel = renderTopLevelConfig(config);
  if (topLevel.length > 0) {
    renderedBlocks.push(topLevel.join("\n"));
  }

  const featureSection = renderFeatureSection(selectedServers.some((server) => mcpSections.has(server)));
  if (featureSection.length > 0) {
    renderedBlocks.push(featureSection.join("\n"));
  }

  for (const server of selectedServers) {
    const blocks = mcpSections.get(server) ?? [];
    for (const block of blocks) {
      renderedBlocks.push(block);
    }
  }

  for (const blocks of projectSections.values()) {
    for (const block of blocks) {
      renderedBlocks.push(block);
    }
  }

  mkdirSync(homeDir, { recursive: true });
  const output = renderedBlocks.filter(Boolean).join("\n\n").trim();
  writeFileSync(configPath, output ? `${output}\n` : "", "utf8");
  return homeDir;
}
