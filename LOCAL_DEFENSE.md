# Local defense and safe task resumption

Local defense is an opt-in, same-system responder service for managed Playerbots. It coalesces authoritative player or managed-bot attacks into persistent incidents, reserves eligible responders, navigates them to the victim and uses native drone and Crimewatch authorities. Ordinary pirate NPC attacks keep their normal defensive behavior; they do not recruit this service.

## Enable deliberately

The shipped defaults are `enabled: false`, `aggressive: false`, empty `systemIDs`, empty `responderIDs`, and no explicit cooperation agreements. Installing this feature does not select pilots or enable rescue. Existing fitting/target-accounting correctness fixes still apply.

Administrator commands:

```
/playerbots defense status
/playerbots defense events
/playerbots defense set {"systemIDs":[30000145],"responderIDs":[YOUR_RESPONDER_CHARACTER_ID],"enabled":true,"aggressive":true}
/playerbots defense off
/playerbots defense cancel LD1
```

Replace the responder placeholder with a real positive character ID before submitting valid JSON. The system ID is an example, not an automatically enabled location. Configuration patches merge with current settings and are validated before persistence.

`miningRescue` and `generalRescue` independently control victim categories. Defaults are two responders per incident, four per system, four globally and two reserved player-origin slots. Configurable maxima are five, eight and twelve responders respectively; `playerReserve` is 1–4. A player slot reservation is capacity priority, not guaranteed assistance. At most 128 incidents are retained by the coordinator.

Same corporation, alliance or configured `agreements` allow assistance consideration. War enemies are excluded. Every responder separately requires a legal native Crimewatch engagement with no criminal consequence. A victim's bilateral limited engagement does not transfer to its helpers. Managed attackers are considered only in the live incident context; ordinary bot-versus-bot targeting restrictions remain.

Responders must be connected, in the same system and interaction scope, fitted for supported drone combat and available for preemption. Pilots with unresolved industrial transactions, blocking task leases, routes, incompatible operations or existing rescue ownership are excluded. A responder's counterattack cannot start a chain of opposing rescue recruitment.

## Defensive behavior

Native ship attributes, current combat role and both bay and own deployed drones determine readiness. Drones controlled by another ship do not satisfy the fit. Adaptive policy is used only when local defense and aggressive mode are enabled for the system. Policy considers observed health, capacitor, legal targets, on-grid support and narrowly estimated arrival of an already warping responder. En-route ships do not inflate on-grid strength.

Policy parameters include entry/retreat/critical/reengagement shield thresholds, armor and hull limits, active-fit capacitor floor, sustained-low-shield interval, observed strength ratio and a bounded wait for credible help. Invalid or unsafe ordering is rejected. Unknown arrival time is not treated as immediate support.

Threat expiry, target loss, legal-right loss, disabling and operator cancellation request disengagement. The native drone service recalls drones and reservations release before ordinary work resumes. Critical evacuation is not delayed indefinitely by recall. Turning the service off does not promise that every ship has already reached safety.

## Persistence and interruption safety

The feature stores settings, incidents, leases, decision memory and interruption mailboxes through the existing GameStore owner APIs. It does not import or replace player data. Economic commits settle before a pending emergency takes ownership; uncertain purchases remain under the existing review protection. Cancellable reads use generation and operation checks so late responses cannot restart abandoned work. Original work IDs remain available for resumption. Recovery expires stale evidence; it is not a guarantee of zero-loss power failure recovery or seamless combat continuation.

## Scope

This feature does not implement cross-system dispatch, turret/missile/capital combat controllers, automatic war declarations or unrestricted PvP. It uses the existing native authorities and does not change their damage rules.

## Tests

Run the controlled-dependency suite with Node.js and no third-party test packages:

```
EVEJS_ROOT=/path/to/compatible/EveJS-261108.1 node tests/run-local-defense.cjs
```

PowerShell:

```
$env:EVEJS_ROOT = 'C:\path\to\EveJS-261108.1'
node tests/run-local-defense.cjs
```

The repository contains selected engine overlays rather than a full engine. The test-only loader resolves unchanged missing engine modules from `EVEJS_ROOT`; overlay modules always take precedence. Tests generate in-memory synthetic identities and do not read a player's database, connect to a game service or write test reports into a game installation. They cover coordinator limits and deduplication, legal targeting and instance boundaries, configuration/English commands, policy/arrival decisions, cleanup, scheduler wake interleavings and economic interruption ownership. These are controlled-dependency tests, not a graphical client or full-world simulation.

Packaging uses the supported original checkout and the existing guarded installer. See CONTRIBUTING.md. No release version is reserved by this candidate; a generated 0.2.142 ZIP is a local build-verification artifact until the maintainer chooses release/version policy.

## Disabled-mode compatibility

With no configured incidents, disabled local defense does not dispatch responders, queue rescue callbacks or write rescue state. Disabling miningRescue preserves the existing mining/escort threat path; disabling aggressive mode preserves the upstream repeated-NPC assessment cache. Shared correctness fixes (owned deployed-drone readiness, current combat-role attributes, native wreck accounting), atomic wake and interruption ownership still apply when rescue is off. This is not a promise of byte-identical behavior to unpatched upstream. Existing reservations must still drain safely when an enabled service is turned off.
