import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vitestBin = path.join(root, "node_modules", "vitest", "vitest.mjs");
const jestBin = path.join(root, "node_modules", "jest", "bin", "jest.js");
const vitestAdapter = path.join(root, "dist", "vitest.js").replace(/\\/g, "/");
const jestAdapter = path.join(root, "dist", "jest.cjs").replace(/\\/g, "/");

function makeFixture(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `test-leak-${name}-`));
  return dir;
}

function runNode(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Command timed out: node ${args.join(" ")}`));
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
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr, output: `${stdout}\n${stderr}` });
    });
  });
}

test("Vitest adapter fails and reports leaked intervals", { timeout: 35_000 }, async () => {
  const dir = makeFixture("vitest");
  fs.writeFileSync(
    path.join(dir, "vitest.config.mjs"),
    `export default { test: { setupFiles: [${JSON.stringify(vitestAdapter)}], include: ["**/*.test.mjs"] } };\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(dir, "leak.test.mjs"),
    `import { test, expect } from "vitest";\n\ntest("leaks", () => {\n  setInterval(() => {}, 1000);\n  expect(1).toBe(1);\n});\n`,
    "utf8",
  );

  const result = await runNode([vitestBin, "run", "--config", path.join(dir, "vitest.config.mjs")], { cwd: dir });
  assert.notEqual(result.code, 0);
  assert.match(result.output, /test-leak: Vitest finished with leaked resources/);
  assert.match(result.output, /interval/);
});

test("Jest adapter fails and reports leaked intervals", { timeout: 35_000 }, async () => {
  const dir = makeFixture("jest");
  fs.writeFileSync(
    path.join(dir, "jest.config.cjs"),
    `module.exports = {\n  testEnvironment: "node",\n  setupFilesAfterEnv: [${JSON.stringify(jestAdapter)}],\n  testMatch: ["<rootDir>/*.test.cjs"],\n};\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(dir, "leak.test.cjs"),
    `test("leaks", () => {\n  setInterval(() => {}, 1000);\n  expect(1).toBe(1);\n});\n`,
    "utf8",
  );

  const result = await runNode([jestBin, "--config", path.join(dir, "jest.config.cjs"), "--runInBand"], { cwd: dir });
  assert.notEqual(result.code, 0);
  assert.match(result.output, /test-leak: Jest finished with leaked resources/);
  assert.match(result.output, /interval/);
});
