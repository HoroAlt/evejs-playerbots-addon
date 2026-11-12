# Local defense tests

See [LOCAL_DEFENSE.md](../LOCAL_DEFENSE.md) for execution and scope. Use a compatible original engine checkout as EVEJS_ROOT. The suite uses built-in Node assertions and synthetic state. It does not require a running game server or a player database.

The test loader falls back only for paths within the selected integration tree that are absent from this repository. No production module loader is changed. Directly invoking an individual test that imports engine helpers also needs `node --require ./tests/engine-checkout.cjs ...` and EVEJS_ROOT.
