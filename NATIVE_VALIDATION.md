# Native integration validation

Starting on an excluded ESS grid, the native deployment operation selected a legal relocation, warped through the space authority and created a new structure through normal anchoring. Repeated advancement kept the same deployed structure. This validates placement/recovery handoff, not an entire structure service-online lifecycle.

Each case used original EveJS 261108.1 server sources plus the unmodified v0.2.142 overlay and only this PR. Tests ran in a disposable, network-isolated runtime with private SQLite snapshots. No production services or data were used.

The snapshot-driven native harness remains private because its historical saved data is not redistributable as a generic fixture. The included controlled-dependency regression test is portable and can also read a compatible checkout via EVEJS_SOURCE_ROOT. Results establish representative integration behavior; they do not certify all gameplay combinations or long-term stability.
