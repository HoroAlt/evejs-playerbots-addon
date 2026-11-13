# Homelab branch

Fork of [`kroryan/evejs-playerbots-addon`](https://github.com/kroryan/evejs-playerbots-addon),
tracking upstream releases plus the changes this server runs on its
`evejs-stand` (LXC 222, EveJS 261108.1).

`dev` is rebased onto each upstream release; `main` is kept as a plain
mirror of upstream so rebases stay clean:

```sh
packaging/sync-upstream.sh
```

It fetches `origin`, switches to `dev`, rebases onto `origin/main`, pushes
`dev` and mirrors `main` to the fork.

## What we change

| Area | File | Why |
| --- | --- | --- |
| Skill training | `playerBotFitPlanner.js`, `playerBotOperationRuntime.js` | Plan a hull's real fit from the killmail catalog (`fitall.json`), report the next rung that skills block, fly catalog ore fits on Procurer/Mackinaw |
| Skill training | `playerBotWarMobilizationRuntime.js`, `playerBotAutonomyRuntime.js` | `queueRoleTraining()` + director hook, so pilots above the 7-skill hand-written ceiling keep training |
| Performance | `playerBotSpaceRuntime.js` | `getActorSession` reads the shared character record instead of deep-copying it |
| Bug | `careerGoalGatewayService.js` | `careerProgress.syncAchievementProgress` does not exist in this EveJS; fall back to `sync()` (upstream still calls it, log spam) |
| Base tree | `server/src/services/corporation/corporationRuntimeState.js` | `getAssignedMemberTitles` no longer deep-copies the whole corporation runtime (~11% CPU) |
| Base tree | `.dockerignore` | Keeps `addons/` in the image build context, otherwise the server starts with `MODULE_NOT_FOUND` |

Base-tree changes are *not* part of the add-on package; they live as patches in
`packaging/base/` and are applied after the add-on install.

## Build a release

```sh
python3 packaging/build-package.py          # -> dist/evejs-playerbots-addon-v<packaging/VERSION>.zip
```

It takes the stock release ZIP in `dist/`, overlays every file under
`integration/server/`, recomputes the manifest hashes and stamps the version
(`0.2.145-local.1`). Upstream's own `tools/playerbots/build-addon-package.py`
expects a full EveJS working tree at the repository root and cannot run here.

## Deploy to the stand

```sh
TREE=/srv/stand/EveJS-261108.1
unzip -o dist/evejs-playerbots-addon-v0.2.145-local.1.zip -d /srv/stand
python3 /srv/stand/EveJS-Playerbots-Addon-v0.2.145-local.1/install.py "$TREE" --replace-conflicts
packaging/apply-base.sh "$TREE"
cd "$TREE" && docker compose build && docker compose up -d
```

`install.py` backs up every file it replaces in
`.playerbots-install-backup-<stamp>/`; `rollback.py` from the package restores
them. Rebuild the image after installing: the container runs code baked into
`evejs-local`, so `docker cp` is only a stopgap.

`verify.py` reports every guarded file that differs; with this branch the six
overlaid files above are expected to match and the base patches are invisible
to it.

## Versioning

`packaging/VERSION` is the release name; `--base-version` selects the upstream
release ZIP to overlay (defaults to the VERSION prefix, e.g. `0.2.146`). Bump the suffix (`-local.2`, …) for
every build so the running server can be told apart from upstream.
