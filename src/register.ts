import { createRequire } from "node:module";
import net from "node:net";
import { trackResource, untrackResource, writeSnapshot } from "./tracker.js";

const INSTALL_KEY = Symbol.for("test-leak.register.installed");
const require = createRequire(import.meta.url);

const originalSetTimeout = globalThis.setTimeout.bind(globalThis) as typeof globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout.bind(globalThis) as typeof globalThis.clearTimeout;
const originalSetInterval = globalThis.setInterval.bind(globalThis) as typeof globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval.bind(globalThis) as typeof globalThis.clearInterval;
const originalSetImmediate = globalThis.setImmediate.bind(globalThis) as typeof globalThis.setImmediate;
const originalClearImmediate = globalThis.clearImmediate.bind(globalThis) as typeof globalThis.clearImmediate;

type TimerLike = { hasRef?: () => boolean; unref?: () => unknown };

function asObject(value: unknown): object | undefined {
  return typeof value === "object" && value !== null ? value : undefined;
}

function hasRef(handle: unknown): boolean | undefined {
  const timer = handle as TimerLike | undefined;
  return typeof timer?.hasRef === "function" ? timer.hasRef() : undefined;
}

function parseIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function installTimerPatches(): void {
  const timeoutIds = new WeakMap<object, string>();
  const intervalIds = new WeakMap<object, string>();
  const immediateIds = new WeakMap<object, string>();

  globalThis.setTimeout = ((handler: unknown, delay?: number, ...args: unknown[]) => {
    let resourceId: string | undefined;
    const wrappedHandler =
      typeof handler === "function"
        ? (...callbackArgs: unknown[]) => {
            try {
              return (handler as (...innerArgs: unknown[]) => unknown)(...callbackArgs);
            } finally {
              untrackResource(resourceId);
            }
          }
        : handler;

    const handle = originalSetTimeout(wrappedHandler as never, delay as never, ...(args as never[]));
    resourceId = trackResource(
      "timeout",
      { delayMs: delay ?? 0 },
      () => hasRef(handle),
      undefined,
      () => originalClearTimeout(handle as never),
    );
    const key = asObject(handle);
    if (key) timeoutIds.set(key, resourceId);
    return handle;
  }) as typeof globalThis.setTimeout;

  globalThis.clearTimeout = ((handle: unknown) => {
    const key = asObject(handle);
    if (key) untrackResource(timeoutIds.get(key));
    return originalClearTimeout(handle as never);
  }) as typeof globalThis.clearTimeout;

  globalThis.setInterval = ((handler: unknown, delay?: number, ...args: unknown[]) => {
    const handle = originalSetInterval(handler as never, delay as never, ...(args as never[]));
    const resourceId = trackResource(
      "interval",
      { delayMs: delay ?? 0 },
      () => hasRef(handle),
      undefined,
      () => originalClearInterval(handle as never),
    );
    const key = asObject(handle);
    if (key) intervalIds.set(key, resourceId);
    return handle;
  }) as typeof globalThis.setInterval;

  globalThis.clearInterval = ((handle: unknown) => {
    const key = asObject(handle);
    if (key) untrackResource(intervalIds.get(key));
    return originalClearInterval(handle as never);
  }) as typeof globalThis.clearInterval;

  globalThis.setImmediate = ((handler: unknown, ...args: unknown[]) => {
    let resourceId: string | undefined;
    const wrappedHandler =
      typeof handler === "function"
        ? (...callbackArgs: unknown[]) => {
            try {
              return (handler as (...innerArgs: unknown[]) => unknown)(...callbackArgs);
            } finally {
              untrackResource(resourceId);
            }
          }
        : handler;

    const handle = originalSetImmediate(wrappedHandler as never, ...(args as never[]));
    resourceId = trackResource(
      "immediate",
      undefined,
      () => hasRef(handle),
      undefined,
      () => originalClearImmediate(handle as never),
    );
    const key = asObject(handle);
    if (key) immediateIds.set(key, resourceId);
    return handle;
  }) as typeof globalThis.setImmediate;

  globalThis.clearImmediate = ((handle: unknown) => {
    const key = asObject(handle);
    if (key) untrackResource(immediateIds.get(key));
    return originalClearImmediate(handle as never);
  }) as typeof globalThis.clearImmediate;
}

function installServerPatch(): void {
  const serverIds = new WeakMap<net.Server, string>();
  const proto = net.Server.prototype as unknown as { listen: (this: net.Server, ...args: unknown[]) => net.Server };
  const originalListen = proto.listen;

  proto.listen = function patchedListen(this: net.Server, ...args: unknown[]): net.Server {
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

      resourceId = trackResource(
        "server",
        { listen: listenArgs },
        () => true,
        undefined,
        () => {
          if (this.listening) this.close();
        },
      );
      serverIds.set(this, resourceId);
      this.once("close", () => untrackResource(resourceId));
    }

    try {
      return originalListen.apply(this, args);
    } catch (error) {
      untrackResource(resourceId);
      serverIds.delete(this);
      throw error;
    }
  };
}

function installChildProcessPatch(): void {
  const childProcess = require("node:child_process") as Record<string, unknown>;
  const originalSpawn = childProcess.spawn as
    | ((...args: unknown[]) => { once: Function; pid?: number; kill?: () => unknown })
    | undefined;
  if (typeof originalSpawn !== "function") return;

  childProcess.spawn = function patchedSpawn(this: unknown, ...args: unknown[]) {
    const child = originalSpawn.apply(this, args);
    const command = typeof args[0] === "string" ? args[0] : "unknown";
    const spawnArgs = Array.isArray(args[1]) ? args[1].join(" ") : "";
    const resourceId = trackResource(
      "child-process",
      { command, args: spawnArgs, pid: child.pid },
      () => true,
      undefined,
      () => child.kill?.(),
    );
    child.once("exit", () => untrackResource(resourceId));
    child.once("close", () => untrackResource(resourceId));
    return child;
  };
}

function startReporter(): void {
  const reportFile = process.env.TEST_LEAK_REPORT_FILE;
  if (!reportFile) return;

  const minAgeMs = parseIntegerEnv("TEST_LEAK_MIN_AGE_MS", 0);
  const pollMs = Math.max(parseIntegerEnv("TEST_LEAK_POLL_INTERVAL_MS", 250), 50);

  const safeWrite = () => {
    try {
      writeSnapshot(reportFile, minAgeMs);
    } catch {
      // The reporter must never break the test process.
    }
  };

  safeWrite();
  const reporter = originalSetInterval(safeWrite, pollMs) as TimerLike;
  reporter.unref?.();

  process.on("beforeExit", safeWrite);
  process.on("exit", safeWrite);
  process.on("uncaughtExceptionMonitor", safeWrite);
  process.once("SIGTERM", () => {
    safeWrite();
    process.exit(143);
  });
  process.once("SIGINT", () => {
    safeWrite();
    process.exit(130);
  });
}

function install(): void {
  const state = globalThis as typeof globalThis & { [INSTALL_KEY]?: boolean };
  if (state[INSTALL_KEY]) return;
  state[INSTALL_KEY] = true;

  installTimerPatches();
  installServerPatch();
  installChildProcessPatch();
  startReporter();
}

install();

