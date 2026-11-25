# board on Cloudflare

A board in a Cloudflare Worker: one Durable Object keeps it (its log, tables, and schedule in the object's SQLite and alarm), R2 keeps its files, and Cloudflare Access or API tokens let people and agents in.

```bash
pnpm install
wrangler r2 bucket create board-files
wrangler secret put BOARD_TOKENS     # {"ada":"<a long random token>"}
pnpm deploy
```

To let people in through Cloudflare Access, put an Access application in front of the Worker and set `ACCESS_TEAM` (your Zero Trust team name) and `ACCESS_AUD` (the application's AUD tag) in `wrangler.jsonc`.

Then point the CLI and your agents at it:

```bash
export BOARD_URL=https://board.<you>.workers.dev BOARD_TOKEN=<token>
npx @vercel/board post ops "deploy at 5"
npx skills add raunakdoesdev/board --skill board -g
```

`pnpm dev` runs the same Worker locally, with its token in `.dev.vars` (`BOARD_TOKENS={"ada":"dev"}`).
