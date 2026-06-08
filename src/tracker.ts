import fs from "node:fs";
import path from "node:path";
import type { LeakKind, LeakResource, LeakSnapshot, LeakSummary } from "./types.js";

interface InternalResource {
  id: string;
  kind: LeakKind;
  createdAtMs: number;
  createdAt: string;
  stack?: string;
  detail?: Record<string, unknown>;
  getRef?: () => boolean | undefined;
  cleanup?: () => void;
}

const startedAt = new Date();
let nextId = 1;
const resources = new Map<string, InternalResource>();

function makeId(kind: LeakKind): string {
  return `${kind}-${nextId++}`;
}

export function captureStack(skipLines = 2): string | undefined {
  const stack = new Error().stack;
  if (!stack) return undefined;
  return stack.split("\n").slice(skipLines).join("\n").trim();
}

export function trackResource(
  kind: LeakKind,
  detail?: Record<string, unknown>,
  getRef?: () => boolean | undefined,
  stack = captureStack(3),
  cleanup?: () => void,
): string {
  const id = makeId(kind);
  const createdAtMs = Date.now();
  resources.set(id, {
    id,
    kind,
    createdAtMs,
    createdAt: new Date(createdAtMs).toISOString(),
    stack,
    detail,
    getRef,
    cleanup,
  });
  return id;
}

export function untrackResource(id: string | undefined): void {
  if (!id) return;
  resources.delete(id);
}

export function getSnapshot(minAgeMs = 0): LeakSnapshot {
  const now = Date.now();
  const leakResources: LeakResource[] = [];

  for (const resource of resources.values()) {
    const ageMs = now - resource.createdAtMs;
    if (ageMs < minAgeMs) continue;

    leakResources.push({
      id: resource.id,
      kind: resource.kind,
      createdAt: resource.createdAt,
      ageMs,
      stack: resource.stack,
      detail: resource.detail,
      ref: resource.getRef?.(),
    });
  }

  leakResources.sort((a, b) => b.ageMs - a.ageMs || a.id.localeCompare(b.id));

  const summary: LeakSummary = { total: leakResources.length, byKind: {} };
  for (const resource of leakResources) {
    summary.byKind[resource.kind] = (summary.byKind[resource.kind] ?? 0) + 1;
  }

  return {
    tool: "test-leak",
    version: 1,
    pid: process.pid,
    ppid: process.ppid,
    cwd: process.cwd(),
    argv: process.argv,
    createdAt: startedAt.toISOString(),
    updatedAt: new Date(now).toISOString(),
    summary,
    resources: leakResources,
  };
}

export function writeSnapshot(filePath: string, minAgeMs = 0): LeakSnapshot {
  const snapshot = getSnapshot(minAgeMs);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return snapshot;
}

export function readSnapshot(filePath: string): LeakSnapshot | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as LeakSnapshot;
  } catch {
    return null;
  }
}

export function cleanupResources(ids?: Iterable<string>): void {
  const targetIds = ids ? [...ids] : [...resources.keys()];

  for (const id of targetIds) {
    const resource = resources.get(id);
    if (!resource) continue;

    try {
      resource.cleanup?.();
    } catch {
      // Cleanup is best-effort: the diagnostic should still be reported.
    } finally {
      resources.delete(id);
    }
  }
}
