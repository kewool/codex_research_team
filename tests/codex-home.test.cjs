const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  backupProjectAuthArtifacts,
  clearProjectAuthArtifacts,
  INTERNAL_SESSION_MCP_SERVER_NAME,
  loadCodexAuthStatus,
  restoreProjectAuthArtifacts,
  syncProjectCodexHome,
} = require("../dist/server/runtime/codex-home.js");
const { createDefaultConfig } = require("../dist/server/config/app-config.js");

test("project auth artifacts can be backed up and restored across auth mode switches", async (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "crt-codex-home-"));
  t.after(async () => {
    await fsp.rm(homeDir, { recursive: true, force: true });
  });

  const artifactPath = path.join(homeDir, "auth.json");
  fs.writeFileSync(artifactPath, JSON.stringify({ token: "separate-login" }), "utf8");

  const backupDir = backupProjectAuthArtifacts(homeDir);
  assert.equal(fs.existsSync(path.join(backupDir, "auth.json")), true);

  clearProjectAuthArtifacts(homeDir);
  assert.equal(fs.existsSync(artifactPath), false);

  const restored = restoreProjectAuthArtifacts(homeDir);
  assert.equal(restored, true);
  assert.equal(fs.existsSync(artifactPath), true);
  assert.match(fs.readFileSync(artifactPath, "utf8"), /separate-login/);
});

test("restoreProjectAuthArtifacts returns false when no separate auth backup exists", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "crt-codex-home-empty-"));
  try {
    assert.equal(restoreProjectAuthArtifacts(homeDir), false);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("mirror-global keeps separate auth only as backup and restores it when switching back", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "crt-codex-home-switch-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = rootDir;
  process.env.USERPROFILE = rootDir;
  t.after(async () => {
    process.env.HOME = previousHome;
    process.env.USERPROFILE = previousUserProfile;
    await fsp.rm(rootDir, { recursive: true, force: true });
  });

  const config = createDefaultConfig(rootDir);
  config.defaults.codexHomeMode = "project";
  config.defaults.codexHomeDir = path.join(rootDir, ".codex_research_team", "home");
  config.defaults.codexAuthMode = "separate";

  const projectHome = config.defaults.codexHomeDir;
  const globalHome = path.join(rootDir, ".codex");
  fs.mkdirSync(projectHome, { recursive: true });
  fs.mkdirSync(globalHome, { recursive: true });
  fs.writeFileSync(path.join(projectHome, "auth.json"), JSON.stringify({ token: "separate-login" }), "utf8");
  fs.writeFileSync(path.join(globalHome, "auth.json"), JSON.stringify({ token: "global-login" }), "utf8");

  config.defaults.codexAuthMode = "mirror-global";
  syncProjectCodexHome(config, { preserveProjectAuth: true });
  assert.match(fs.readFileSync(path.join(projectHome, "auth.json"), "utf8"), /global-login/);
  assert.match(fs.readFileSync(path.join(projectHome, ".separate-auth-backup", "auth.json"), "utf8"), /separate-login/);

  config.defaults.codexAuthMode = "separate";
  syncProjectCodexHome(config, { restoreSeparateAuth: true });
  assert.match(fs.readFileSync(path.join(projectHome, "auth.json"), "utf8"), /separate-login/);
});

test("loadCodexAuthStatus exposes the full email from auth.json when logged in", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "crt-codex-home-email-"));
  t.after(async () => {
    await fsp.rm(rootDir, { recursive: true, force: true });
  });

  const config = createDefaultConfig(rootDir);
  config.defaults.codexHomeMode = "project";
  config.defaults.codexAuthMode = "separate";
  config.defaults.codexHomeDir = path.join(rootDir, ".codex_research_team", "home");
  config.defaults.codexCommand = path.join(rootDir, "fake-codex.cmd");

  fs.mkdirSync(config.defaults.codexHomeDir, { recursive: true });
  fs.writeFileSync(config.defaults.codexCommand, "@echo off\r\necho Logged in using ChatGPT 1>&2\r\n", "utf8");

  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = `${encode({ alg: "none", typ: "JWT" })}.${encode({ email: "full.email@example.com" })}.`;
  fs.writeFileSync(path.join(config.defaults.codexHomeDir, "auth.json"), JSON.stringify({
    tokens: {
      id_token: token,
      account_id: "acct_123",
    },
  }), "utf8");

  const status = loadCodexAuthStatus(config);
  assert.equal(status.loggedIn, true);
  assert.equal(status.email, "full.email@example.com");
});

test("syncProjectCodexHome always injects the internal session-state MCP server into the project config", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "crt-codex-home-mcp-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = rootDir;
  process.env.USERPROFILE = rootDir;
  t.after(async () => {
    process.env.HOME = previousHome;
    process.env.USERPROFILE = previousUserProfile;
    await fsp.rm(rootDir, { recursive: true, force: true });
  });

  const config = createDefaultConfig(rootDir);
  config.defaults.codexHomeMode = "project";
  config.defaults.codexHomeDir = path.join(rootDir, ".codex_research_team", "home");

  const homeDir = syncProjectCodexHome(config);
  const rendered = fs.readFileSync(path.join(homeDir, "config.toml"), "utf8");

  assert.match(rendered, new RegExp(`\\[mcp_servers\\.${INTERNAL_SESSION_MCP_SERVER_NAME}\\]`));
  assert.match(rendered, /mcp-session/);
  assert.match(rendered, /\[features\][\s\S]*rmcp_client = true/);
});
