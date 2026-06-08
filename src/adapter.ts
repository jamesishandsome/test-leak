import "./register.js";
import { formatSnapshot } from "./format.js";
import { cleanupResources, getSnapshot } from "./tracker.js";
import type { LeakSnapshot } from "./types.js";

export interface TestLeakAdapterOptions {
  /** Ignore resources younger than this age. Defaults to TEST_LEAK_ADAPTER_MIN_AGE_MS or 0. */
  minAgeMs?: number;
  /** Clear leaked timers/servers/processes after reporting so the runner can exit. Defaults to true. */
  cleanup?: boolean;
  /** Throw when leaks are found. Defaults to true. */
  failOnLeak?: boolean;
  /** Maximum resources to print in the error. Defaults to 20. */
  maxResources?: number;
  /** Label used in diagnostics. */
  runner?: string;
  /** Optional hook for custom reporting. */
  onLeak?: (snapshot: LeakSnapshot, message: string) => void;
}

type AfterAllHook = (callback: () => void | Promise<void>) => void;

function parseIntegerEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseBooleanEnv(name: string): boolean | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
  return undefined;
}

function resolveOptions(options: TestLeakAdapterOptions): Required<Pick<TestLeakAdapterOptions, "minAgeMs" | "cleanup" | "failOnLeak" | "maxResources" | "runner">> &
  Pick<TestLeakAdapterOptions, "onLeak"> {
  return {
    minAgeMs: options.minAgeMs ?? parseIntegerEnv("TEST_LEAK_ADAPTER_MIN_AGE_MS") ?? 0,
    cleanup: options.cleanup ?? parseBooleanEnv("TEST_LEAK_ADAPTER_CLEANUP") ?? true,
    failOnLeak: options.failOnLeak ?? parseBooleanEnv("TEST_LEAK_ADAPTER_FAIL") ?? true,
    maxResources: options.maxResources ?? parseIntegerEnv("TEST_LEAK_ADAPTER_MAX_RESOURCES") ?? 20,
    runner: options.runner ?? "test runner",
    onLeak: options.onLeak,
  };
}

export function assertNoTestLeaks(options: TestLeakAdapterOptions = {}): LeakSnapshot {
  const resolved = resolveOptions(options);
  const snapshot = getSnapshot(resolved.minAgeMs);
  if (snapshot.summary.total === 0) return snapshot;

  const message = [
    `test-leak: ${resolved.runner} finished with leaked resources.`,
    formatSnapshot(snapshot, { maxResources: resolved.maxResources }),
  ].join("\n");

  resolved.onLeak?.(snapshot, message);
  if (resolved.cleanup) cleanupResources(snapshot.resources.map((resource) => resource.id));
  if (resolved.failOnLeak) throw new Error(message);

  console.error(message);
  return snapshot;
}

export function installAfterAllLeakCheck(afterAllHook: AfterAllHook, options: TestLeakAdapterOptions = {}): void {
  afterAllHook(() => {
    assertNoTestLeaks(options);
  });
}

export function installGlobalAfterAllLeakCheck(options: TestLeakAdapterOptions = {}): void {
  const afterAllHook = (globalThis as typeof globalThis & { afterAll?: AfterAllHook }).afterAll;
  if (typeof afterAllHook !== "function") {
    throw new Error("test-leak: afterAll is not available. Install the adapter from a test framework setup file.");
  }

  installAfterAllLeakCheck(afterAllHook, options);
}
