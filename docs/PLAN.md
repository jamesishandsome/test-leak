# test-leak product plan

## Goal

Build a small npm CLI that detects why JS/TS test commands hang, with actionable evidence for timers, open servers, and child processes.

## Target users

- JS/TS library authors who run CI on every PR
- frontend/backend teams using Vitest, Jest, or Node's built-in test runner
- maintainers of older projects where flaky hangs waste CI time

## Positioning

`test-leak` is not a replacement for a test runner. It is a wrapper and probe that turns "the test suite never exited" into a concrete resource report.

## MVP acceptance criteria

- `test-leak -- <command>` runs an existing test command.
- The CLI injects a Node.js probe with `NODE_OPTIONS=--import`.
- The probe records timers, intervals, immediates, open `net.Server` instances, and spawned child processes.
- If the command exceeds `--timeout`, the CLI exits `124` and prints a readable leak report.
- `test-leak/vitest` can be used from Vitest `setupFiles` and fails a file-level `afterAll` when leaks remain.
- `test-leak/jest` can be used from Jest `setupFilesAfterEnv` and fails a file-level `afterAll` when leaks remain.
- Clean commands exit `0`.
- The CLI can write JSON output for CI artifacts.
- Local verification passes with `npm run verify`.

## V1 roadmap

1. Stabilize the probe and CLI contract.
2. Add `node:test` recipe or adapter for global teardown.
3. Add GitHub Actions example and Markdown summary output.
4. Add diff/ratchet mode: fail only on leaks introduced by changed tests.
5. Add ignore APIs for intentionally long-lived resources.
6. Add worker inheritance checks for runners that spawn isolated Node processes.

## Risks and mitigations

- False positives from legitimate long-lived resources: add `--min-age`, ignore APIs, and framework teardown adapters.
- Worker processes may not inherit `NODE_OPTIONS`: document runner-specific setup and add adapters.
- Native handles are hard to attribute: start with patched high-signal APIs, then add optional `_getActiveHandles()` diagnostics later.
- Windows process tree cleanup is tricky: use `taskkill /T /F` and cover it with CLI tests.

## Naming decision

Chosen name: `test-leak`.

Alternatives considered:

- `test-leak-detector`: more explicit, but longer and weaker as a daily CLI command.
- `leaklint`: catchy, but less obvious for npm search intent.
- `leak-hound`: memorable, but sounds broader than tests.
- `open-handle-doctor`: accurate for one symptom, but too narrow.

Decision drivers:

1. High search intent for `test leak` and `hanging tests`.
2. Short bin name that reads naturally in CI logs.
3. Room to grow beyond open handles into dirty globals and teardown leaks.
