# Native integration validation

A real mining route acquired ore through native laser cycles and delivered 667 units to the station, matching the job ledger. Empty return did not count a productive trip. Unsafe-base relocation used native navigation and reached a new safe station while a territorial assignment retained its designated base. Productive mining used a quiet test configuration with belt-rat spawning disabled; combat is outside this PR.

## PR #2

The native upgrade operation travelled to an existing hull, assembled/boarded through the ship service and completed fitting. The owned hull set stayed at 19 with zero additional acquisition spend.

## PR #3

Starting on an excluded ESS grid, the native deployment operation selected a legal relocation, warped through the space authority and created a new structure through normal anchoring. Repeated advancement kept the same deployed structure. This validates placement/recovery handoff, not an entire structure service-online lifecycle.

## PR #4

Five legacy native upgrade jobs recovered with their original hulls, twelve fitted modules and five mid slots. Item quantities were conserved and additional spend was zero. An impossible six-mid template was rejected before buying. Pure upstream reproduced the original stalled fit with the same snapshot.

## PR #5

Native tests covered an explicitly future war start, return of a legacy premature patrol, an active war without a legal opponent, director cooldown and discovery/start of a patrol when a reachable legal online opponent exists. The positive case used a synthetic live session and an isolated active-war fixture; no real client login or PvP damage claim.

Each case used original EveJS 261108.1 server sources plus the unmodified v0.2.142 overlay and only this PR. Tests ran in a disposable, network-isolated runtime with private SQLite snapshots. No production services or data were used.

The snapshot-driven native harness remains private because its historical saved data is not redistributable as a generic fixture. The included controlled-dependency regression test is portable and can also read a compatible checkout via EVEJS_SOURCE_ROOT. Results establish representative integration behavior; they do not certify all gameplay combinations or long-term stability.
