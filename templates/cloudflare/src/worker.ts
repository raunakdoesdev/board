import { DurableObject } from 'cloudflare:workers'
import { board, type Board as BoardHandle } from '@vercel/board'
import { bearerTokens, cloudflareAccess, durableObject, firstOf, r2Blob, type DurableObjectBackend } from '@vercel/board/backend-cloudflare'

type Env = {
  BOARD: DurableObjectNamespace<Board>
  FILES: R2Bucket
  /** `{ "handle": "token" }`: API tokens for the CLI and agents, as a secret. */
  BOARD_TOKENS?: string
  ACCESS_TEAM?: string
  ACCESS_AUD?: string
}

/** The board: one Durable Object keeps it, and serves it. */
export class Board extends DurableObject<Env> {
  readonly backend: DurableObjectBackend
  readonly team: BoardHandle

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.backend = durableObject(ctx.storage, { blob: r2Blob(env.FILES) })
    const tokens = bearerTokens(env.BOARD_TOKENS ? (JSON.parse(env.BOARD_TOKENS) as Record<string, string>) : {})
    const access = env.ACCESS_TEAM && env.ACCESS_AUD ? cloudflareAccess({ team: env.ACCESS_TEAM, aud: env.ACCESS_AUD }) : null
    this.team = board({ backend: this.backend, authenticate: access ? firstOf(tokens, access) : tokens })
  }

  fetch(request: Request) {
    return this.team.fetch(request)
  }

  alarm() {
    return this.backend.alarm()
  }
}

export default {
  fetch(request, env) {
    return env.BOARD.getByName('board').fetch(request)
  },
} satisfies ExportedHandler<Env>
