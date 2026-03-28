import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function collectTests(rootDir) {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      const stats = statSync(fullPath);
      if (stats.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (entry.endsWith(".test.cjs")) {
        files.push(fullPath);
      }
    }
  };
  visit(rootDir);
  return files.sort();
}

const repoRoot = process.cwd();
const testsDir = resolve(repoRoot, "tests");
const files = collectTests(testsDir);

if (files.length === 0) {
  console.error("No test files found.");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], {
  cwd: repoRoot,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
