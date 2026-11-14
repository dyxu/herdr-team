# herdr-core contract fixture

[`released.openrpc.json`](released.openrpc.json) is the official herdr-core 0.1.21
published API contract, retrieved on 2026-11-13 from the
[upstream schema](https://github.com/herdrdev/herdr-core/blob/master/schema/released.openrpc.json).
Upstream [herdr-core](https://github.com/herdrdev/herdr-core) is licensed under Apache-2.0.

The TypeScript transport in [`src/process.ts`](../../src/process.ts) follows the
[plain stdio JSON-RPC transport](https://github.com/herdrdev/herdr-core/blob/master/schema/README.md).
[`test/core.test.mjs`](../../test/core.test.mjs) validates outbound parameters against
this independent snapshot, including the restriction that `terminal.send.if` accepts
`idle` or `working`, not `done`. CLI `run/ls` output is abbreviated and is not a
substitute for the RPC response shape.

From the repository root, using Node.js 22.13+ and npm:

```sh
npm ci
npm test
```

To verify against an installed real core, also install Python 3:

```sh
npm run verify:core -- --core /absolute/path/to/herdr-core
```

This command builds the TypeScript CLI and runs
[`scripts/verify-core.py`](../../scripts/verify-core.py) with a private socket,
`HC_SESSION` and XDG directories. It starts OSC 7501 fixture programs, checks
idle/done initialization, message-interrupted waits, startup settling, permission
blockage and status/reuse without duplicate delivery, then cleans up its core.
It does not launch coding agents or require vendor credentials.

See the [verification guide](../../docs/verification.md) for real Agent tests and
for the distinction between protocol fixtures, simulated agents and end-to-end work.
