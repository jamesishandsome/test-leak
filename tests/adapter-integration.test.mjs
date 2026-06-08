import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vitestBin = path.join(root, "node_modules", "vitest", "vitest.mjs");
const jestBin = path.join(root, "node_modules", "jest", "bin", "jest.js");
const vitestAdapter = path.join(root, "dist", "vitest.js").replace(/\\/g, "/");
const jestAdapter = path.join(root, "dist", "jest.cjs").replace(/\\/g, "/");
const adapterModuleUrl = pathToFileURL(path.join(root, "dist", "adapter.js")).href;

function makeFixture(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `test-leak-${name}-`));
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

function runNode(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      ...options,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const hardTimeout = setTimeout(() => {
      reject(new Error(`Command did not exit after timeout cleanup: node ${args.join(" ")}`));
    }, 35_000);
    hardTimeout.unref();

    const timeout = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
    }, 30_000);
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
      clearTimeout(hardTimeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(hardTimeout);
      const output = `${stdout}\n${stderr}`;
      if (timedOut) {
        reject(new Error(`Command timed out: node ${args.join(" ")}\n${output}`));
        return;
      }
      resolve({ code, signal, stdout, stderr, output });
    });
  });
}

function writeVitestFixture(name, body) {
  const dir = makeFixture(`vitest-${name}`);
  fs.writeFileSync(
    path.join(dir, "vitest.config.mjs"),
    `export default { test: { setupFiles: [${JSON.stringify(vitestAdapter)}], include: ["**/*.test.mjs"], pool: "forks" } };\n`,
    "utf8",
  );
  fs.writeFileSync(path.join(dir, `${name}.test.mjs`), body, "utf8");
  return dir;
}

function writeJestFixture(name, body) {
  const dir = makeFixture(`jest-${name}`);
  fs.writeFileSync(
    path.join(dir, "jest.config.cjs"),
    `module.exports = {\n  testEnvironment: "node",\n  setupFilesAfterEnv: [${JSON.stringify(jestAdapter)}],\n  testMatch: ["<rootDir>/*.test.cjs"],\n};\n`,
    "utf8",
  );
  fs.writeFileSync(path.join(dir, `${name}.test.cjs`), body, "utf8");
  return dir;
}

function runVitest(dir, env = {}) {
  return runNode([vitestBin, "run", "--config", path.join(dir, "vitest.config.mjs")], {
    cwd: dir,
    env: { ...process.env, ...env },
  });
}

function runJest(dir, env = {}) {
  return runNode([jestBin, "--config", path.join(dir, "jest.config.cjs"), "--runInBand"], {
    cwd: dir,
    env: { ...process.env, ...env },
  });
}

test("generic adapter failOnLeak=false logs and cleans leaked intervals", { timeout: 40_000 }, async () => {
  const script = `
const { assertNoTestLeaks } = await import(${JSON.stringify(adapterModuleUrl)});
const logs = [];
console.error = (message) => logs.push(String(message));
setInterval(() => {}, 1000);
const snapshot = assertNoTestLeaks({ runner: "Direct", failOnLeak: false });
if (snapshot.summary.total !== 1) {
  console.error("expected one leak, got " + snapshot.summary.total);
  process.exit(2);
}
if (!logs.join("\\n").includes("test-leak: Direct finished with leaked resources")) {
  console.error("missing leak log");
  process.exit(3);
}
`;

  const result = await runNode(["--input-type=module", "-e", script], { cwd: root });
  assert.equal(result.code, 0, result.output);
});

test("Vitest adapter passes clean tests", { timeout: 40_000 }, async () => {
  const dir = writeVitestFixture(
    "clean",
    `import { test, expect } from "vitest";\n\ntest("clean", () => {\n  const timer = setTimeout(() => {}, 1);\n  clearTimeout(timer);\n  expect(1).toBe(1);\n});\n`,
  );

  const result = await runVitest(dir);
  assert.equal(result.code, 0, result.output);
  assert.doesNotMatch(result.output, /finished with leaked resources/);
});

test("Vitest adapter fails and reports leaked intervals", { timeout: 40_000 }, async () => {
  const dir = writeVitestFixture(
    "leak",
    `import { test, expect } from "vitest";\n\ntest("leaks", () => {\n  setInterval(() => {}, 1000);\n  expect(1).toBe(1);\n});\n`,
  );

  const result = await runVitest(dir);
  assert.notEqual(result.code, 0, result.output);
  assert.match(result.output, /test-leak: Vitest finished with leaked resources/);
  assert.match(result.output, /interval/);
});

test("Vitest adapter can clean leaked intervals without failing when fail mode is disabled", { timeout: 40_000 }, async () => {
  const dir = writeVitestFixture(
    "log-only",
    `import { test, expect } from "vitest";\n\ntest("logs leak without failing", () => {\n  setInterval(() => {}, 1000);\n  expect(1).toBe(1);\n});\n`,
  );

  const result = await runVitest(dir, { TEST_LEAK_ADAPTER_FAIL: "false" });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /1 passed/);
  assert.doesNotMatch(result.output, /Test Files\s+1 failed/);
});

test("Jest adapter passes clean tests", { timeout: 40_000 }, async () => {
  const dir = writeJestFixture(
    "clean",
    `test("clean", () => {\n  const timer = setTimeout(() => {}, 1);\n  clearTimeout(timer);\n  expect(1).toBe(1);\n});\n`,
  );

  const result = await runJest(dir);
  assert.equal(result.code, 0, result.output);
  assert.doesNotMatch(result.output, /finished with leaked resources/);
});

test("Jest adapter fails and reports leaked intervals", { timeout: 40_000 }, async () => {
  const dir = writeJestFixture(
    "leak",
    `test("leaks", () => {\n  setInterval(() => {}, 1000);\n  expect(1).toBe(1);\n});\n`,
  );

  const result = await runJest(dir);
  assert.notEqual(result.code, 0, result.output);
  assert.match(result.output, /test-leak: Jest finished with leaked resources/);
  assert.match(result.output, /interval/);
});

test("Jest adapter can log leaked intervals without failing", { timeout: 40_000 }, async () => {
  const dir = writeJestFixture(
    "log-only",
    `test("logs leak without failing", () => {\n  setInterval(() => {}, 1000);\n  expect(1).toBe(1);\n});\n`,
  );

  const result = await runJest(dir, { TEST_LEAK_ADAPTER_FAIL: "false" });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /test-leak: Jest finished with leaked resources/);
  assert.match(result.output, /interval/);
});
