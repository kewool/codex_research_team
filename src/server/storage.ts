// @ts-nocheck
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AgentHistoryEntry, AgentHistoryKind, AgentSnapshot, AppConfig, HistoryPage, SessionEvent, SessionSnapshot } from "../shared/types";
import { appendLine, ensureDir, readJson, slugify, tailText, timestampSlug, writeJson } from "./utils";

export interface SessionFiles {
  root: string;
  sessionJson: string;
  eventsJsonl: string;
  eventsLog: string;
  agentsDir: string;
}

export interface AgentFiles {
  root: string;
  stateJson: string;
  stdoutLog: string;
  stderrLog: string;
  inputLog: string;
  protocolLog: string;
  promptFile: string;
  notesJsonl: string;
  messagesJsonl: string;
  promptsJsonl: string;
  stdoutJsonl: string;
  stderrJsonl: string;
  errorsJsonl: string;
}

const HISTORY_FILE_NAMES: Record<AgentHistoryKind, keyof AgentFiles> = {
  notes: "notesJsonl",
  messages: "messagesJsonl",
  prompts: "promptsJsonl",
  stdout: "stdoutJsonl",
  stderr: "stderrJsonl",
  errors: "errorsJsonl",
};

export function createSessionFiles(config: AppConfig, goal: string): SessionFiles {
  const sessionId = `${timestampSlug()}-${slugify(goal).slice(0, 48)}`;
  const root = ensureDir(join(config.defaults.runsDir, sessionId));
  return {
    root,
    sessionJson: join(root, "session.json"),
    eventsJsonl: join(root, "events.jsonl"),
    eventsLog: join(root, "events.log"),
    agentsDir: ensureDir(join(root, "agents")),
  };
}

export function openSessionFiles(config: AppConfig, sessionId: string): SessionFiles {
  const root = ensureDir(resolveSessionRoot(config, sessionId));
  return {
    root,
    sessionJson: join(root, "session.json"),
    eventsJsonl: join(root, "events.jsonl"),
    eventsLog: join(root, "events.log"),
    agentsDir: ensureDir(join(root, "agents")),
  };
}

export function createAgentFiles(files: SessionFiles, agentId: string): AgentFiles {
  const root = ensureDir(join(files.agentsDir, agentId));
  return {
    root,
    stateJson: join(root, "state.json"),
    stdoutLog: join(root, "stdout.log"),
    stderrLog: join(root, "stderr.log"),
    inputLog: join(root, "input.log"),
    protocolLog: join(root, "protocol.log"),
    promptFile: join(root, "current-prompt.md"),
    notesJsonl: join(root, "notes.jsonl"),
    messagesJsonl: join(root, "messages.jsonl"),
    promptsJsonl: join(root, "prompts.jsonl"),
    stdoutJsonl: join(root, "stdout.jsonl"),
    stderrJsonl: join(root, "stderr.jsonl"),
    errorsJsonl: join(root, "errors.jsonl"),
  };
}

export function appendSessionEvent(files: SessionFiles, event: SessionEvent): void {
  appendLine(files.eventsJsonl, JSON.stringify(event));
  appendLine(files.eventsLog, `[${event.timestamp}] ${event.sender} -> ${event.channel}\n  ${event.content}`);
}

export function appendAgentHistory(files: AgentFiles, entry: AgentHistoryEntry): void {
  const fileKey = HISTORY_FILE_NAMES[entry.kind];
  appendLine(files[fileKey], JSON.stringify(entry));
}

export function writeSessionSnapshot(files: SessionFiles, snapshot: SessionSnapshot): void {
  writeJson(files.sessionJson, snapshot);
}

export function writeAgentSnapshot(filePath: string, snapshot: AgentSnapshot): void {
  writeJson(filePath, snapshot);
}

export function listSavedSessionRoots(runsDir: string): string[] {
  if (!existsSync(runsDir)) {
    return [];
  }
  return readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(runsDir, entry.name))
    .sort()
    .reverse();
}

export function loadSavedSession(root: string): SessionSnapshot | null {
  const sessionJson = join(root, "session.json");
  if (!existsSync(sessionJson)) {
    return null;
  }
  return readJson<SessionSnapshot | null>(sessionJson, null);
}

export function loadSavedSessions(config: AppConfig): SessionSnapshot[] {
  return listSavedSessionRoots(config.defaults.runsDir)
    .map((root) => loadSavedSession(root))
    .filter((snapshot): snapshot is SessionSnapshot => Boolean(snapshot && snapshot.id && snapshot.updatedAt && Array.isArray(snapshot.agents)));
}

export function readTail(filePath: string, maxChars = 6000): string {
  if (!existsSync(filePath)) {
    return "";
  }
  return tailText(readFileSync(filePath, "utf8"), maxChars);
}

export function resolveSessionRoot(config: AppConfig, sessionId: string): string {
  return resolve(config.defaults.runsDir, sessionId);
}

function parsePageCursor(value: unknown): number | null {
  if (value == null || value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.floor(parsed);
}

function readJsonlRows(filePath: string): any[] {
  if (!existsSync(filePath)) {
    return [];
  }
  const raw = readFileSync(filePath, "utf8").replace(/^\ufeff/, "");
  if (!raw.trim()) {
    return [];
  }
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function buildHistoryPage<T extends Record<string, any>>(rows: T[], before?: unknown, limit = 40): HistoryPage<T> {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 40));
  const endExclusive = Math.max(0, Math.min(rows.length, parsePageCursor(before) ?? rows.length));
  const start = Math.max(0, endExclusive - safeLimit);
  const pageRows = rows.slice(start, endExclusive).map((row, index) => ({
    ...row,
    _cursor: start + index + 1,
  }));
  return {
    items: pageRows.reverse() as T[],
    nextBefore: start > 0 ? start : null,
    hasMore: start > 0,
  };
}

export function loadSessionEventPage(config: AppConfig, sessionId: string, before?: unknown, limit = 40): HistoryPage<SessionEvent> {
  const filePath = join(resolveSessionRoot(config, sessionId), "events.jsonl");
  return buildHistoryPage<SessionEvent>(readJsonlRows(filePath), before, limit);
}

export function loadAgentHistoryPage(config: AppConfig, sessionId: string, agentId: string, kind: AgentHistoryKind, before?: unknown, limit = 40): HistoryPage<AgentHistoryEntry> {
  const files = createAgentFiles({
    root: resolveSessionRoot(config, sessionId),
    sessionJson: "",
    eventsJsonl: "",
    eventsLog: "",
    agentsDir: ensureDir(join(resolveSessionRoot(config, sessionId), "agents")),
  }, agentId);
  const fileKey = HISTORY_FILE_NAMES[kind];
  return buildHistoryPage<AgentHistoryEntry>(readJsonlRows(files[fileKey]), before, limit);
}
