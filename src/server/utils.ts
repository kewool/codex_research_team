// @ts-nocheck
import { mkdirSync, appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

export function ensureParent(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

export function writeJson(filePath: string, value: unknown): void {
  ensureParent(filePath);
  writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

export function readJson<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) {
    return fallback;
  }
  try {
    const raw = readFileSync(filePath, "utf8").replace(/^\ufeff/, "");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function appendLine(filePath: string, line: string): void {
  ensureParent(filePath);
  appendFileSync(filePath, `${line}\n`, "utf8");
}

export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-") || "session";
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function timestampSlug(date = new Date()): string {
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function tailText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}

export function projectPath(...parts: string[]): string {
  return join(process.cwd(), ...parts);
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}
