import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const args = process.argv.slice(2);
const candidates = [
  "C:/Program Files/nodejs/node_modules/@nestjs/cli/node_modules/typescript/lib/tsc.js",
  "C:/Program Files/nodejs/node_modules/eas-cli/node_modules/typescript/lib/tsc.js",
  "C:/Program Files/nodejs/node_modules/firebase-tools/node_modules/typescript/lib/tsc.js",
];

const compiler = candidates.find((candidate) => existsSync(candidate));
if (!compiler) {
  console.error("Unable to locate a TypeScript compiler. Install typescript or update scripts/run-tsc.mjs.");
  process.exit(1);
}

const result = spawnSync(process.execPath, [compiler, "-p", join(process.cwd(), "tsconfig.json"), ...args], {
  stdio: "inherit",
});

process.exit(result.status ?? 1);
