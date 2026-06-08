import type { LeakResource, LeakSnapshot } from "./types.js";

function formatDetail(detail: Record<string, unknown> | undefined): string {
  if (!detail || Object.keys(detail).length === 0) return "";
  return Object.entries(detail)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
}

function firstUserStackLine(resource: LeakResource): string | undefined {
  return resource.stack
    ?.split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.includes("node:internal"));
}

export function formatSnapshot(snapshot: LeakSnapshot, options: { maxResources?: number } = {}): string {
  const maxResources = options.maxResources ?? 20;
  const lines: string[] = [];
  const kinds = Object.entries(snapshot.summary.byKind)
    .map(([kind, count]) => `${kind}:${count}`)
    .join(", ");

  lines.push(
    `test-leak found ${snapshot.summary.total} tracked resource${snapshot.summary.total === 1 ? "" : "s"}${kinds ? ` (${kinds})` : ""}.`,
  );

  for (const resource of snapshot.resources.slice(0, maxResources)) {
    const refText = resource.ref === undefined ? "" : resource.ref ? " ref" : " unref";
    const detailText = formatDetail(resource.detail);
    lines.push(
      `- ${resource.kind} ${resource.id} age=${resource.ageMs}ms${refText}${detailText ? ` ${detailText}` : ""}`,
    );
    const stackLine = firstUserStackLine(resource);
    if (stackLine) lines.push(`  at ${stackLine.replace(/^at\s+/, "")}`);
  }

  if (snapshot.resources.length > maxResources) {
    lines.push(`... ${snapshot.resources.length - maxResources} more resource(s) omitted.`);
  }

  return lines.join("\n");
}
