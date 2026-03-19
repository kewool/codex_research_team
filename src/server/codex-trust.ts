// @ts-nocheck
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

function codexConfigPath(): string {
  return join(homedir(), ".codex", "config.toml");
}

function literalProjectHeader(targetPath: string): string {
  return `[projects.'${targetPath.replace(/'/g, "''")}']`;
}

function basicProjectHeader(targetPath: string): string {
  return `[projects."${targetPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
}

function isSectionHeader(line: string): boolean {
  return /^\[[^\]]+\]\s*$/.test(line.trim());
}

export function ensureCodexWorkspaceTrust(targetPath: string): void {
  const resolvedPath = resolve(targetPath);
  const configPath = codexConfigPath();
  mkdirSync(dirname(configPath), { recursive: true });

  const raw = existsSync(configPath) ? readFileSync(configPath, "utf8").replace(/^\ufeff/, "") : "";
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const literalHeader = literalProjectHeader(resolvedPath);
  const basicHeader = basicProjectHeader(resolvedPath);
  const headerIndex = lines.findIndex((line) => {
    const trimmed = line.trim();
    return trimmed === literalHeader || trimmed === basicHeader;
  });

  if (headerIndex === -1) {
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
      lines.pop();
    }
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(literalHeader);
    lines.push('trust_level = "trusted"');
    lines.push("");
  } else {
    let sectionEnd = headerIndex + 1;
    while (sectionEnd < lines.length && !isSectionHeader(lines[sectionEnd])) {
      sectionEnd += 1;
    }
    const trustIndex = lines.findIndex((line, index) => index > headerIndex && index < sectionEnd && /^\s*trust_level\s*=/.test(line));
    if (trustIndex >= 0) {
      lines[trustIndex] = 'trust_level = "trusted"';
    } else {
      lines.splice(headerIndex + 1, 0, 'trust_level = "trusted"');
    }
  }

  writeFileSync(configPath, `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`, "utf8");
}
