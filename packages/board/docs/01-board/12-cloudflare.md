---
title: Cloudflare
description: Keep a board in a Durable Object, its files in R2, and let people in with Cloudflare Access or tokens.
---

## One Durable Object per board

`durableObject()` from `@vercel/board/backend-cloudflare` is a backend on a Durable Object's own storage: the board's log and its tables in the object's SQLite, and its schedule (scheduled messages, watcher retries, task leases) on the object's alarm. It's the [local board's](./10-local.md) engine, so it passes the same [conformance](../04-reference/05-conformance.md) kit.

```ts src/worker.ts
import { DurableObject } from 'cloudflare:workers'
import { board } from '@vercel/board'
import { bearerTokens, cloudflareAccess, durableObject, r2Blob } from '@vercel/board/backend-cloudflare'

export class Board extends DurableObject<Env> {
  backend = durableObject(this.ctx.storage, { blob: r2Blob(this.env.FILES) })
  tokens = bearerTokens(JSON.parse(this.env.BOARD_TOKENS))
  access = cloudflareAccess({ team: this.env.ACCESS_TEAM, aud: this.env.ACCESS_AUD })
  team = board({
    backend: this.backend,
    authenticate: async (request) => (await this.tokens(request)) ?? (await this.access(request)),
  })

  fetch(request: Request) {
    return this.team.fetch(request)
  }

  alarm() {
    return this.backend.alarm()
  }
}

export default {
  fetch: (request, env) => env.BOARD.getByName('board').fetch(request),
} satisfies ExportedHandler<Env>
```

The object's class is a SQLite one (`new_sqlite_classes` in its migration), and the Worker runs with `nodejs_compat`. The [cloudflare template](https://github.com/raunakdoesdev/board/tree/main/templates/cloudflare) is this Worker with its `wrangler.jsonc`.

## Who gets in

- **`cloudflareAccess({ team, aud })`** verifies the JWT Cloudflare Access puts on every request it lets through (`Cf-Access-Jwt-Assertion`, or the `CF_Authorization` cookie) against the team's keys. A person is `cloudflare:user:<email>`; a service token is `cloudflare:service:<client id>`.
- **`bearerTokens({ ada: '<token>' })`** lets in whoever sends one of these tokens as `Authorization: Bearer`, as `cloudflare:user:ada`. Keep them in a Worker secret. The CLI sends one from `BOARD_TOKEN`:

```bash
BOARD_URL=https://board.acme.workers.dev BOARD_TOKEN=<token> npx @vercel/board read ops
```

Either way, whoever gets in is a person on the board, and [grants](./09-access.md) say what anyone else may do.

## Files

`r2Blob(bucket, prefix?)` keeps attachments in an R2 bucket, under `prefix` when you share one. A file goes through the Worker both ways: R2 gives no upload URL a board can hand out.
