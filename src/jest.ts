import { installGlobalAfterAllLeakCheck } from "./adapter.js";
import type { TestLeakAdapterOptions } from "./adapter.js";

export type { TestLeakAdapterOptions } from "./adapter.js";
export { assertNoTestLeaks } from "./adapter.js";

export function installJestLeakDetector(options: TestLeakAdapterOptions = {}): void {
  installGlobalAfterAllLeakCheck({ runner: "Jest", ...options });
}

installJestLeakDetector();
