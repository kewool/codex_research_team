// @ts-nocheck
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { startWebServer } from "./server/server";
import { AppConfig, AgentPreset } from "./shared/types";
import { DEFAULT_CONFIG_PATH, createDefaultConfig, defaultListenChannels, defaultPublishChannel, emptyAgentPolicy, loadConfig, saveConfig } from "./server/config";
import { slugify } from "./server/utils";

function parseArgs(argv: string[]): { command: string; flags: Map<string, string | boolean> } {
  const [command = "serve", ...rest] = argv;
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith("--")) {
      continue;
    }
    const key = item.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      flags.set(key, true);
      continue;
    }
    flags.set(key, next);
    index += 1;
  }
  return { command, flags };
}

async function runSettingsMenu(configPath: string): Promise<number> {
  const rl = createInterface({ input, output });
  let config = loadConfig(configPath);

  try {
    while (true) {
      output.write(`\n[Settings]\n1. Show summary\n2. Manage workspaces\n3. Manage agents\n4. Set default workspace\n5. Save and exit\n6. Exit without saving\n`);
      const choice = (await rl.question("> ")).trim();
      if (choice === "1") {
        printSummary(config);
      } else if (choice === "2") {
        config = await runWorkspaceEditor(config, rl);
      } else if (choice === "3") {
        config = await runAgentEditor(config, rl);
      } else if (choice === "4") {
        config.workspaces.forEach((workspace, index) => output.write(`${index + 1}. ${workspace.name} -> ${workspace.path}\n`));
        const value = Number((await rl.question("Default workspace number: ")).trim());
        const workspace = config.workspaces[value - 1];
        if (workspace) {
          config.defaults.defaultWorkspaceName = workspace.name;
          output.write(`Default workspace set to ${workspace.name}\n`);
        }
      } else if (choice === "5") {
        saveConfig(config, configPath);
        output.write(`Saved to ${configPath}\n`);
        return 0;
      } else if (choice === "6") {
        return 0;
      }
    }
  } finally {
    rl.close();
  }
}

async function runWorkspaceEditor(config: AppConfig, rl: any): Promise<AppConfig> {
  while (true) {
    output.write(`\n[Workspaces]\n`);
    config.workspaces.forEach((workspace, index) => output.write(`${index + 1}. ${workspace.name} -> ${workspace.path}\n`));
    output.write("a. add   e. edit path   d. delete   b. back\n");
    const choice = (await rl.question("> ")).trim().toLowerCase();
    if (choice === "b") {
      return config;
    }
    if (choice === "a") {
      const name = (await rl.question("Workspace name: ")).trim();
      if (!name) {
        continue;
      }
      const defaultPath = resolve(config.defaults.workspacesDir, slugify(name));
      const path = ((await rl.question(`Path [${defaultPath}]: `)).trim() || defaultPath);
      mkdirSync(path, { recursive: true });
      config.workspaces.push({ name, path });
      if (!config.defaults.defaultWorkspaceName) {
        config.defaults.defaultWorkspaceName = name;
      }
      output.write(`Added ${name}\n`);
    } else if (choice === "e") {
      const index = Number((await rl.question("Workspace number: ")).trim()) - 1;
      const workspace = config.workspaces[index];
      if (!workspace) {
        continue;
      }
      const path = (await rl.question(`New path [${workspace.path}]: `)).trim();
      if (path) {
        workspace.path = resolve(path);
        mkdirSync(workspace.path, { recursive: true });
      }
    } else if (choice === "d") {
      const index = Number((await rl.question("Workspace number: ")).trim()) - 1;
      const workspace = config.workspaces[index];
      if (!workspace) {
        continue;
      }
      config.workspaces.splice(index, 1);
      if (config.defaults.defaultWorkspaceName === workspace.name) {
        config.defaults.defaultWorkspaceName = config.workspaces[0]?.name ?? null;
      }
    }
  }
}

async function runAgentEditor(config: AppConfig, rl: any): Promise<AppConfig> {
  while (true) {
    output.write(`\n[Agents]\n`);
    config.agents.forEach((agent, index) => output.write(`${index + 1}. ${agent.name} (${agent.publishChannel})\n   ${agent.brief}\n`));
    output.write("a. add   e. edit   d. delete   b. back\n");
    const choice = (await rl.question("> ")).trim().toLowerCase();
    if (choice === "b") {
      return config;
    }
    if (choice === "a") {
      const name = (await rl.question("Agent name: ")).trim();
      const brief = (await rl.question("Brief: ")).trim();
      const id = slugify(name).replace(/-/g, "_");
      config.agents.push({
        id,
        name,
        brief: brief || "Operate according to your brief and the selected channels.",
        publishChannel: defaultPublishChannel(config.defaults),
        listenChannels: defaultListenChannels(config.defaults),
        maxTurns: 0,
        model: null,
        policy: emptyAgentPolicy(),
      });
    } else if (choice === "e") {
      const index = Number((await rl.question("Agent number: ")).trim()) - 1;
      const agent = config.agents[index];
      if (!agent) {
        continue;
      }
      const nextName = (await rl.question(`Name [${agent.name}]: `)).trim();
      const nextBrief = (await rl.question(`Brief [${agent.brief}]: `)).trim();
      if (nextName) {
        agent.name = nextName;
        agent.id = slugify(nextName).replace(/-/g, "_");
      }
      if (nextBrief) {
        agent.brief = nextBrief;
      }
    } else if (choice === "d") {
      const index = Number((await rl.question("Agent number: ")).trim()) - 1;
      if (config.agents[index]) {
        config.agents.splice(index, 1);
      }
    }
  }
}

function printSummary(config: AppConfig): void {
  output.write(`\nServer: http://${config.defaults.serverHost}:${config.defaults.serverPort}\n`);
  output.write(`Runs: ${config.defaults.runsDir}\n`);
  output.write(`Workspaces dir: ${config.defaults.workspacesDir}\n`);
  output.write(`Default workspace: ${config.defaults.defaultWorkspaceName ?? "(none)"}\n`);
  output.write(`Agents: ${config.agents.length}\n`);
  config.workspaces.forEach((workspace) => output.write(`- ${workspace.name}: ${workspace.path}\n`));
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const configPath = String(flags.get("config-file") || DEFAULT_CONFIG_PATH);

  if (command === "settings") {
    process.exit(await runSettingsMenu(configPath));
  }

  if (command === "workspace") {
    const rl = createInterface({ input, output });
    try {
      const config = await runWorkspaceEditor(loadConfig(configPath), rl);
      saveConfig(config, configPath);
      process.exit(0);
    } finally {
      rl.close();
    }
  }

  if (command === "init") {
    saveConfig(createDefaultConfig(process.cwd()), configPath);
    output.write(`Initialized ${configPath}\n`);
    process.exit(0);
  }

  if (command !== "serve") {
    output.write("Commands: serve, settings, workspace, init\n");
    process.exit(1);
  }

  const host = typeof flags.get("host") === "string" ? String(flags.get("host")) : undefined;
  const port = typeof flags.get("port") === "string" ? Number(flags.get("port")) : undefined;
  const server = await startWebServer({ configPath, host, port });
  output.write(`codex_team web UI: ${server.url}\n`);
}

void main();
