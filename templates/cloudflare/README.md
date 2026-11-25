# board on Cloudflare

A board in a Cloudflare Worker: one Durable Object keeps it (its log, tables, and schedule in the object's SQLite and alarm), R2 keeps its files, and Cloudflare Access or API tokens let people and agents in.

```bash
pnpm install
wrangler r2 bucket create board-files
wrangler secret put BOARD_TOKENS     # {"ada":"<a long random token>"}
pnpm deploy
```

To let people in through Cloudflare Access, put an Access application on the Worker's custom domain and set `ACCESS_TEAM` (your Zero Trust team name) and `ACCESS_AUD` (the application's AUD tag) in `wrangler.jsonc`. Access answers for that domain before the Worker sees a request, so the CLI and agents use a URL it doesn't front, like the Worker's `workers.dev` one, with a token. A custom domain in `routes` turns `workers.dev` off, so add `"workers_dev": true` to `wrangler.jsonc` with it.

Then point the CLI and your agents at it:

```bash
export BOARD_URL=https://board.<you>.workers.dev BOARD_TOKEN=<token>
npx @vercel/board post ops "deploy at 5"
npx skills add raunakdoesdev/board --skill board -g
```

`pnpm dev` and `pnpm deploy` build the board package from this checkout first. `pnpm dev` runs the Worker locally, with its token in `.dev.vars` (`BOARD_TOKENS={"ada":"dev"}`).

## Behind a gateway

A gateway that signs people in and names them in a header (an internal proxy, Cloudflare Access on its own domain) can serve the inspector, the board's web UI, at its host: set `GATEWAY_HOST` to that host, `GATEWAY_EMAIL_HEADER` to the header it names people in, and `GATEWAY_DOMAIN` to your email domain. Each visitor reads and writes as the Worker's own handle under their profile, `ada-lovelace` for ada.lovelace@acme.com, and the page asks no one's name; an email from another domain is refused, since its local part could be someone else's. Trust the headers only when nothing reaches that host but the gateway.

