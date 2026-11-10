# EveJS project and fitting-data credits

## Original EveJS project

This add-on is built for the original EveJS server and uses its native game
services. EveJS project information and community support are available through
the official Discord invite: <https://discord.gg/qrdfam8Mz>. The server
integration in this ZIP is an overlay for the version stated in
`manifest.json`; the add-on's source and distribution license is in `LICENSE`.

## Community fitting data

The bundled static fitting catalog is derived from the XML fitting collection
shared in the EveJS Discord post **“[EveJS v12.3.1] 400+ Saved Fittings,”**
attributed by the maintainer to **John Elysian**. The exact Discord display
name and spelling have not been independently verified. The message permalink
and a separate data license were not present in the supplied files. The import
retains fitting names and descriptions; 5,353 usable entries are included,
with 11 unusable entries omitted. This fitting-data attribution is separate
from the EveJS project credit.

## EVE Online marks and data

EVE Online names and related game data belong to their respective owners. This
community project is not affiliated with or endorsed by CCP Games.

## Living Universe patch (X-Eve)

`playerBotWorkBudget.js`, the garbage-collection accumulator and the summary
helpers in `playerBotPerformanceTelemetry.js`, and the deterministic hash and
duration helpers in `playerBotPatrolRotation.js` are ported or adapted from the
X-Eve Living Universe patch, version 0.3.0, with the permission of its
maintainers. Each of those files names its origin in its header. Playerbots
does not include the Living Universe simulation, its virtual pilots, or its
economy. The original patch contributions are licensed as follows:

```text
MIT License - Original Patch Contributions Only

Copyright (c) 2026 X-Eve Living Universe patch contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of the original contributions contained in this patch repository (the
"Patch Contributions"), to deal in the Patch Contributions without
restriction, including without limitation the rights to use, copy, modify,
merge, publish, distribute, sublicense, and/or sell copies of the Patch
Contributions, and to permit persons to whom the Patch Contributions are
furnished to do so, subject to the following conditions:

The above copyright notice, this permission notice, and the scope notice below
shall be included in all copies or substantial portions of the Patch
Contributions.

THE PATCH CONTRIBUTIONS ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE PATCH CONTRIBUTIONS OR THE USE
OR OTHER DEALINGS IN THE PATCH CONTRIBUTIONS.

Scope and third-party notice
----------------------------

This license applies only to original contributions authored for the X-Eve
Living Universe patch, and only to the extent that the contributors have the
right to license those contributions. It does not license or redistribute any
compatible server source baseline, an EVE Online client, CCP Games assets,
trademarks, databases, or any other third-party material. Applying the patch
requires a separately obtained compatible v0.12.3.1 installation, whose own terms
continue to apply.

This independent project is not affiliated with, endorsed by, or sponsored by
CCP Games or any upstream server project. EVE Online and related trademarks
belong to CCP Games. All other third-party names and marks belong to their
respective owners.
```
