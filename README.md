# codex_research_team

`codex_research_team` is a local multi-agent Codex orchestration tool with a browser UI.
It runs a configurable team of agents against a selected workspace, keeps session state on disk, and exposes live team feed, goal board, prompts, logs, and token usage in the web app.

## What it does

- Runs a local Node + TypeScript server with a browser UI
- Starts one Codex runtime per agent
- Routes work through a shared goal board with subgoals and stages
- Stores sessions, agent logs, prompts, and history under `runs/`
- Supports project-scoped Codex settings, auth, MCP selection, and model defaults

## Requirements

- Node.js 22+
- Yarn Classic (`1.x`)
- Codex CLI available on your `PATH`

## Quick start

Install dependencies:

```bash
yarn install
```

Build the project:

```bash
yarn build
```

Start the local server:

```bash
yarn serve
```

Then open the printed URL in your browser. The default is usually:

```text
http://127.0.0.1:4280
```

## Workflow

1. Open `/workspaces` and create or select a workspace.
2. Put the project files you want agents to work on inside that workspace.
3. Open `/settings` and adjust agent/team/runtime settings if needed.
4. Start a session from the dashboard with a top-level goal.
5. Watch the feed, goal board, and per-agent logs update live.
6. Send a new goal or operator instruction when you want to redirect the session.

## Main routes

- `/`: dashboard and session launcher
- `/workspaces`: workspace presets
- `/settings`: runtime, auth, models, channels, and agent policies
- `/sessions/<session-id>`: live or saved session detail view

## CLI commands

Build:

```bash
yarn build
```

Run the web UI:

```bash
yarn serve
```

Open the settings menu:

```bash
yarn settings
```

Open the workspace menu:

```bash
yarn workspace
```

Initialize a fresh config file:

```bash
node dist/cli.js init
```

## Configuration

The main project config lives at:

```text
./codex_research_team.config.json
```

This file stores:

- server host and port
- workspace presets
- default workspace
- agent presets and policies
- model defaults
- Codex home/auth mode
- sandbox and search settings
- MCP server selection

Project-scoped Codex runtime data is stored under:

```text
./.codex_research_team/
```

## Repository layout

- `src/server/`: session manager, runtime orchestration, storage, config, Codex integration
- `src/client/`: browser UI logic
- `src/shared/`: shared app types
- `public/`: static HTML and CSS
- `scripts/`: local build helpers
- `runs/`: saved sessions and agent logs
- `workspaces/`: user workspaces

## Session artifacts

Each session creates a folder under `runs/<timestamp>-<slug>/` with files such as:

- `session.json`
- `events.jsonl`
- `events.log`
- `agents/<agent>/state.json`
- `agents/<agent>/stdout.log`
- `agents/<agent>/stderr.log`
- `agents/<agent>/input.log`
- `agents/<agent>/protocol.log`

## Notes

- The browser UI is the primary interface.
- Session state is persisted locally; saved sessions can be reopened from the UI.
- Commands and generated changes are expected to stay inside the selected workspace.
