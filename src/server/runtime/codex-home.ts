// @ts-nocheck
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AppConfig, CodexAuthStatus } from "../../shared/types";
import { ensureDir, timestampSlug } from "../lib/utils";

const AUTH_ARTIFACTS = [
  "auth.json",
  "cap_sid",
  "internal_storage.json",
  ".codex-global-state.json",
];
const PROJECT_AUTH_BACKUP_DIR = ".separate-auth-backup";

const SHARED_RUNTIME_FILES = [
  "version.json",
  "models_cache.json",
];

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

function readJsonIfPresent(path: string): any | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readText(path));
  } catch {
    return null;
  }
}

function decodeJwtPayload(token: unknown): any | null {
  const text = String(token ?? "").trim();
  if (!text) {
    return null;
  }
  const parts = text.split(".");
  if (parts.length < 2) {
    return null;
  }
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function readCodexAuthEmail(homeDir: string): string | null {
  const auth = readJsonIfPresent(join(homeDir, "auth.json"));
  const payload = decodeJwtPayload(auth?.tokens?.id_token);
  const email = String(payload?.email ?? "").trim();
  return email || null;
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

function removePathIfPresent(targetPath: string): void {
  try {
    rmSync(targetPath, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function syncProjectRuntimeAssets(homeDir: string, options?: { mirrorAuth?: boolean }): void {
  const globalHomeDir = globalCodexHomeDir();
  const mirroredFiles = [
    ...SHARED_RUNTIME_FILES,
    ...((options?.mirrorAuth ?? true) ? AUTH_ARTIFACTS : []),
  ];

  for (const fileName of mirroredFiles) {
    copyFileIfPresent(join(globalHomeDir, fileName), join(homeDir, fileName));
  }

  replaceDirectoryIfPresent(join(globalHomeDir, "skills", ".system"), join(homeDir, "skills", ".system"));
  replaceDirectoryIfPresent(join(globalHomeDir, "vendor_imports"), join(homeDir, "vendor_imports"));
}

export function clearProjectAuthArtifacts(homeDir: string): void {
  for (const fileName of AUTH_ARTIFACTS) {
    removePathIfPresent(join(homeDir, fileName));
  }
}

export function backupProjectAuthArtifacts(homeDir: string): string {
  const backupDir = join(homeDir, PROJECT_AUTH_BACKUP_DIR);
  ensureDir(backupDir);
  for (const fileName of AUTH_ARTIFACTS) {
    removePathIfPresent(join(backupDir, fileName));
    copyFileIfPresent(join(homeDir, fileName), join(backupDir, fileName));
  }
  return backupDir;
}

export function restoreProjectAuthArtifacts(homeDir: string): boolean {
  const backupDir = join(homeDir, PROJECT_AUTH_BACKUP_DIR);
  let restored = false;
  for (const fileName of AUTH_ARTIFACTS) {
    const backupPath = join(backupDir, fileName);
    if (!existsSync(backupPath)) {
      continue;
    }
    copyFileIfPresent(backupPath, join(homeDir, fileName));
    restored = true;
  }
  return restored;
}

function codexCommand(config: AppConfig): string {
  return String(config.defaults.codexCommand || "codex").trim() || "codex";
}

function codexEnv(config: AppConfig, homeDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CODEX_HOME: homeDir,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };
}

function controlsLocked(config: AppConfig): boolean {
  return config.defaults.codexHomeMode === "project" && config.defaults.codexAuthMode === "mirror-global";
}

function quoteForPowerShell(value: string): string {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function runCodexCommandSync(config: AppConfig, homeDir: string, args: string[]): {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
  errorMessage: string | null;
} {
  try {
    const command = codexCommand(config);
    const result = process.platform === "win32"
      ? spawnSync("powershell.exe", [
          "-NoProfile",
          "-Command",
          `& ${quoteForPowerShell(command)} ${args.join(" ")}`.trim(),
        ], {
          cwd: process.cwd(),
          env: codexEnv(config, homeDir),
          encoding: "utf8",
          windowsHide: true,
        })
      : spawnSync(command, args, {
          cwd: process.cwd(),
          env: codexEnv(config, homeDir),
          encoding: "utf8",
          windowsHide: true,
        });
    return {
      ok: !result.error && result.status === 0,
      stdout: String(result.stdout ?? "").trim(),
      stderr: String(result.stderr ?? "").trim(),
      status: result.status ?? null,
      errorMessage: result.error ? String(result.error.message ?? result.error) : null,
    };
  } catch (error) {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      status: null,
      errorMessage: String((error as Error)?.message ?? error),
    };
  }
}

function authSummaryPrefix(config: AppConfig): string {
  if (config.defaults.codexHomeMode === "global") {
    return "Global Codex login";
  }
  return config.defaults.codexAuthMode === "mirror-global" ? "Project Codex login (mirrors global)" : "Project Codex login";
}

export function loadCodexAuthStatus(config: AppConfig): CodexAuthStatus {
  const homeDir = effectiveCodexHomeDir(config);
  const result = runCodexCommandSync(config, homeDir, ["login", "status"]);
  const rawOutput = [result.stdout, result.stderr, result.errorMessage].filter(Boolean).join("\n").trim();
  const loggedIn = result.ok && /logged in/i.test(rawOutput || "");
  const email = loggedIn ? readCodexAuthEmail(homeDir) : null;
  const summary = rawOutput
    ? `${authSummaryPrefix(config)}: ${rawOutput}`
    : `${authSummaryPrefix(config)}: ${loggedIn ? "logged in" : "not logged in"}`;
  return {
    codexHomeDir: homeDir,
    codexHomeMode: config.defaults.codexHomeMode,
    codexAuthMode: config.defaults.codexAuthMode,
    loggedIn,
    email,
    summary,
    rawOutput,
    lastCheckedAt: new Date().toISOString(),
    controlsLocked: controlsLocked(config),
  };
}

export function launchCodexLogin(config: AppConfig): { message: string; codexHomeDir: string; launcherPath: string; alreadyLoggedIn: boolean } {
  if (controlsLocked(config)) {
    throw new Error("Project auth is mirroring the global Codex login. Switch Auth Mode to Separate before using a project-local login.");
  }
  const previousStatus = loadCodexAuthStatus(config);
  const homeDir = syncProjectCodexHome(config);
  if (process.platform !== "win32") {
    throw new Error("Interactive Codex login launch is currently implemented only on Windows.");
  }
  const launcherDir = join(homeDir, "runtime");
  ensureDir(launcherDir);
  const launcherPath = join(launcherDir, `open-login-${timestampSlug()}.cmd`);
  const launcherText = [
    "@echo off",
    "setlocal",
    `set "CODEX_HOME=${homeDir}"`,
    `cd /d "${process.cwd()}"`,
    "echo codex_research_team project login",
    "echo.",
    `call "${codexCommand(config)}" login`,
    "echo.",
    "echo Login finished. Press any key to close this window.",
    "pause >nul",
    "",
  ].join("\r\n");
  writeFileSync(launcherPath, launcherText, "utf8");
  const child = spawn("cmd.exe", [
    "/c",
    "start",
    "",
    launcherPath,
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  const launcherInstruction = `If no window appears, run ${launcherPath} manually and then refresh auth status.`;
  return {
    message: previousStatus.loggedIn
      ? `This Codex home is already logged in. A reauthentication launcher was prepared for ${homeDir}. ${launcherInstruction}`
      : `Prepared a Codex login launcher for ${homeDir}. ${launcherInstruction}`,
    codexHomeDir: homeDir,
    launcherPath,
    alreadyLoggedIn: previousStatus.loggedIn,
  };
}

export function logoutCodexHome(config: AppConfig): CodexAuthStatus {
  if (controlsLocked(config)) {
    throw new Error("Project auth is mirroring the global Codex login. Switch Auth Mode to Separate before logging out the project home.");
  }
  const homeDir = syncProjectCodexHome(config);
  const result = runCodexCommandSync(config, homeDir, ["logout"]);
  if (!result.ok) {
    throw new Error(result.errorMessage || result.stderr || result.stdout || "Codex logout failed.");
  }
  return loadCodexAuthStatus(config);
}

export function syncProjectCodexHome(config: AppConfig, options?: { preserveProjectAuth?: boolean; restoreSeparateAuth?: boolean }): string {
  const homeDir = effectiveCodexHomeDir(config);
  if (config.defaults.codexHomeMode !== "project") {
    return homeDir;
  }

  ensureDir(homeDir);
  if (options?.preserveProjectAuth) {
    backupProjectAuthArtifacts(homeDir);
  }
  if (config.defaults.codexAuthMode !== "separate") {
    clearProjectAuthArtifacts(homeDir);
  }
  syncProjectRuntimeAssets(homeDir, { mirrorAuth: config.defaults.codexAuthMode !== "separate" });
  if (options?.restoreSeparateAuth && config.defaults.codexAuthMode === "separate") {
    restoreProjectAuthArtifacts(homeDir);
  }
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
