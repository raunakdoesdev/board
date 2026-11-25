// A board kept in a Cloudflare Durable Object, which `@vercel/board/backend-cloudflare` exports: the board's
// log, tables, and schedule in the object's SQLite, and its files in R2.
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import { a2 } from './a2.ts'
import { LOGIN, LOGINS, namesByLogin, type Authenticate } from './auth.ts'
import type { Backend, BoardBinding, Caller, ProtocolMethods, Trust } from './backend.ts'
import type { BlobStore } from './blob.ts'
import { HttpError, unauthorized } from './errors.ts'
import { METHODS } from './routing.ts'
import { alarmScheduler, type AlarmScheduler } from '../scheduler/alarms.ts'
import { durableStore, type DurableStorage } from '../store/durable.ts'
import type { BoardStore } from '../store/types.ts'

export type { DurableStorage } from '../store/durable.ts'

export type DurableObjectOptions = {
  /** Where its attachments go: `r2Blob(env.FILES)`, say. Without one, the board keeps no files. */
  blob?: BlobStore
}

/** A board in a Durable Object. Its `alarm()` is the object's: call it from the object's own `alarm()`. */
export type DurableObjectBackend = Backend & {
  /** Runs what's due on the board's schedule: retries, leases, wake-ups, scheduled messages. */
  alarm(): Promise<void>
}

/**
 * A board kept in the Durable Object `storage` belongs to (`this.ctx.storage`): its log and tables in
 * the object's SQLite, and its scheduler on the object's alarm, so it needs nothing else running. One
 * object is one board: name it with `idFromName` in the Worker that routes to it.
 */
export function durableObject(storage: DurableStorage, options: DurableObjectOptions = {}): DurableObjectBackend {
  let binding: BoardBinding | null = null
  let opening: Promise<{ backend: ReturnType<typeof a2>; store: BoardStore; scheduler: AlarmScheduler }> | null = null

  function open() {
    if (!binding) throw new Error("durableObject: this backend isn't serving a board yet: pass it to board({ backend })")
    const bound = binding
    opening ??= (async () => {
      let store: BoardStore
      try {
        store = durableStore(storage)
      } catch (error) {
        throw new HttpError(500, 'no_store', `can't open the board in its Durable Object: ${String((error as Error)?.message ?? error).split('\n')[0]}`)
      }
      const scheduler = alarmScheduler(storage)
      const backend = a2({ store, scheduler, ...(options.blob ? { blob: options.blob } : {}) })
      backend.bind(bound)
      return { backend, store, scheduler }
    })()
    opening.catch(() => (opening = null))
    return opening
  }

  const methods = Object.fromEntries(
    METHODS.map((name) => [name, async (caller: Caller, input: never, signal: AbortSignal) => ((await open()).backend[name] as (...args: unknown[]) => unknown)(caller, input, signal)]),
  ) as unknown as ProtocolMethods

  return {
    ...methods,
    routes: [],
    // The board lives here: board() lets its people in by default.
    keeps: true,
    trust: {
      grants: async () => (await open()).backend.trust.grants(),
    } satisfies Trust,
    bind(given: BoardBinding) {
      if (binding) throw new Error('durableObject: this backend already serves a board: create one per board()')
      binding = given
    },
    async alarm() {
      await (await open()).scheduler.alarm()
    },
  }
}

/** The part of an R2 bucket binding a board uses. */
export type R2Like = {
  put(key: string, value: Uint8Array, options: { httpMetadata: { contentType: string } }): Promise<unknown>
  get(key: string): Promise<{ body: ReadableStream<Uint8Array>; httpMetadata?: { contentType?: string } } | null>
}

/** A board's attachments in an R2 bucket (`env.FILES`), each under `prefix`. */
export function r2Blob(bucket: R2Like, prefix = ''): BlobStore {
  return {
    async put(key, data, contentType) {
      await bucket.put(`${prefix}${key}`, data, { httpMetadata: { contentType } })
    },
    async get(key) {
      const object = await bucket.get(`${prefix}${key}`)
      return object ? { data: object.body, contentType: object.httpMetadata?.contentType ?? 'application/octet-stream' } : null
    },
  }
}

/** A service token's client ID, or a token's handle, as a principal ID's last part holds it. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
/** A handle: no spaces, 64 characters at most. */
const handleOf = (value: string) => value.replace(/\s+/g, '_').slice(0, 64) || 'unknown'

export type CloudflareAccessOptions = {
  /** Your Zero Trust team's domain: `acme` or `acme.cloudflareaccess.com`. */
  team: string
  /** The Access application's audience (AUD) tag. */
  aud: string | readonly string[]
  /** Its signing keys, for tests: the team's certs by default. */
  jwks?: JWTVerifyGetKey
}

/**
 * An `authenticate` for a board behind Cloudflare Access: it verifies the request's
 * `Cf-Access-Jwt-Assertion` (or its `CF_Authorization` cookie) for the application, and the person
 * is `cloudflare:user:<email>`. A service token is `cloudflare:service:<client ID>`, a person of
 * its own. Null with no token, a 401 for a bad one. Grants name people by their emails.
 */
export function cloudflareAccess(options: CloudflareAccessOptions): Authenticate {
  const domain = options.team.includes('.') ? options.team : `${options.team}.cloudflareaccess.com`
  const issuer = `https://${domain}`
  const jwks = options.jwks ?? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`))
  const audience = typeof options.aud === 'string' ? options.aud : [...options.aud]
  const authenticate: Authenticate = async (request) => {
    const token =
      request.headers.get('cf-access-jwt-assertion') ??
      request.headers
        .get('cookie')
        ?.split(/;\s*/)
        .find((part) => part.startsWith('CF_Authorization='))
        ?.slice('CF_Authorization='.length)
    if (!token) return null
    // A browser sends the Access cookie with any site's requests: only the board's own pages act as its visitor.
    const site = request.headers.get('sec-fetch-site')
    const origin = request.headers.get('origin')
    if ((site !== null && site !== 'same-origin' && site !== 'none') || (origin !== null && origin !== new URL(request.audience).origin))
      throw new HttpError(403, 'forbidden', "a page on another site can't act as you on this board")
    let payload: Record<string, unknown>
    try {
      ;({ payload } = await jwtVerify(token, jwks, { issuer, audience }))
    } catch (error) {
      throw unauthorized(`invalid Cloudflare Access token: ${(error as Error).message}`)
    }
    const expiresAt = typeof payload.exp === 'number' ? new Date(payload.exp * 1000) : null
    if (typeof payload.email === 'string' && payload.email) {
      const email = payload.email.toLowerCase()
      if (!LOGIN.test(email)) throw unauthorized(`${email} can't be a person on this board: a login here has no \`+\``)
      return { id: `cloudflare:user:${email}`, kind: 'person', handle: handleOf(email.split('@')[0]!), expiresAt }
    }
    const service = typeof payload.common_name === 'string' ? payload.common_name : null
    if (service && NAME.test(service)) return { id: `cloudflare:service:${service}`, kind: 'person', handle: handleOf(service), expiresAt }
    throw unauthorized('this Cloudflare Access token names no person or service token')
  }
  return Object.assign(authenticate, { [LOGINS]: true })
}

/**
 * An `authenticate` for API tokens a Worker keeps as a secret, `{ handle: token }`: a request whose
 * bearer token is one of them is the person `cloudflare:user:<handle>`. Null for any other
 * request, so it composes: `(request) => (await tokens(request)) ?? (await access(request))`.
 */
export function bearerTokens(tokens: Readonly<Record<string, string>>): Authenticate {
  const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  for (const handle of Object.keys(tokens)) if (!NAME.test(handle)) throw new TypeError(`a token's handle is letters, numbers, and ._-, got ${JSON.stringify(handle)}`)
  const known = Promise.all(
    Object.entries(tokens)
      .filter(([, token]) => token.length > 0)
      .map(async ([handle, token]) => ({ handle, hash: await digest(token) })),
  )
  const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.reduce((diff, byte, i) => diff | (byte ^ b[i]!), 0) === 0
  return async (request) => {
    if (!request.credential) return null
    const hash = await digest(request.credential)
    const found = (await known).find((entry) => same(entry.hash, hash))
    return found ? { id: `cloudflare:user:${found.handle}`, kind: 'person', handle: handleOf(found.handle) } : null
  }
}

/**
 * Verifiers tried in turn, the first that recognizes a request saying who it is:
 * `firstOf(bearerTokens(tokens), cloudflareAccess(access))`. Grants name people by their logins
 * when any of them does.
 */
export function firstOf(...verifiers: readonly Authenticate[]): Authenticate {
  const authenticate: Authenticate = async (request) => {
    for (const verify of verifiers) {
      const principal = await verify(request)
      if (principal !== null && principal !== undefined) return principal
    }
    return null
  }
  return verifiers.some(namesByLogin) ? Object.assign(authenticate, { [LOGINS]: true }) : authenticate
}
