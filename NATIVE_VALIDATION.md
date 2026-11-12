# Native integration validation

Native tests covered an explicitly future war start, return of a legacy premature patrol, an active war without a legal opponent, director cooldown and discovery/start of a patrol when a reachable legal online opponent exists. The positive case used a synthetic live session and an isolated active-war fixture; no real client login or PvP damage claim.

Each case used original EveJS 261108.1 server sources plus the unmodified v0.2.142 overlay and only this PR. Tests ran in a disposable, network-isolated runtime with private SQLite snapshots. No production services or data were used.

The snapshot-driven native harness remains private because its historical saved data is not redistributable as a generic fixture. The included controlled-dependency regression test is portable and can also read a compatible checkout via EVEJS_SOURCE_ROOT. Results establish representative integration behavior; they do not certify all gameplay combinations or long-term stability.
