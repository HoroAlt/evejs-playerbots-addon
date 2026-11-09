# Public community fittings

EveJS serves the public community ship-fitting library through
`corpFittingMgr.GetCommunityFittings`. The public owner is corporation ID
`1000282`; players can read the library without joining a corporation or
receiving fitting-manager roles. The endpoint remains read-only for community
data. Character, corporation, and alliance fitting libraries keep their normal
owner and role checks.

The bundled FitALL catalog is stored in `server/assets/fittings/fitall.json`.
It contains 5,353 usable fits imported from the XML collection shared in the
EveJS Discord post **“[EveJS v12.3.1] 400+ Saved Fittings,”** attributed to
**John Elysian** by the maintainer; the exact Discord display name and spelling
have not been independently verified. The Discord message permalink and a
separate data license were not included with the source files available for
this package. Eleven source entries marked missing or lacking a usable fit
were omitted. Each imported record contains the ship type, fitting name and
description, and the module, charge, drone, or cargo item tuples used by the
client fitting protocol. No FitALL launcher, batch file, PowerShell script, or
Python application is required by the server; the JSON catalog is static data
loaded by the fitting store.

The official EveJS community Discord is <https://discord.gg/qrdfam8Mz>.

This is a data-source credit, separate from the add-on code credits in
`THIRD_PARTY_NOTICES.md`. The catalog is bundled so the installer does not
depend on a developer's Discord download or external files.

The fitting store combines these bundled records with community fittings saved
through the server's existing community fitting authority. The static IDs use a
reserved range so they do not collide with IDs allocated to saved fittings.
