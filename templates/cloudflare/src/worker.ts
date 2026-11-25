import { DurableObject } from 'cloudflare:workers'
import { board, type Board as BoardHandle } from '@vercel/board'
import { bearerTokens, cloudflareAccess, durableObject, firstOf, r2Blob, type DurableObjectBackend } from '@vercel/board/backend-cloudflare'
import { inspector, type InspectorHandler } from '@vercel/board/inspect'

/** Set by this Worker alone, on a request from the gateway's host, to whom the gateway named: the inspector answers it as them. */
const PAGE = 'x-board-page'

type Env = {
  BOARD: DurableObjectNamespace<Board>
  FILES: R2Bucket
  /** `{ "handle": "token" }`: API tokens for the CLI and agents, as a secret. */
  BOARD_TOKENS?: string
  /** The board's URL, which every token's audience must equal: its `workers.dev` URL, say. */
  BOARD_URL?: string
  ACCESS_TEAM?: string
  ACCESS_AUD?: string
  /** A host a gateway in front signs people in at, and names them in `GATEWAY_EMAIL_HEADER`: it serves the inspector. */
  GATEWAY_HOST?: string
  GATEWAY_EMAIL_HEADER?: string
  /** The email domain people are named in by their local part alone; anyone else is refused. */
  GATEWAY_DOMAIN?: string
}

/** The board: one Durable Object keeps it, and serves it. */
export class Board extends DurableObject<Env> {
  readonly backend: DurableObjectBackend
  readonly team: BoardHandle
  readonly page: InspectorHandler

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.backend = durableObject(ctx.storage, { blob: r2Blob(env.FILES) })
    const tokens = bearerTokens(env.BOARD_TOKENS ? (JSON.parse(env.BOARD_TOKENS) as Record<string, string>) : {})
    const access = env.ACCESS_TEAM && env.ACCESS_AUD ? cloudflareAccess({ team: env.ACCESS_TEAM, aud: env.ACCESS_AUD }) : null
    this.team = board({ backend: this.backend, authenticate: access ? firstOf(tokens, access) : tokens, ...(env.BOARD_URL ? { url: env.BOARD_URL } : {}) })
    this.page = inspector({ board: this.team, basePath: '', visitor: (request) => request.headers.get(PAGE) })
  }

  fetch(request: Request) {
    return request.headers.has(PAGE) ? this.page(request) : this.team.fetch(request)
  }

  alarm() {
    return this.backend.alarm()
  }
}

/**
 * Whom the gateway names, as a profile: `ada-lovelace` for ada.lovelace@acme.com when `GATEWAY_DOMAIN`
 * is acme.com, and no one from another domain, where the same name could be someone else's.
 */
function visitor(request: Request, env: Env): string | null {
  const email = request.headers.get(env.GATEWAY_EMAIL_HEADER ?? '')?.trim().toLowerCase()
  const at = email?.lastIndexOf('@') ?? -1
  if (!email || at < 1 || email.slice(at + 1) !== env.GATEWAY_DOMAIN?.toLowerCase()) return null
  const name = email.slice(0, at).replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+/, '').slice(0, 32).replace(/-+$/, '')
  return name || null
}

export default {
  fetch(request, env) {
    const headers = new Headers(request.headers)
    headers.delete(PAGE)
    if (env.GATEWAY_HOST && new URL(request.url).hostname === env.GATEWAY_HOST) {
      // Only the gateway reaches this host, and it names whoever it let in.
      const profile = visitor(request, env)
      if (profile === null) return new Response('the gateway named no one', { status: 401 })
      headers.set(PAGE, profile)
    }
    return env.BOARD.getByName('board').fetch(new Request(request, { headers }))
  },
} satisfies ExportedHandler<Env>
