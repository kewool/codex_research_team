# codex-group

`codex-group` is now a TypeScript project with a local Node backend and a browser UI.
It keeps one long-lived Codex process per agent, streams agent output into the web UI, lets you inject `1/2/3/custom` input into a specific agent, and stores sessions under `runs/`.

## Stack

- Backend: Node + TypeScript
- UI: browser UI served by the local backend
- Agent runtime: one long-lived Codex CLI process per agent
- Storage: JSON config + JSONL/session logs on disk

## Layout

- `src/server/`: session manager, Codex process wrapper, storage, config
- `src/client/`: browser UI logic
- `src/shared/`: shared app types
- `public/`: static HTML and CSS
- `scripts/run-tsc.mjs`: local TypeScript compiler launcher
- `runs/`: saved sessions
- `workspaces/`: saved workspaces and user files

## Build

Use Yarn classic for this project. A local cache folder is already configured in `.yarnrc`, so Yarn stays inside the project directory.

Install and build:

```bash
& "C:\Program Files\nodejs\yarn.cmd" install
& "C:\Program Files\nodejs\yarn.cmd" build
```

If PowerShell blocks `yarn.ps1`, use `yarn.cmd` as shown above. If `yarn` already works in your shell, the short form is:

```bash
yarn install
yarn build
```

## Run

Start the local web server:

```bash
& "C:\Program Files\nodejs\yarn.cmd" serve
```

Then open the printed URL in your browser, usually:

```text
http://127.0.0.1:4280
```

Main routes:

- `/`: dashboard and session launch
- `/workspaces`: workspace, agent, and runtime settings
- `/sessions/<session-id>`: live session detail page

## CLI menus

Settings menu:

```bash
& "C:\Program Files\nodejs\yarn.cmd" settings
```

Workspace menu:

```bash
& "C:\Program Files\nodejs\yarn.cmd" workspace
```

Initialize a fresh config file:

```bash
node dist/cli.js init
```

## Web UI flow

1. Save or create a workspace.
2. Put files into that workspace folder.
3. Open the web UI.
4. Enter a goal and start a session.
5. Watch team feed, agent output, stderr, and prompts live.
6. Send a new goal, an operator instruction, or `1/2/3/custom` input to a specific agent.

## Config

The project config lives in:

```text
./codex-group.config.json
```

This stores:

- server host/port
- default workspace
- workspace presets
- agent presets
- Codex command/model/sandbox settings

## Session output

Each run creates a folder under `runs/<timestamp>-<slug>/` with:

- `session.json`
- `events.jsonl`
- `events.log`
- `agents/<agent>/state.json`
- `agents/<agent>/stdout.log`
- `agents/<agent>/stderr.log`
- `agents/<agent>/input.log`
- `agents/<agent>/protocol.log`

## Notes

- The browser UI is the primary control surface now. The old Tk desktop UI and Python runtime were removed.
- In this sandbox, spawning Codex from inside Node returns `spawn EPERM`, so end-to-end Codex execution could not be verified here. The server, config flow, UI, session creation path, and persistence were verified locally in this workspace.
