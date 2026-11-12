# Native integration validation

Five legacy native upgrade jobs recovered with their original hulls, twelve fitted modules and five mid slots. Item quantities were conserved and additional spend was zero. An impossible six-mid template was rejected before buying. Pure upstream reproduced the original stalled fit with the same snapshot.

Each case used original EveJS 261108.1 server sources plus the unmodified v0.2.142 overlay and only this PR. Tests ran in a disposable, network-isolated runtime with private SQLite snapshots. No production services or data were used.

The snapshot-driven native harness remains private because its historical saved data is not redistributable as a generic fixture. The included controlled-dependency regression test is portable and can also read a compatible checkout via EVEJS_SOURCE_ROOT. Results establish representative integration behavior; they do not certify all gameplay combinations or long-term stability.
