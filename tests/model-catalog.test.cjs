const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { loadCodexMcpCatalog, loadCodexUsageStatus } = require("../dist/server/runtime/model-catalog.js");
const { INTERNAL_SESSION_MCP_SERVER_NAME } = require("../dist/server/runtime/codex-home.js");

test("loadCodexUsageStatus invalidates stale quota data after an auth fingerprint change", async (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "crt-usage-status-"));
  t.after(async () => {
    await fsp.rm(homeDir, { recursive: true, force: true });
  });

  const sessionDir = path.join(homeDir, "sessions", "2026", "03", "30");
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionFile = path.join(sessionDir, "rollout-test.jsonl");
  fs.writeFileSync(sessionFile, [
    JSON.stringify({
      timestamp: "2026-03-28T10:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          limit_id: "codex",
          limit_name: null,
          primary: { used_percent: 12, window_minutes: 300, resets_at: 1775000000 },
          secondary: { used_percent: 34, window_minutes: 10080, resets_at: 1775600000 },
          credits: null,
          plan_type: "pro",
        },
      },
    }),
  ].join("\n"), "utf8");

  fs.writeFileSync(path.join(homeDir, "auth.json"), JSON.stringify({
    tokens: { account_id: "acct_old" },
    last_refresh: "2026-03-28T09:00:00.000Z",
  }), "utf8");

  const first = loadCodexUsageStatus(homeDir);
  assert.equal(first.available, true);
  assert.equal(first.staleReason, null);
  assert.equal(first.primary.usedPercent, 12);

  fs.writeFileSync(path.join(homeDir, "auth.json"), JSON.stringify({
    tokens: { account_id: "acct_new" },
    last_refresh: "2026-03-30T11:00:00.000Z",
  }), "utf8");

  const second = loadCodexUsageStatus(homeDir);
  assert.equal(second.available, false);
  assert.equal(second.staleReason, "auth_changed");
  assert.equal(second.primary, null);
  assert.equal(second.secondary, null);
});

test("loadCodexMcpCatalog hides the internal session-state MCP server from selectable MCP settings", async (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "crt-mcp-catalog-"));
  t.after(async () => {
    await fsp.rm(homeDir, { recursive: true, force: true });
  });

  fs.writeFileSync(path.join(homeDir, "config.toml"), [
    `[mcp_servers.${INTERNAL_SESSION_MCP_SERVER_NAME}]`,
    'command = "node"',
    'args = ["dist/cli.js", "mcp-session"]',
    "",
    "[mcp_servers.custom]",
    'url = "https://example.test/mcp"',
    "",
  ].join("\n"), "utf8");

  const catalog = loadCodexMcpCatalog(homeDir);
  assert.ok(catalog.servers.includes("custom"));
  assert.ok(!catalog.servers.includes(INTERNAL_SESSION_MCP_SERVER_NAME));
});
