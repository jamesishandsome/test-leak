export type LeakKind = "timeout" | "interval" | "immediate" | "server" | "child-process";

export interface LeakResource {
  id: string;
  kind: LeakKind;
  createdAt: string;
  ageMs: number;
  stack?: string;
  detail?: Record<string, unknown>;
  ref?: boolean;
}

export interface LeakSummary {
  total: number;
  byKind: Partial<Record<LeakKind, number>>;
}

export interface LeakSnapshot {
  tool: "test-leak";
  version: 1;
  pid: number;
  ppid: number;
  cwd: string;
  argv: string[];
  createdAt: string;
  updatedAt: string;
  summary: LeakSummary;
  resources: LeakResource[];
}
