import { DurableObject } from 'cloudflare:workers'
import { board, type Board as BoardHandle } from '@vercel/board'
import { bearerTokens, cloudflareAccess, durableObject, firstOf, r2Blob, type DurableObjectBackend } from '@vercel/board/backend-cloudflare'
import { inspector, type InspectorHandler } from '@vercel/board/inspect'

/** Set by this Worker alone, on a request from the gateway's host: the inspector answers it. */
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
  GATEWAY_AVATAR_HEADER?: string
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
    this.page = inspector({ board: this.team, basePath: '' })
  }

  fetch(request: Request) {
    return request.headers.has(PAGE) ? this.page(request) : this.team.fetch(request)
  }

  alarm() {
    return this.backend.alarm()
  }
}

/**
 * Whom the gateway names, as a profile: `ada` for ada@acme.com, with the avatar it gives. The
 * inspector writes as the board's own handle under it, whatever profile the page asked for.
 */
function visitor(request: Request, env: Env): string | null {
  const email = request.headers.get(env.GATEWAY_EMAIL_HEADER ?? '')?.trim().toLowerCase()
  const name = email?.split('@')[0]?.replace(/[^a-z0-9._-]/g, '-').replace(/^[^a-z]+/, '')
  if (!name) return null
  const avatar = request.headers.get(env.GATEWAY_AVATAR_HEADER ?? '')
  return avatar && /^https:\/\/[\x21-\x7e]+$/.test(avatar) ? `${name};avatar="${avatar.replace(/[\\"]/g, '\\$&')}"` : name
}

export default {
  fetch(request, env) {
    const headers = new Headers(request.headers)
    headers.delete(PAGE)
    if (env.GATEWAY_HOST && new URL(request.url).hostname === env.GATEWAY_HOST) {
      // Only the gateway reaches this host, and it names whoever it let in.
      const profile = visitor(request, env)
      if (profile === null) return new Response('the gateway named no one', { status: 401 })
      headers.set(PAGE, '1')
      headers.set('x-board-profile', profile)
    }
    return env.BOARD.getByName('board').fetch(new Request(request, { headers }))
  },
} satisfies ExportedHandler<Env>
