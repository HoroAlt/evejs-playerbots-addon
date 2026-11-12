# Native integration validation

The real market daemon, wallet authority, inventory and industry services were used. A single standard wrapped failure was injected at the market service boundary before commitment. The cycle retained the request/baselines/error in review without automatic retry. After removing injection, a native purchase bought ten mineral units for 980 ISK and matched wallet, inventory and industrial ledger. This is not a market-concurrency fix or a new concurrency-race reproduction.

Each case used original EveJS 261108.1 server sources plus the unmodified v0.2.142 overlay and only this PR. Tests ran in a disposable, network-isolated runtime with private SQLite snapshots. No production services or data were used.

The snapshot-driven native harness remains private because its historical saved data is not redistributable as a generic fixture. The included controlled-dependency regression test is portable and can also read a compatible checkout via EVEJS_SOURCE_ROOT. Results establish representative integration behavior; they do not certify all gameplay combinations or long-term stability.
