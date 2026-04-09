// @ts-nocheck
import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { URL } from "node:url";
import { DEFAULT_CONFIG_PATH } from "../config/app-config";
import { SessionManager } from "../session/session-manager";
import { loadAgentHistoryPage, loadSessionEventPage } from "../persistence/storage";
import { launchCodexLogin, loadCodexAuthStatus, logoutCodexHome } from "../runtime/codex-home";

function sendJson(response: any, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendText(response: any, statusCode: number, text: string, contentType = "text/plain; charset=utf-8"): void {
  response.writeHead(statusCode, { "content-type": contentType });
  response.end(text);
}

async function readBody(request: any): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function serveStatic(response: any, filePath: string): void {
  if (!existsSync(filePath)) {
    sendText(response, 404, "Not found");
    return;
  }
  const contentTypes: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
  };
  response.writeHead(200, { "content-type": contentTypes[extname(filePath)] ?? "application/octet-stream" });
  createReadStream(filePath).pipe(response);
}

function resolvePublicFile(pathname: string): string | null {
  const publicRoot = resolve(process.cwd(), "public");
  const requestedPath = resolve(publicRoot, pathname.replace(/^\/+/, ""));
  if (!requestedPath.startsWith(publicRoot)) {
    return null;
  }
  return requestedPath;
}

function isAppRoute(pathname: string): boolean {
  return pathname === "/" || pathname === "/workspaces" || pathname === "/settings" || /^\/sessions\/[^/]+$/.test(pathname);
}

export async function startWebServer(options?: { configPath?: string; host?: string; port?: number }): Promise<{ close(): Promise<void>; url: string; manager: SessionManager }> {
  const configPath = options?.configPath ?? DEFAULT_CONFIG_PATH;
  const manager = new SessionManager(configPath);
  const host = options?.host ?? manager.config.defaults.serverHost;
  const port = options?.port ?? manager.config.defaults.serverPort;
  const sseBySession = new Map<string, Set<any>>();
  const sessionSubscriptions = new Map<string, () => void>();

  const attachSession = (session: any): void => {
    if (!session || sessionSubscriptions.has(session.id)) {
      return;
    }
    const unsubscribe = session.subscribe((payload: unknown) => {
      const listeners = sseBySession.get(session.id);
      if (!listeners) {
        return;
      }
      const chunk = `data: ${JSON.stringify(payload)}\n\n`;
      for (const client of listeners) {
        client.write(chunk);
      }
    });
    sessionSubscriptions.set(session.id, unsubscribe);
  };

  const detachSession = (sessionId: string): void => {
    const unsubscribe = sessionSubscriptions.get(sessionId);
    if (unsubscribe) {
      unsubscribe();
      sessionSubscriptions.delete(sessionId);
    }
    sseBySession.delete(sessionId);
  };

  const getInteractiveSession = async (sessionId: string, options?: { autoResumeIdle?: boolean }): Promise<any | null> => {
    const live = manager.getSession(sessionId);
    if (live) {
      return live;
    }
    if (!options?.autoResumeIdle) {
      return null;
    }
    const resumed = await manager.getOrAutoResumeIdleSession(sessionId);
    if (resumed) {
      attachSession(resumed);
    }
    return resumed;
  };

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);
      const pathname = url.pathname;

      if (request.method === "GET" && pathname === "/api/state") {
        sendJson(response, 200, manager.snapshot());
        return;
      }

      if (request.method === "POST" && pathname === "/api/config") {
        const next = await readBody(request);
        manager.updateConfig(next);
        const root = manager.snapshot();
        sendJson(response, 200, {
          config: root.config,
          codexAuthStatus: root.codexAuthStatus,
          codexUsageStatus: root.codexUsageStatus,
        });
        return;
      }

      if (request.method === "POST" && pathname === "/api/codex-auth/login") {
        const result = launchCodexLogin(manager.config);
        const root = manager.snapshot();
        sendJson(response, 200, {
          ok: true,
          ...result,
          codexAuthStatus: root.codexAuthStatus,
          codexUsageStatus: root.codexUsageStatus,
        });
        return;
      }

      if (request.method === "POST" && pathname === "/api/codex-auth/logout") {
        logoutCodexHome(manager.config);
        const root = manager.snapshot();
        sendJson(response, 200, {
          ok: true,
          codexAuthStatus: root.codexAuthStatus,
          codexUsageStatus: root.codexUsageStatus,
        });
        return;
      }

      if (request.method === "POST" && pathname === "/api/workspaces") {
        const body = await readBody(request);
        const config = manager.createWorkspace(String(body.name ?? ""));
        sendJson(response, 200, { config });
        return;
      }

      if (request.method === "POST" && pathname === "/api/sessions") {
        const body = await readBody(request);
        const session = await manager.startSession(body);
        attachSession(session);
        sendJson(response, 200, { session: session.snapshot() });
        return;
      }

      const resumeMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/resume$/);
      if (request.method === "POST" && resumeMatch) {
        const sessionId = decodeURIComponent(resumeMatch[1]);
        const session = await manager.resumeSession(sessionId);
        attachSession(session);
        sendJson(response, 200, { session: session.snapshot() });
        return;
      }

      const feedMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/feed$/);
      if (request.method === "GET" && feedMatch) {
        const sessionId = decodeURIComponent(feedMatch[1]);
        sendJson(response, 200, loadSessionEventPage(manager.config, sessionId, url.searchParams.get("before"), Number(url.searchParams.get("limit") || "40")));
        return;
      }

      const historyMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/agents\/([^/]+)\/history$/);
      if (request.method === "GET" && historyMatch) {
        const sessionId = decodeURIComponent(historyMatch[1]);
        const agentId = decodeURIComponent(historyMatch[2]);
        const kind = String(url.searchParams.get("kind") || "notes");
        sendJson(response, 200, loadAgentHistoryPage(manager.config, sessionId, agentId, kind as any, url.searchParams.get("before"), Number(url.searchParams.get("limit") || "40")));
        return;
      }

      const discussionMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/subgoals\/([^/]+)\/discussion$/);
      if (request.method === "POST" && discussionMatch) {
        const session = await getInteractiveSession(decodeURIComponent(discussionMatch[1]), { autoResumeIdle: false });
        if (!session) {
          sendJson(response, 404, { error: "Session not active." });
          return;
        }
        const body = await readBody(request);
        await session.appendSubgoalDiscussion(
          String(body.agentId ?? "").trim(),
          decodeURIComponent(discussionMatch[2]),
          String(body.content ?? ""),
        );
        sendJson(response, 200, { session: session.snapshot() });
        return;
      }

      const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (request.method === "GET" && sessionMatch) {
        const sessionId = decodeURIComponent(sessionMatch[1]);
        const live = manager.getSession(sessionId);
        const snapshot = live ? live.snapshot() : manager.snapshot().sessions.find((session) => session.id === sessionId);
        if (!snapshot) {
          sendJson(response, 404, { error: "Session not found." });
          return;
        }
        sendJson(response, 200, { session: snapshot });
        return;
      }

      const eventsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
      if (request.method === "GET" && eventsMatch) {
        const sessionId = decodeURIComponent(eventsMatch[1]);
        const session = await getInteractiveSession(sessionId, { autoResumeIdle: false });
        if (!session) {
          sendJson(response, 404, { error: "Session not active." });
          return;
        }
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        response.write(`data: ${JSON.stringify({ type: "session", sessionId, snapshot: session.snapshot() })}\n\n`);
        const listeners = sseBySession.get(sessionId) ?? new Set<any>();
        listeners.add(response);
        sseBySession.set(sessionId, listeners);
        request.on("close", () => {
          listeners.delete(response);
          if (listeners.size === 0) {
            sseBySession.delete(sessionId);
          }
        });
        return;
      }

      const instructionMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/instructions$/);
      if (request.method === "POST" && instructionMatch) {
        const session = await getInteractiveSession(decodeURIComponent(instructionMatch[1]), { autoResumeIdle: true });
        if (!session) {
          sendJson(response, 404, { error: "Session not active." });
          return;
        }
        const body = await readBody(request);
        if (body.channel === "goal") {
          await session.sendGoal(String(body.text ?? ""));
        } else {
          await session.sendOperatorInstruction(String(body.text ?? ""), body.targetAgentId ?? null);
        }
        sendJson(response, 200, { session: session.snapshot() });
        return;
      }

      const inputMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/inputs$/);
      if (request.method === "POST" && inputMatch) {
        const session = await getInteractiveSession(decodeURIComponent(inputMatch[1]), { autoResumeIdle: true });
        if (!session) {
          sendJson(response, 404, { error: "Session not active." });
          return;
        }
        const body = await readBody(request);
        await session.sendHumanInput(String(body.agentId ?? ""), String(body.text ?? ""));
        sendJson(response, 200, { session: session.snapshot() });
        return;
      }

      const stopAgentMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/agents\/([^/]+)\/stop$/);
      if (request.method === "POST" && stopAgentMatch) {
        const session = manager.getSession(decodeURIComponent(stopAgentMatch[1]));
        if (!session) {
          sendJson(response, 404, { error: "Session not active." });
          return;
        }
        await session.stopAgent(decodeURIComponent(stopAgentMatch[2]));
        sendJson(response, 200, { session: session.snapshot() });
        return;
      }

      const restartAgentMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/agents\/([^/]+)\/restart$/);
      if (request.method === "POST" && restartAgentMatch) {
        const session = manager.getSession(decodeURIComponent(restartAgentMatch[1]));
        if (!session) {
          sendJson(response, 404, { error: "Session not active." });
          return;
        }
        await session.restartAgent(decodeURIComponent(restartAgentMatch[2]));
        sendJson(response, 200, { session: session.snapshot() });
        return;
      }

      const stopMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/stop$/);
      if (request.method === "POST" && stopMatch) {
        const sessionId = decodeURIComponent(stopMatch[1]);
        const session = manager.getSession(sessionId);
        if (!session) {
          sendJson(response, 404, { error: "Session not active." });
          return;
        }
        await manager.stopSession(sessionId);
        detachSession(sessionId);
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "GET" && (pathname === "/app.js" || /^\/app\/.+\.js$/.test(pathname))) {
        const filePath = resolvePublicFile(pathname);
        if (!filePath) {
          sendText(response, 404, "Not found");
          return;
        }
        serveStatic(response, filePath);
        return;
      }
      if (request.method === "GET" && pathname === "/styles.css") {
        serveStatic(response, resolve(process.cwd(), "public", "styles.css"));
        return;
      }
      if (request.method === "GET" && isAppRoute(pathname)) {
        serveStatic(response, resolve(process.cwd(), "public", "index.html"));
        return;
      }

      sendText(response, 404, "Not found");
    } catch (error) {
      sendJson(response, 500, { error: (error as Error).message });
    }
  });

  await new Promise<void>((resolveStart) => server.listen(port, host, resolveStart));
  return {
    url: `http://${host}:${port}`,
    manager,
    close: async () => {
      for (const session of [...manager.snapshot().sessions]) {
        const live = manager.getSession(session.id);
        if (live) {
          await manager.hibernateSession(session.id);
          detachSession(session.id);
        }
      }
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error?: Error) => (error ? rejectClose(error) : resolveClose()));
      });
    },
  };
}
