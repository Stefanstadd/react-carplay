# Building + running the head unit

All commands below run from the project root (`~/react-carplay` on the Pi).

## First time / after a fresh git clone

```bash
npm install
```

This pulls the Node dependencies including `dbus-next` (only installs on
Linux — it's an `optionalDependency`).

## Development — hot-reload while editing

```bash
npm run dev
```

Starts the Vite dev server + opens the Electron window.  Saving any file
under `src/` hot-updates the running app without a full restart.

If you're editing config knobs via `nano src/renderer/src/components/headunit.config.ts`
and the change doesn't apply, kill (Ctrl+C) and re-run `npm run dev`.  Vite
is configured for polling so atomic-write editors (nano) should work, but
if it ever fails to pick up, restart is the escape hatch.

## Production build — ARM Linux (Raspberry Pi 4/5)

```bash
npm run build:armLinux
```

This produces an AppImage under `dist/` that you can launch directly.

## Production build — generic Linux

```bash
npm run build:linux
```

## Type-check only

```bash
npm run typecheck
```

## Lint + format

```bash
npm run lint
npm run format
```

## Just the renderer build (skip electron-builder)

```bash
npx electron-vite build
```

Then `npm start` runs the built version (`electron-vite preview`).

## Running on the Pi after a `git pull`

```bash
git pull
npm install           # only if package.json / lockfile changed
npm run dev           # for iteration
# or
npm run build:armLinux  # for the packaged AppImage
```

If `git pull` reports a merge conflict on a file you edited locally, the
cleanest recovery is:

```bash
git checkout --theirs <file>
git add <file>
git stash drop        # if you'd previously stashed
git pull
```

This takes the remote version and discards your local edits — re-apply
them by hand afterward.  For `headunit.config.ts` specifically, the
tunable values are isolated in one file so conflicts there are usually
small to re-apply.
