"use strict";

const net = require("node:net");
const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");

const INSTALL_KEY = Symbol.for("test-leak.jest-cjs.installed");
const state = globalThis;

const originalSetTimeout = globalThis.setTimeout.bind(globalThis);
const originalClearTimeout = globalThis.clearTimeout.bind(globalThis);
const originalSetInterval = globalThis.setInterval.bind(globalThis);
const originalClearInterval = globalThis.clearInterval.bind(globalThis);
const originalSetImmediate = globalThis.setImmediate.bind(globalThis);
const originalClearImmediate = globalThis.clearImmediate.bind(globalThis);

const resources = new Map();
let nextId = 1;

function parseIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseBooleanEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
  return fallback;
}

function captureStack(skipLines = 2) {
  const stack = new Error().stack;
  return stack ? stack.split("\n").slice(skipLines).join("\n").trim() : undefined;
}

function hasRef(handle) {
  return typeof handle?.hasRef === "function" ? handle.hasRef() : undefined;
}

function asObject(value) {
  return typeof value === "object" && value !== null ? value : undefined;
}

function track(kind, detail, getRef, cleanup) {
  const id = `${kind}-${nextId++}`;
  const createdAtMs = Date.now();
  resources.set(id, {
    id,
    kind,
    createdAtMs,
    createdAt: new Date(createdAtMs).toISOString(),
    detail,
    getRef,
    cleanup,
    stack: captureStack(3),
  });
  return id;
}

function untrack(id) {
  if (id) resources.delete(id);
}

function installPatches() {
  if (state[INSTALL_KEY]) return;
  state[INSTALL_KEY] = true;

  const timers = require("node:timers");
  const timeoutIds = new WeakMap();
  const intervalIds = new WeakMap();
  const immediateIds = new WeakMap();

  globalThis.setTimeout = function patchedSetTimeout(handler, delay, ...args) {
    let resourceId;
    const wrapped =
      typeof handler === "function"
        ? (...callbackArgs) => {
            try {
              return handler(...callbackArgs);
            } finally {
              untrack(resourceId);
            }
          }
        : handler;
    const handle = originalSetTimeout(wrapped, delay, ...args);
    resourceId = track("timeout", { delayMs: delay ?? 0 }, () => hasRef(handle), () => originalClearTimeout(handle));
    const key = asObject(handle);
    if (key) timeoutIds.set(key, resourceId);
    return handle;
  };

  globalThis.clearTimeout = function patchedClearTimeout(handle) {
    const key = asObject(handle);
    if (key) untrack(timeoutIds.get(key));
    return originalClearTimeout(handle);
  };

  globalThis.setInterval = function patchedSetInterval(handler, delay, ...args) {
    const handle = originalSetInterval(handler, delay, ...args);
    const resourceId = track("interval", { delayMs: delay ?? 0 }, () => hasRef(handle), () => originalClearInterval(handle));
    const key = asObject(handle);
    if (key) intervalIds.set(key, resourceId);
    return handle;
  };

  globalThis.clearInterval = function patchedClearInterval(handle) {
    const key = asObject(handle);
    if (key) untrack(intervalIds.get(key));
    return originalClearInterval(handle);
  };

  globalThis.setImmediate = function patchedSetImmediate(handler, ...args) {
    let resourceId;
    const wrapped =
      typeof handler === "function"
        ? (...callbackArgs) => {
            try {
              return handler(...callbackArgs);
            } finally {
              untrack(resourceId);
            }
          }
        : handler;
    const handle = originalSetImmediate(wrapped, ...args);
    resourceId = track("immediate", undefined, () => hasRef(handle), () => originalClearImmediate(handle));
    const key = asObject(handle);
    if (key) immediateIds.set(key, resourceId);
    return handle;
  };

  globalThis.clearImmediate = function patchedClearImmediate(handle) {
    const key = asObject(handle);
    if (key) untrack(immediateIds.get(key));
    return originalClearImmediate(handle);
  };

  timers.setTimeout = globalThis.setTimeout;
  timers.clearTimeout = globalThis.clearTimeout;
  timers.setInterval = globalThis.setInterval;
  timers.clearInterval = globalThis.clearInterval;
  timers.setImmediate = globalThis.setImmediate;
  timers.clearImmediate = globalThis.clearImmediate;
  syncBuiltinESMExports();

  const serverIds = new WeakMap();
  const originalListen = net.Server.prototype.listen;
  net.Server.prototype.listen = function patchedListen(...args) {
    let resourceId = serverIds.get(this);
    if (!resourceId) {
      const listenArgs = args
        .filter((arg) => typeof arg !== "function")
        .map((arg) => {
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        })
        .join(" ");
      resourceId = track("server", { listen: listenArgs }, () => true, () => {
        if (this.listening) this.close();
      });
      serverIds.set(this, resourceId);
      this.once("close", () => untrack(resourceId));
    }
    try {
      return originalListen.apply(this, args);
    } catch (error) {
      untrack(resourceId);
      serverIds.delete(this);
      throw error;
    }
  };

  const originalSpawn = childProcess.spawn;
  childProcess.spawn = function patchedSpawn(...args) {
    const child = originalSpawn.apply(this, args);
    const command = typeof args[0] === "string" ? args[0] : "unknown";
    const spawnArgs = Array.isArray(args[1]) ? args[1].join(" ") : "";
    const resourceId = track("child-process", { command, args: spawnArgs, pid: child.pid }, () => true, () => child.kill?.());
    child.once("exit", () => untrack(resourceId));
    child.once("close", () => untrack(resourceId));
    return child;
  };

  syncBuiltinESMExports();
}

function snapshot(minAgeMs = 0) {
  const now = Date.now();
  const leaked = [];
  for (const resource of resources.values()) {
    const ageMs = now - resource.createdAtMs;
    if (ageMs < minAgeMs) continue;
    leaked.push({
      id: resource.id,
      kind: resource.kind,
      createdAt: resource.createdAt,
      ageMs,
      stack: resource.stack,
      detail: resource.detail,
      ref: resource.getRef?.(),
    });
  }
  leaked.sort((a, b) => b.ageMs - a.ageMs || a.id.localeCompare(b.id));
  const byKind = {};
  for (const resource of leaked) byKind[resource.kind] = (byKind[resource.kind] ?? 0) + 1;
  return {
    tool: "test-leak",
    version: 1,
    pid: process.pid,
    ppid: process.ppid,
    cwd: process.cwd(),
    argv: process.argv,
    createdAt: new Date().toISOString(),
    updatedAt: new Date(now).toISOString(),
    summary: { total: leaked.length, byKind },
    resources: leaked,
  };
}

function formatDetail(detail) {
  if (!detail || Object.keys(detail).length === 0) return "";
  return Object.entries(detail)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
}

function firstUserStackLine(resource) {
  return resource.stack
    ?.split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.includes("node:internal"));
}

function formatSnapshot(leakSnapshot, maxResources) {
  const kinds = Object.entries(leakSnapshot.summary.byKind)
    .map(([kind, count]) => `${kind}:${count}`)
    .join(", ");
  const lines = [
    `test-leak found ${leakSnapshot.summary.total} tracked resource${leakSnapshot.summary.total === 1 ? "" : "s"}${kinds ? ` (${kinds})` : ""}.`,
  ];
  for (const resource of leakSnapshot.resources.slice(0, maxResources)) {
    const refText = resource.ref === undefined ? "" : resource.ref ? " ref" : " unref";
    const detailText = formatDetail(resource.detail);
    lines.push(`- ${resource.kind} ${resource.id} age=${resource.ageMs}ms${refText}${detailText ? ` ${detailText}` : ""}`);
    const stackLine = firstUserStackLine(resource);
    if (stackLine) lines.push(`  at ${stackLine.replace(/^at\s+/, "")}`);
  }
  return lines.join("\n");
}

function cleanup(ids) {
  for (const id of ids) {
    const resource = resources.get(id);
    if (!resource) continue;
    try {
      resource.cleanup?.();
    } catch {
      // Best-effort cleanup only.
    } finally {
      resources.delete(id);
    }
  }
}

function assertNoTestLeaks(options = {}) {
  const minAgeMs = options.minAgeMs ?? parseIntegerEnv("TEST_LEAK_ADAPTER_MIN_AGE_MS", 0);
  const maxResources = options.maxResources ?? parseIntegerEnv("TEST_LEAK_ADAPTER_MAX_RESOURCES", 20);
  const shouldCleanup = options.cleanup ?? parseBooleanEnv("TEST_LEAK_ADAPTER_CLEANUP", true);
  const shouldFail = options.failOnLeak ?? parseBooleanEnv("TEST_LEAK_ADAPTER_FAIL", true);
  const runner = options.runner ?? "Jest";
  const leakSnapshot = snapshot(minAgeMs);
  if (leakSnapshot.summary.total === 0) return leakSnapshot;

  const message = [
    `test-leak: ${runner} finished with leaked resources.`,
    formatSnapshot(leakSnapshot, maxResources),
  ].join("\n");

  options.onLeak?.(leakSnapshot, message);
  if (shouldCleanup) cleanup(leakSnapshot.resources.map((resource) => resource.id));
  if (shouldFail) throw new Error(message);
  process.stderr.write(`${message}\n`);
  return leakSnapshot;
}

function installAfterAllLeakCheck(afterAllHook, options = {}) {
  afterAllHook(() => {
    assertNoTestLeaks(options);
  });
}

function installJestLeakDetector(options = {}) {
  if (typeof globalThis.afterAll !== "function") {
    throw new Error("test-leak: Jest afterAll is not available. Add test-leak/jest to setupFilesAfterEnv.");
  }

  installAfterAllLeakCheck(globalThis.afterAll, { runner: "Jest", ...options });
}

installPatches();

module.exports = {
  assertNoTestLeaks,
  installAfterAllLeakCheck,
  installJestLeakDetector,
};

installJestLeakDetector();
