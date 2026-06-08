import { afterAll } from "vitest";
import { installAfterAllLeakCheck } from "./adapter.js";
import type { TestLeakAdapterOptions } from "./adapter.js";

export type { TestLeakAdapterOptions } from "./adapter.js";
export { assertNoTestLeaks } from "./adapter.js";

export function installVitestLeakDetector(options: TestLeakAdapterOptions = {}): void {
  installAfterAllLeakCheck(afterAll, { runner: "Vitest", ...options });
}

installVitestLeakDetector();
