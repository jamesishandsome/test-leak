#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatSnapshot } from "./format.js";
import { readSnapshot } from "./tracker.js";
import { VERSION } from "./version.js";
import type { LeakSnapshot } from "./types.js";

interface CliOptions {
  timeoutMs: number;
  pollIntervalMs: number;
  minAgeMs: number;
  inject: boolean;
  shell: boolean;
  quiet: boolean;
  jsonFile?: string;
}

interface ParsedCli {
  options: CliOptions;
  command: string[];
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

function usage(): string {
  return `test-leak ${VERSION}

Detect hanging test leaks such as open timers, servers, and child processes.

Usage:
  test-leak [options] -- <test command>
  test-leak run [options] -- <test command>

Examples:
  test-leak -- npm test
  test-leak --timeout 10s -- vitest run
  test-leak --timeout 5s -- node --test

Options:
  --timeout <duration>        Max time before reporting a hanging leak. Default: 30s. Use 0 to disable.
  --poll-interval <duration>  Probe snapshot interval. Default: 250ms.
  --min-age <duration>        Ignore resources younger than this age in snapshots. Default: 0ms.
  --json <file>               Write the final leak snapshot JSON to a file.
  --no-inject                 Do not inject the test-leak probe with NODE_OPTIONS.
  --shell                     Run the command through the platform shell.
  --no-shell                  Run the command directly. Default on non-Windows.
  -q, --quiet                 Only print failures.
  -h, --help                  Show help.
  -v, --version               Show version.
`;
}

function parseDuration(value: string): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/i);
  if (!match) throw new Error(`Invalid duration '${value}'. Use values like 500ms, 10s, or 1m.`);
  const amount = Number.parseFloat(match[1]!);
  const unit = (match[2] ?? "ms").toLowerCase();
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`Invalid duration '${value}'.`);
  if (unit === "m") return Math.round(amount * 60_000);
  if (unit === "s") return Math.round(amount * 1_000);
  return Math.round(amount);
}

function readValue(args: string[], index: number, option: string): [string, number] {
  const current = args[index]!;
  const equalsIndex = current.indexOf("=");
  if (equalsIndex >= 0) return [current.slice(equalsIndex + 1), index];
  const next = args[index + 1];
  if (!next) throw new Error(`Missing value for ${option}.`);
  return [next, index + 1];
}

function parseArgs(argv: string[]): ParsedCli | "help" | "version" {
  const args = [...argv];
  if (args[0] === "run") args.shift();

  const options: CliOptions = {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    minAgeMs: 0,
    inject: true,
    shell: process.platform === "win32",
    quiet: false,
  };

  const separatorIndex = args.indexOf("--");
  const optionArgs = separatorIndex >= 0 ? args.slice(0, separatorIndex) : args;
  const command = separatorIndex >= 0 ? args.slice(separatorIndex + 1) : [];

  for (let index = 0; index < optionArgs.length; index += 1) {
    const arg = optionArgs[index]!;

    if (arg === "-h" || arg === "--help") return "help";
    if (arg === "-v" || arg === "--version") return "version";
    if (arg === "-q" || arg === "--quiet") {
      options.quiet = true;
      continue;
    }
    if (arg === "--no-inject") {
      options.inject = false;
      continue;
    }
    if (arg === "--shell") {
      options.shell = true;
      continue;
    }
    if (arg === "--no-shell") {
      options.shell = false;
      continue;
    }
    if (arg === "--timeout" || arg.startsWith("--timeout=")) {
      const [value, nextIndex] = readValue(optionArgs, index, "--timeout");
      options.timeoutMs = parseDuration(value);
      index = nextIndex;
      continue;
    }
    if (arg === "--poll-interval" || arg.startsWith("--poll-interval=")) {
      const [value, nextIndex] = readValue(optionArgs, index, "--poll-interval");
      options.pollIntervalMs = parseDuration(value);
      index = nextIndex;
      continue;
    }
    if (arg === "--min-age" || arg.startsWith("--min-age=")) {
      const [value, nextIndex] = readValue(optionArgs, index, "--min-age");
      options.minAgeMs = parseDuration(value);
      index = nextIndex;
      continue;
    }
    if (arg === "--json" || arg.startsWith("--json=")) {
      const [value, nextIndex] = readValue(optionArgs, index, "--json");
      options.jsonFile = value;
      index = nextIndex;
      continue;
    }

    throw new Error(`Unknown option '${arg}'. Use --help for usage.`);
  }

  return { options, command };
}

function quoteForShell(value: string): string {
  if (/^[\w./:=@+-]+$/.test(value)) return value;
  return `"${value.replace(/(["\\])/g, "\\$1")}"`;
}

function buildShellCommand(command: string[]): string {
  return command.map(quoteForShell).join(" ");
}

function registerImportOption(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const registerFile = path.join(path.dirname(currentFile), "register.js");
  return `--import=${pathToFileURL(registerFile).href}`;
}

function buildEnvironment(options: CliOptions, reportFile: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.TEST_LEAK_REPORT_FILE = reportFile;
  env.TEST_LEAK_POLL_INTERVAL_MS = String(options.pollIntervalMs);
  env.TEST_LEAK_MIN_AGE_MS = String(options.minAgeMs);

  if (options.inject) {
    env.NODE_OPTIONS = [env.NODE_OPTIONS, registerImportOption()].filter(Boolean).join(" ");
  }

  return env;
}

function writeUserJson(jsonFile: string | undefined, snapshot: LeakSnapshot | null): void {
  if (!jsonFile || !snapshot) return;
  fs.mkdirSync(path.dirname(path.resolve(jsonFile)), { recursive: true });
  fs.writeFileSync(jsonFile, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const taskkill = path.join(systemRoot, "System32", "taskkill.exe");
    const result = spawnSync(taskkill, ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    if (result.error) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone or inaccessible.
      }
    }
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

function runCommand(command: string[], options: CliOptions, reportFile: string): Promise<number> {
  return new Promise((resolve) => {
    const env = buildEnvironment(options, reportFile);
    const child = options.shell
      ? spawn(buildShellCommand(command), {
          env,
          shell: true,
          stdio: "inherit",
          windowsHide: true,
        })
      : spawn(command[0]!, command.slice(1), {
          env,
          shell: false,
          stdio: "inherit",
          detached: process.platform !== "win32",
          windowsHide: true,
        });

    let timedOut = false;
    const timer =
      options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            if (!options.quiet) {
              console.error(`\ntest-leak: command exceeded ${options.timeoutMs}ms; collecting leak snapshot...`);
            }
            if (child.pid) killProcessTree(child.pid);
          }, options.timeoutMs)
        : undefined;
    timer?.unref();

    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      console.error(`test-leak: failed to start command: ${error.message}`);
      resolve(127);
    });

    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      const snapshot = readSnapshot(reportFile);
      writeUserJson(options.jsonFile, snapshot);

      if (timedOut) {
        console.error("\ntest-leak: Possible test leak detected. The test command did not exit cleanly.");
        if (snapshot) console.error(formatSnapshot(snapshot));
        else console.error("No probe snapshot was written. The command may not have been a Node.js process, or NODE_OPTIONS was ignored.");
        resolve(124);
        return;
      }

      const commandExitCode = code ?? (signal ? 1 : 0);
      if (commandExitCode !== 0) {
        resolve(commandExitCode);
        return;
      }

      if (snapshot && snapshot.summary.total > 0) {
        console.error("\ntest-leak: Leaked resources remained when the command exited.");
        console.error(formatSnapshot(snapshot));
        resolve(1);
        return;
      }

      if (!options.quiet) console.error("test-leak: no leaks detected.");
      resolve(0);
    });
  });
}

async function main(): Promise<void> {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed === "help") {
      console.log(usage());
      return;
    }
    if (parsed === "version") {
      console.log(VERSION);
      return;
    }

    if (parsed.command.length === 0) {
      console.error("test-leak: missing command. Use `test-leak -- <test command>`.");
      process.exitCode = 2;
      return;
    }

    const reportFile = path.join(os.tmpdir(), "test-leak", `${process.pid}-${Date.now()}.json`);
    const exitCode = await runCommand(parsed.command, parsed.options, reportFile);
    process.exitCode = exitCode;
  } catch (error) {
    console.error(`test-leak: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

await main();
