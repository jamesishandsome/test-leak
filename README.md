# test-leak

Detect hanging test leaks before they waste CI minutes.

`test-leak` is a tiny JS/TS developer-experience CLI that runs your test command with a lightweight Node.js probe. When the command hangs, it prints the resources that are still alive: timers, intervals, open servers, and child processes launched through `child_process.spawn()`.

```bash
npx test-leak -- npm test
npx test-leak --timeout 10s -- vitest run
npx test-leak --timeout 5s -- node --test
```

## Why this exists

Most test runners can tell you that a suite did not exit. They do not always make it obvious which new timer, server, process, or open handle caused the hang.

`test-leak` is designed for PR/CI workflows:

- fail fast when a test command hangs
- show actionable leak evidence instead of a generic timeout
- work as a wrapper around existing test commands
- stay small enough to add to old projects without a migration

## MVP status

This repository is in early MVP development. The first version tracks resources created after the probe is injected:

- `setTimeout`
- `setInterval`
- `setImmediate`
- `net.Server.listen()` / `server.close()`
- `child_process.spawn()` from CommonJS or ESM named imports

Vitest and Jest setup adapters are included so leaks can fail at test-file teardown instead of only after the outer CLI timeout.

## Usage

```bash
test-leak [options] -- <test command>
```

Examples:

```bash
# Wrap your existing package script
test-leak -- npm test

# Vitest
test-leak --timeout 15s -- vitest run

# Node's built-in test runner
test-leak --timeout 5s -- node --test

# Write machine-readable output
test-leak --json .test-leak/report.json -- npm test
```

## Vitest adapter

Add `test-leak/vitest` to `setupFiles`:

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["test-leak/vitest"],
  },
});
```

Then run Vitest normally, or wrap it with the CLI for an outer hang timeout:

```bash
vitest run
test-leak --timeout 15s -- vitest run
```

## Jest adapter

Add `test-leak/jest` to `setupFilesAfterEnv`:

```js
// jest.config.cjs
module.exports = {
  testEnvironment: "node",
  setupFilesAfterEnv: ["test-leak/jest"],
};
```

Then run Jest normally, or wrap it with the CLI for an outer hang timeout:

```bash
jest --runInBand
test-leak --timeout 15s -- jest --runInBand
```

The adapters install an `afterAll` check. If a test file leaves tracked resources alive, the adapter:

1. prints a `test-leak` resource report,
2. clears the leaked timers/servers/processes best-effort so the runner can exit,
3. fails the test file.

Adapter environment options:

| Env var | Description |
| --- | --- |
| `TEST_LEAK_ADAPTER_MIN_AGE_MS` | Ignore resources younger than this age. |
| `TEST_LEAK_ADAPTER_CLEANUP` | Set to `false` to report without cleanup. Default: `true`. |
| `TEST_LEAK_ADAPTER_FAIL` | Set to `false` to log instead of throwing. Default: `true`. |
| `TEST_LEAK_ADAPTER_MAX_RESOURCES` | Max resources shown in adapter output. Default: `20`. |

## Options

| Option | Description |
| --- | --- |
| `--timeout <duration>` | Max time before treating the command as hung. Default: `30s`. Use `0` to disable. |
| `--poll-interval <duration>` | How often the injected probe writes resource snapshots. Default: `250ms`. |
| `--min-age <duration>` | Ignore resources younger than this age. Default: `0ms`. |
| `--json <file>` | Write the final leak snapshot JSON to a file. |
| `--no-inject` | Do not inject the probe with `NODE_OPTIONS`. |
| `--shell` / `--no-shell` | Control whether the command runs through a shell. Windows defaults to `--shell` so `npm test` works. Use `--no-shell` when you need literal argument handling. |
| `-q, --quiet` | Only print failures. |

Durations support `ms`, `s`, and `m`, for example `500ms`, `10s`, and `1m`.

## How it works

The CLI sets:

```bash
NODE_OPTIONS="--import=<test-leak/register>"
```

That import installs runtime probes inside the Node.js test process and periodically writes a JSON snapshot. If the wrapped command times out, the parent CLI kills the process tree and prints the latest snapshot.

## Limitations

- It only sees Node.js processes that honor `NODE_OPTIONS`.
- The current MVP tracks common userland leaks, not every native libuv handle.
- It does not yet track `node:timers/promises`, `child_process.exec()`, `execFile()`, `fork()`, `worker_threads`, `fs.watch()`, `dgram` sockets, or arbitrary native-addon handles.
- On Windows the CLI defaults to `--shell` so commands like `npm test` work; process-tree termination uses `taskkill`.
- Shell mode is for package-script convenience, not an arbitrary shell-escaping security boundary. Prefer `--no-shell` for literal untrusted arguments.
- The current MVP tracks `child_process.spawn()`; broader process and native-handle coverage is future work.
- If a test runner starts isolated workers that strip `NODE_OPTIONS`, those workers need explicit setup in a future adapter.
- Adapter cleanup is best-effort. It is meant to let the runner exit after reporting; do not rely on it as application cleanup.

## Development

```bash
npm install
npm run verify
```

## Name rationale

The package is named `test-leak` because it is short, CLI-friendly, and matches the highest-intent search terms: `test`, `leak`, `open handles`, and `hanging tests`.

## License

MIT
