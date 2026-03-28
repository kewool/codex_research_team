// @ts-nocheck
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { AppConfig, RootSnapshot, StartSessionRequest, SUBGOAL_STAGES } from "../../shared/types";
import { defaultListenChannels, defaultPublishChannel, emptyAgentPolicy, loadConfig, normalizeAgentPolicy, normalizeDefaults, saveConfig } from "../config/app-config";
import { loadSavedSession, loadSavedSessions, openSessionFiles, resolveSessionRoot } from "../persistence/storage";
import { slugify } from "../lib/utils";
import { LiveSession } from "./live-session";
import { loadCodexMcpCatalog, loadCodexModelCatalog, loadCodexUsageStatus } from "../runtime/model-catalog";
import { ensureCodexWorkspaceTrust } from "../runtime/codex-trust";
import { effectiveCodexHomeDir, loadCodexAuthStatus, syncProjectCodexHome } from "../runtime/codex-home";

function normalizeModelList(values: unknown[], current?: string | null): string[] {
  const deduped = new Set<string>();
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) {
      deduped.add(text);
    }
  }
  const currentText = String(current ?? "").trim();
  if (currentText) {
    deduped.add(currentText);
  }
  return [...deduped];
}

export class SessionManager {
  readonly configPath: string;
  config: AppConfig;
  private readonly activeSessions = new Map<string, LiveSession>();

  constructor(configPath: string) {
    this.configPath = configPath;
    this.config = loadConfig(configPath);
    syncProjectCodexHome(this.config);
  }

  snapshot(): RootSnapshot {
    const active = [...this.activeSessions.values()].map((session) => ({
      ...session.snapshot(),
      isLive: true,
    }));
    const saved = loadSavedSessions(this.config)
      .filter((savedSession) => Boolean(savedSession && savedSession.id) && !this.activeSessions.has(savedSession.id))
      .map((savedSession) => ({
        ...savedSession,
        isLive: false,
      }));
    const preferredHome = effectiveCodexHomeDir(this.config);
    return {
      config: this.config,
      subgoalStages: [...SUBGOAL_STAGES],
      sessions: [...active, ...saved].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))),
      modelCatalog: loadCodexModelCatalog(preferredHome),
      mcpCatalog: loadCodexMcpCatalog(preferredHome),
      codexAuthStatus: loadCodexAuthStatus(this.config),
      codexUsageStatus: loadCodexUsageStatus(preferredHome),
    };
  }

  async startSession(request: StartSessionRequest): Promise<LiveSession> {
    const goal = request.goal.trim();
    if (!goal) {
      throw new Error("Goal is required.");
    }
    const workspace = this.resolveWorkspace(request.workspaceName, request.workspacePath);
    const codexHomeDir = syncProjectCodexHome(this.config);
    ensureCodexWorkspaceTrust(workspace.path, codexHomeDir);
    const title = (request.title?.trim() || goal).slice(0, 80);
    const session = new LiveSession({
      config: this.config,
      goal,
      title,
      workspaceName: workspace.name,
      workspacePath: workspace.path,
    });
    this.activeSessions.set(session.id, session);
    await session.start();
    return session;
  }

  async resumeSession(id: string): Promise<LiveSession> {
    const active = this.getSession(id);
    if (active) {
      return active;
    }
    const snapshot = loadSavedSession(resolveSessionRoot(this.config, id));
    if (!snapshot) {
      throw new Error(`Unknown session: ${id}`);
    }
    const codexHomeDir = syncProjectCodexHome(this.config);
    ensureCodexWorkspaceTrust(snapshot.workspacePath, codexHomeDir);
    mkdirSync(snapshot.workspacePath, { recursive: true });
    const session = new LiveSession({
      config: this.config,
      goal: snapshot.goal,
      title: snapshot.title,
      workspaceName: snapshot.workspaceName,
      workspacePath: snapshot.workspacePath,
      files: openSessionFiles(this.config, snapshot.id),
      snapshot,
    });
    this.activeSessions.set(session.id, session);
    await session.resume();
    return session;
  }

  getSession(id: string): LiveSession | null {
    return this.activeSessions.get(id) ?? null;
  }

  async stopSession(id: string): Promise<void> {
    const session = this.getSession(id);
    if (!session) {
      throw new Error(`Unknown session: ${id}`);
    }
    await session.stop();
    this.activeSessions.delete(id);
  }

  updateConfig(next: AppConfig): AppConfig {
    const previousDefaults = structuredClone(this.config.defaults || {});
    const workspaces = Array.isArray(next.workspaces)
      ? next.workspaces
          .map((workspace) => ({
            name: String(workspace.name ?? "").trim(),
            path: resolve(String(workspace.path ?? "").trim()),
          }))
          .filter((workspace) => workspace.name && workspace.path)
      : this.config.workspaces;

    for (const workspace of workspaces) {
      mkdirSync(workspace.path, { recursive: true });
    }

    const mergedDefaults = normalizeDefaults(next.defaults, this.config.defaults);
    if (mergedDefaults.codexHomeMode === "project") {
      mergedDefaults.codexHomeDir = resolve(mergedDefaults.codexHomeDir);
    }
    if (workspaces.length === 0) {
      const defaultWorkspace = {
        name: "default",
        path: resolve(mergedDefaults.workspacesDir, "default"),
      };
      mkdirSync(defaultWorkspace.path, { recursive: true });
      workspaces.push(defaultWorkspace);
    }
    mergedDefaults.model = String(mergedDefaults.model ?? "").trim() || null;
    mergedDefaults.modelOptions = normalizeModelList(Array.isArray(mergedDefaults.modelOptions) ? mergedDefaults.modelOptions : [], mergedDefaults.model);

    const agents = Array.isArray(next.agents) && next.agents.length > 0
      ? next.agents.map((agent, index) => {
          const model = String(agent.model ?? "").trim() || null;
          if (model) {
            mergedDefaults.modelOptions = normalizeModelList(mergedDefaults.modelOptions, model);
          }
          const publishChannel = String(agent.publishChannel ?? defaultPublishChannel(mergedDefaults)).trim() || defaultPublishChannel(mergedDefaults);
          const rawChannels = Array.isArray(agent.listenChannels) ? agent.listenChannels.map((value) => String(value ?? "").trim()).filter(Boolean) : [];
          const listenChannels = rawChannels.length > 0 ? [...new Set(rawChannels)] : defaultListenChannels(mergedDefaults);
          return {
            id: String(agent.id ?? `agent_${index + 1}`).trim() || `agent_${index + 1}`,
            name: String(agent.name ?? `agent_${index + 1}`).trim() || `agent_${index + 1}`,
            brief: String(agent.brief ?? "Explore independently and share novel findings.").trim() || "Explore independently and share novel findings.",
            publishChannel,
            listenChannels,
            maxTurns: Number(agent.maxTurns ?? 0) || 0,
            model,
            policy: normalizeAgentPolicy(agent.policy ?? emptyAgentPolicy()),
          };
        })
      : this.config.agents;

    this.config = {
      defaults: mergedDefaults,
      workspaces,
      agents,
    };

    if (this.config.defaults.codexHomeMode === "project") {
      mkdirSync(resolve(this.config.defaults.codexHomeDir), { recursive: true });
      syncProjectCodexHome(this.config, {
        clearProjectAuth: previousDefaults.codexAuthMode !== "separate" && this.config.defaults.codexAuthMode === "separate",
      });
    }

    if (!this.config.defaults.defaultWorkspaceName || !workspaces.some((workspace) => workspace.name === this.config.defaults.defaultWorkspaceName)) {
      this.config.defaults.defaultWorkspaceName = workspaces[0]?.name ?? null;
    }

    saveConfig(this.config, this.configPath);
    return this.config;
  }

  createWorkspace(name: string): AppConfig {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error("Workspace name is required.");
    }
    const path = resolve(this.config.defaults.workspacesDir, slugify(trimmed));
    if (this.config.workspaces.some((workspace) => workspace.name === trimmed)) {
      throw new Error(`Workspace already exists: ${trimmed}`);
    }
    mkdirSync(path, { recursive: true });
    this.config.workspaces.push({ name: trimmed, path });
    if (!this.config.defaults.defaultWorkspaceName) {
      this.config.defaults.defaultWorkspaceName = trimmed;
    }
    saveConfig(this.config, this.configPath);
    return this.config;
  }

  private resolveWorkspace(name?: string, path?: string): { name: string; path: string } {
    if (path?.trim()) {
      const resolvedPath = resolve(path.trim());
      mkdirSync(resolvedPath, { recursive: true });
      return {
        name: name?.trim() || slugify(path.trim()),
        path: resolvedPath,
      };
    }

    const chosenName = name?.trim() || this.config.defaults.defaultWorkspaceName;
    if (!chosenName) {
      throw new Error("No workspace selected. Add a workspace first.");
    }
    const workspace = this.config.workspaces.find((item) => item.name === chosenName);
    if (!workspace) {
      throw new Error(`Workspace not found: ${chosenName}`);
    }
    mkdirSync(workspace.path, { recursive: true });
    return workspace;
  }
}



