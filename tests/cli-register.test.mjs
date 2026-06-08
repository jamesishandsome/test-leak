import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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

function killProcessTree(pid) {
  if (!pid) return;

  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const taskkill = path.join(systemRoot, "System32", "taskkill.exe");
    const result = spawnSync(taskkill, ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    if (!result.error) return;
  }

  try {
    process.kill(process.platform === "win32" ? pid : -pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone or inaccessible.
    }
  }
}

function waitForClose(child, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      killProcessTree(child.pid);
      reject(new Error(`Process did not close within ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref();

    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

function spawnNode(args, options = {}) {
  return spawn(process.execPath, args, {
    windowsHide: true,
    ...options,
  });
}

function runCli(args, { timeoutMs = 10_000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnNode([cliPath, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      killProcessTree(child.pid);
      reject(new Error(`CLI did not close within ${timeoutMs}ms\n${stdout}\n${stderr}`));
    }, timeoutMs);
    timeout.unref();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr, output: `${stdout}\n${stderr}` });
    });
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

test("register tracks timers started from ESM named node:timers imports", async () => {
  const reportFile = tempReport("esm-timers");
  const script = `
import { setInterval } from "node:timers";
setInterval(() => {}, 1000);
`;
  const child = spawnNode([
    "--import",
    pathToFileURL(registerPath).href,
    "--input-type=module",
    "-e",
    script,
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
  assert.ok(
    snapshot.resources.some((resource) => resource.kind === "interval"),
    JSON.stringify(snapshot, null, 2),
  );
});

test("register tracks child processes started from ESM named spawn imports", async () => {
  const reportFile = tempReport("esm-spawn");
  const script = `
import { spawn } from "node:child_process";
spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
setInterval(() => {}, 1000);
`;
  const child = spawnNode([
    "--import",
    pathToFileURL(registerPath).href,
    "--input-type=module",
    "-e",
    script,
  ], {
    env: {
      ...process.env,
      TEST_LEAK_REPORT_FILE: reportFile,
      TEST_LEAK_POLL_INTERVAL_MS: "100",
    },
    stdio: "ignore",
    detached: process.platform !== "win32",
  });

  const closed = waitForClose(child);
  await delay(450);
  killProcessTree(child.pid);
  await closed;

  const snapshot = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  assert.ok(
    snapshot.resources.some((resource) => resource.kind === "child-process"),
    JSON.stringify(snapshot, null, 2),
  );
});

test("CLI returns 124 and prints a leak report when a test command hangs", async () => {
  const result = await runCli([
    "--timeout",
    "700ms",
    "--no-shell",
    "--",
    process.execPath,
    "-e",
    "setInterval(() => {}, 1000);",
  ]);

  assert.equal(result.code, 124);
  assert.match(result.stderr, /Possible test leak detected/);
  assert.match(result.stderr, /interval/);
});

test("CLI exits zero for a clean command", async () => {
  const result = await runCli([
    "--timeout",
    "3s",
    "--no-shell",
    "--",
    process.execPath,
    "-e",
    "setTimeout(() => {}, 10);",
  ]);

  assert.equal(result.code, 0);
});

test("CLI shell mode preserves shell metacharacter arguments", async () => {
  const marker = 'literal " quote & value | <tag> %PATH%';
  const script = `
if (process.argv[1] !== ${JSON.stringify(marker)}) {
  console.error(JSON.stringify(process.argv));
  process.exit(7);
}
`;

  const result = await runCli([
    "--timeout",
    "3s",
    "--shell",
    "--",
    process.execPath,
    "-e",
    script,
    marker,
  ]);

  assert.equal(result.code, 0, result.output);
});

test("CLI timeout force-exits a process that ignores SIGTERM", { skip: process.platform === "win32" }, async () => {
  const startedAt = Date.now();
  const result = await runCli([
    "--timeout",
    "300ms",
    "--no-shell",
    "--",
    process.execPath,
    "-e",
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
  ], { timeoutMs: 6_000 });

  assert.equal(result.code, 124, result.output);
  assert.ok(Date.now() - startedAt < 5_000, result.output);
});
