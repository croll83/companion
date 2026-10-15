# brain-bundle

`brain.js` is the server of an **embedded** brain: Companion's supervisor runs
it under Bun as a child process (`server/brain/brain-supervisor.ts`), one per
embedded brain, and talks to it only over HTTP. It is not built here: it is
the Companion bundle of the [brains](https://github.com/croll83/brains)
project (`packages/companion-bundle`), whose core is the canonical brain core.
`bun run build` copies it to `dist/brain/brain.js`.

`bundle.json` records the brains commit it was built from, its version and its
`BRAIN_PROTOCOL`, which must equal `BRAIN_PROTOCOL_EXPECTED` in
`brain-supervisor.ts` (a test checks it; the smoke script checks the running
bundle).

## Updating it

In a brains checkout:

```sh
npm ci --include=dev
npm run build:bundle        # packages/companion-bundle/dist/brain.js
```

Copy `dist/brain.js` and `dist/brain.js.LEGAL.txt` here, set
`brains_commit` (and `version`, `protocol` if they changed) in `bundle.json`,
then in `web/`: `bun run build && bun run test:brain-smoke` and
`bun run test server/routes/brain-content-routes.test.ts` (both run the bundle
under Bun).
