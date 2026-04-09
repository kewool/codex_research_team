const test = require("node:test");
const assert = require("node:assert/strict");

const { createPageRenderers } = require("../dist/client/app/page-renders.js");

function createHarness(options = {}) {
  const sessions = options.sessions || [];
  return createPageRenderers({
    state: {
      snapshot: {
        sessions,
        config: {
          defaults: {
            defaultWorkspaceName: null,
          },
          workspaces: [],
          agents: [],
        },
      },
    },
    escapeHtml: (value) => String(value ?? ""),
    formatLimitReset: () => "-",
    formatPercent: () => "-",
    formatRemainingPercent: () => "-",
    currentConfig: () => ({
      defaults: {
        defaultWorkspaceName: null,
      },
      workspaces: [],
      agents: [],
    }),
    currentCodexAuthStatus: () => null,
    currentCodexUsageStatus: () => null,
    activeSessions: () => [],
    modelOptions: () => [],
    reasoningEffortOptions: () => [],
    mcpOptions: () => [],
    modelCatalogSummary: () => "-",
    mcpCatalogSummary: () => "-",
    selectedWorkspace: () => null,
    renderLabel: (text) => text,
    renderHint: () => "?",
    renderChannelSelect: () => "",
    renderChannelCheckboxPicker: () => "",
    renderAgentCheckboxPicker: () => "",
    renderOptionCheckboxPicker: () => "",
    renderStageCheckboxPicker: () => "",
    renderModelSelect: () => "",
    renderReasoningEffortSelect: () => "",
    configuredChannelList: () => [],
    visibleDashboardSessions: () => sessions.slice(0, 2),
    dashboardSessionsMeta: () => ({
      shownCount: 2,
      totalCount: sessions.length,
      hasMore: sessions.length > 2,
    }),
  });
}

test("renderDashboardPage renders a bounded scroll container and footer for session lists", () => {
  const sessions = [
    { id: "session-1", title: "One", goal: "Goal", status: "idle", isLive: false, workspaceName: "a", updatedAt: "1", agents: [] },
    { id: "session-2", title: "Two", goal: "Goal", status: "idle", isLive: false, workspaceName: "a", updatedAt: "2", agents: [] },
    { id: "session-3", title: "Three", goal: "Goal", status: "idle", isLive: false, workspaceName: "a", updatedAt: "3", agents: [] },
  ];
  const renderers = createHarness({ sessions });

  const html = renderers.renderDashboardPage();

  assert.match(html, /dashboard-session-scroll/);
  assert.match(html, /data-session-list-kind="dashboard"/);
  assert.match(html, /Showing 2 of 3 sessions\. Scroll to load more\./);
  assert.match(html, /Open Session/);
});
