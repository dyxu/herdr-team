`released.openrpc.json` is the official herdr-core 0.1.21 published API contract,
retrieved on 2026-11-13 from:
https://github.com/herdrdev/herdr-core/blob/master/schema/released.openrpc.json

Upstream: https://github.com/herdrdev/herdr-core (Apache-2.0).
Tests validate outbound RPC parameters against this independent contract.
The transport follows https://github.com/herdrdev/herdr-core/blob/master/schema/README.md.

To verify with an installed real core (no coding agents or credentials required):

    go build -o bin/herdr-team .
    python3 scripts/verify-core.py --core /absolute/path/to/herdr-core

The script uses a private socket, HC_SESSION and XDG directories. It starts OSC
7501 fixture programs, tests idle/done initialization and message-interrupted
waits, verifies status/reuse without duplicate delivery, then cleans up its core.
