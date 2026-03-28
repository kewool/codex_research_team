const fs = require("node:fs");
const { spawn } = require("node:child_process");

const childPidFile = process.argv[2];
const parentPidFile = process.argv[3];

fs.writeFileSync(parentPidFile, String(process.pid), "utf8");

const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
  stdio: "ignore",
  windowsHide: true,
});

fs.writeFileSync(childPidFile, String(child.pid), "utf8");
setInterval(() => {}, 1000);
