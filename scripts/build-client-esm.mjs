import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const compilerCandidates = [
  "C:/Program Files/nodejs/node_modules/@nestjs/cli/node_modules/typescript/lib/typescript.js",
  "C:/Program Files/nodejs/node_modules/eas-cli/node_modules/typescript/lib/typescript.js",
  "C:/Program Files/nodejs/node_modules/firebase-tools/node_modules/typescript/lib/typescript.js",
];

const compilerPath = compilerCandidates.find((candidate) => {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
});

if (!compilerPath) {
  console.error("Unable to locate a TypeScript runtime. Install typescript or update scripts/build-client-esm.mjs.");
  process.exit(1);
}

const tsModule = await import(pathToFileURL(compilerPath).href);
const ts = tsModule.default ?? tsModule;
const sourceRoot = resolve(process.cwd(), "src", "client");
const outputRoot = resolve(process.cwd(), "public");

function listTsFiles(rootDir) {
  const entries = readdirSync(rootDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTsFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

function rewriteRelativeImports(code) {
  return code
    .split("\n")
    .map((line) =>
      line.replace(/((?:import|export)\s+[^"']*?\sfrom\s+["']|import\s+["']|import\s*?\(\s*["'])(\.[^"']+)(["'])/g, (match, prefix, specifier, suffix) => {
        if (specifier.endsWith(".js") || specifier.endsWith(".json")) {
          return match;
        }
        return `${prefix}${specifier}.js${suffix}`;
      }),
    )
    .join("\n");
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function removeWithRetry(targetPath, options, retries = 12) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      rmSync(targetPath, options);
      return;
    } catch (error) {
      if (attempt === retries || !["ENOTEMPTY", "EPERM", "EBUSY"].includes(error?.code)) {
        throw error;
      }
      sleep(50 * (attempt + 1));
    }
  }
}

removeWithRetry(resolve(outputRoot, "app"), { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
removeWithRetry(resolve(outputRoot, "app.js"), { force: true, maxRetries: 8, retryDelay: 50 });

for (const sourcePath of listTsFiles(sourceRoot)) {
  const relativePath = relative(sourceRoot, sourcePath).replace(/\\/g, "/");
  const outputPath = resolve(outputRoot, relativePath.replace(/\.ts$/, ".js"));
  const sourceText = readFileSync(sourcePath, "utf8");
  const result = ts.transpileModule(sourceText, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      newLine: ts.NewLineKind.LineFeed,
      removeComments: false,
    },
    fileName: sourcePath,
    reportDiagnostics: false,
  });
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, rewriteRelativeImports(result.outputText), "utf8");
}
