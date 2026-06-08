import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registerPath = path.join(root, "dist", "register.js");
const cliPath = path.join(root, "dist", "cli.js");

function tempReport(name) {
  return path.join(os.tmpdir(), "test-leak-tests", `${name}-${process.pid}-${Date.now()}.json`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForClose(child) {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
}

function spawnNode(args, options = {}) {
  return spawn(process.execPath, args, {
    windowsHide: true,
    ...options,
  });
}

test("register writes a snapshot containing leaked intervals", async () => {
  const reportFile = tempReport("register");
  const child = spawnNode([
    "--import",
    pathToFileURL(registerPath).href,
    "-e",
    "setInterval(() => {}, 1000); setTimeout(() => {}, 10000);",
  ], {
    env: {
      ...process.env,
      TEST_LEAK_REPORT_FILE: reportFile,
      TEST_LEAK_POLL_INTERVAL_MS: "100",
    },
    stdio: "ignore",
  });

  const closed = waitForClose(child);
  await delay(450);
  child.kill("SIGTERM");
  await closed;

  const snapshot = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  assert.equal(snapshot.tool, "test-leak");
  assert.ok(snapshot.resources.some((resource) => resource.kind === "interval"));
});

test("CLI returns 124 and prints a leak report when a test command hangs", async () => {
  const child = spawnNode([
    cliPath,
    "--timeout",
    "700ms",
    "--no-shell",
    "--",
    process.execPath,
    "-e",
    "setInterval(() => {}, 1000);",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const result = await waitForClose(child);
  assert.equal(result.code, 124);
  assert.match(stderr, /Possible test leak detected/);
  assert.match(stderr, /interval/);
});

test("CLI exits zero for a clean command", async () => {
  const child = spawnNode([
    cliPath,
    "--timeout",
    "3s",
    "--no-shell",
    "--",
    process.execPath,
    "-e",
    "setTimeout(() => {}, 10);",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const result = await waitForClose(child);
  assert.equal(result.code, 0);
});
