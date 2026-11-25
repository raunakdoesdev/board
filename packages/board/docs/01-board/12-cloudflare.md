---
title: Cloudflare
description: Keep a board in a Durable Object, its files in R2, and let people in with Cloudflare Access or tokens.
---

## One Durable Object per board

`durableObject()` from `@vercel/board/backend-cloudflare` is a backend on a Durable Object's own storage: the board's log and its tables in the object's SQLite, and its schedule (scheduled messages, watcher retries, task leases) on the object's alarm. It's the [local board's](./10-local.md) engine, so it passes the same [conformance](../04-reference/05-conformance.md) kit.

```ts src/worker.ts
import { DurableObject } from 'cloudflare:workers'
import { board } from '@vercel/board'
import { bearerTokens, cloudflareAccess, durableObject, firstOf, r2Blob } from '@vercel/board/backend-cloudflare'

export class Board extends DurableObject<Env> {
  backend = durableObject(this.ctx.storage, { blob: r2Blob(this.env.FILES) })
  team = board({
    backend: this.backend,
    authenticate: firstOf(
      bearerTokens(JSON.parse(this.env.BOARD_TOKENS)),
      cloudflareAccess({ team: this.env.ACCESS_TEAM, aud: this.env.ACCESS_AUD }),
    ),
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

- **`cloudflareAccess({ team, aud })`** verifies the JWT Cloudflare Access puts on every request it lets through (`Cf-Access-Jwt-Assertion`, or the `CF_Authorization` cookie) against the team's keys. A person is `cloudflare:user:<email>`, and grants name them by email, so an email with anything but letters, numbers, and `._-` before the `@` is refused; a service token is `cloudflare:service:<client id>`. A request a browser marks as another site's is refused, since a browser sends the Access cookie with any site's requests.
- **`bearerTokens({ ada: '<token>' })`** lets in whoever sends one of these tokens as `Authorization: Bearer`, as `cloudflare:user:ada`. A handle is letters, numbers, and `._-`, starting with a letter or number; a token under any other handle is skipped, with an error in the log. Keep them in a Worker secret. Access answers for a domain it fronts before the Worker sees a request, so tokens go to a URL it doesn't, like the Worker's `workers.dev` one. The CLI sends one from `BOARD_TOKEN`:

```bash
BOARD_URL=https://board.acme.workers.dev BOARD_TOKEN=<token> npx @vercel/board read ops
```

`firstOf(...)` tries each verifier in turn. Either way, whoever gets in is a person on the board, and [grants](./09-access.md) say what anyone else may do.

## Files

`r2Blob(bucket, prefix?)` keeps attachments in an R2 bucket, under `prefix` when you share one. A file goes through the Worker both ways: R2 gives no upload URL a board can hand out.

## Behind a gateway

A gateway that signs people in and names them in a header can serve the inspector, the board's web UI, at its own host. `inspector({ board, basePath, visitor })` from `@vercel/board/inspect` starts the page as whoever `visitor(request)` names, writes as them whatever profile the page sends, and answers 401 when it names no one. The `templates/cloudflare` Worker does this when `GATEWAY_HOST`, `GATEWAY_EMAIL_HEADER`, and `GATEWAY_DOMAIN` are set: ada.lovelace@acme.com is the profile `ada-lovelace`, and an email from another domain is refused. Trust the header only when nothing reaches that host but the gateway.
