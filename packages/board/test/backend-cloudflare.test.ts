import { DatabaseSync } from 'node:sqlite'
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose'
import { describe, expect, it, vi } from 'vitest'
import { board as handle } from '../src/server/index.ts'
import { http } from '../src/backend-http/index.ts'
import { bearerTokens, cloudflareAccess, durableObject, type DurableStorage } from '../src/backend-cloudflare/index.ts'
import { memoryBlob } from '../src/server/blob.ts'
import { oidcTokens } from '../src/access/index.ts'
import { conformance } from '../src/conformance/index.ts'
import { bearer, board, BOARD_URL, personToken, testAuth } from './harness.ts'

vi.setConfig({ testTimeout: 60_000 })

/**
 * A Durable Object's storage on Node's SQLite, held to what Cloudflare's takes: no `begin`, `commit`,
 * `rollback`, or savepoints of the caller's own (`transactionSync` instead), and no `pragma`s.
 */
function durableStorage() {
  const db = new DatabaseSync(':memory:')
  let alarm: number | null = null
  let depth = 0
  const storage: DurableStorage = {
    sql: {
      exec(query, ...bindings) {
        if (/^\s*(begin|commit|rollback|savepoint|release|pragma)\b/i.test(query)) throw new Error(`not authorized: ${query.trim().split(/\s/)[0]}`)
        if (bindings.length === 0 && !/^\s*(select|with)\b/i.test(query)) {
          db.exec(query)
          return { toArray: () => [] }
        }
        const values = bindings.map((value) => (value instanceof ArrayBuffer ? new Uint8Array(value) : value))
        const rows = db.prepare(query).all(...(values as never[])) as Record<string, unknown>[]
        return { toArray: () => rows.map((row) => ({ ...row })) }
      },
    },
    transactionSync(fn) {
      const name = `t${depth++}`
      db.exec(`savepoint ${name}`)
      try {
        const result = fn()
        db.exec(`release ${name}`)
        return result
      } catch (error) {
        db.exec(`rollback to ${name}`)
        db.exec(`release ${name}`)
        throw error
      } finally {
        depth--
      }
    },
    getAlarm: async () => alarm,
    setAlarm: async (at) => void (alarm = Number(at)),
  }
  return Object.assign(storage, { alarmAt: () => alarm })
}

/** A board in a Durable Object on `storage`, as a Worker's object serves it: a new object is a restart. */
function objectBoard(storage: DurableStorage) {
  const backend = durableObject(storage, { blob: memoryBlob() })
  const team = board({ backend, authenticate: oidcTokens(testAuth), url: BOARD_URL })
  return Object.assign(team, { backend })
}

const clientOf = (fetch: (request: Request) => Promise<Response>) =>
  handle({ backend: http(BOARD_URL, { fetch: bearer((input, init) => fetch(new Request(input, init)), () => personToken()) }) }).as(null)

/** The same handle, with `headers` on every request, as `vb conformance` opens one. */
const withHeaders = (fetch: (request: Request) => Promise<Response>) => (headers: Record<string, string>) =>
  handle({
    backend: http(BOARD_URL, {
      fetch: bearer((input, init) => {
        const request = new Request(input, init)
        for (const [name, value] of Object.entries(headers)) request.headers.set(name, value)
        return fetch(request)
      }, () => personToken()),
    }),
  }).as(null)

describe('a board in a Durable Object', () => {
  it('passes the conformance kit', async () => {
    const team = objectBoard(durableStorage())
    const report = await conformance(await clientOf(team.fetch), { withHeaders: withHeaders(team.fetch) })
    expect(report.checks.filter((check) => check.status === 'failed')).toEqual([])
    // What only a Vercel team has (roles, apps, other teams) and a lock a run can't lift are all it skips.
    expect(report.checks.filter((check) => check.status === 'skipped').map((check) => check.group)).toEqual(['grants', 'grants', 'grants', 'grants'])
    expect(report.ok).toBe(true)
  })

  it('keeps what was written when the object restarts', async () => {
    const storage = durableStorage()
    const before = await clientOf(objectBoard(storage).fetch)
    const posted = await before.post('ops', 'deploy at 5')
    await before.reply(posted.id, 'ack')

    const after = await clientOf(objectBoard(storage).fetch)
    const { messages } = await after.channel('ops').messages({ limit: 10 })
    expect(messages.map((message) => message.text)).toEqual(['deploy at 5', 'ack'])
  })

  it('sends a scheduled message when the alarm it set goes off, after a restart', async () => {
    const storage = durableStorage()
    const team = await clientOf(objectBoard(storage).fetch)
    await team.schedule('standup', { text: "what's everyone on today?", at: new Date(Date.now() + 1000) })
    expect(storage.alarmAt()).toBeGreaterThan(Date.now() - 1000)
    expect((await team.channel('standup').messages({ limit: 10 })).messages).toEqual([])

    const restarted = objectBoard(storage)
    await vi.waitFor(
      async () => {
        await restarted.backend.alarm()
        const { messages } = await (await clientOf(restarted.fetch)).channel('standup').messages({ limit: 10 })
        expect(messages.map((message) => message.text)).toEqual(["what's everyone on today?"])
      },
      { timeout: 10_000, interval: 250 },
    )
  })
})

describe('authenticating on Cloudflare', () => {
  /** Who the board says the caller with `headers` is, or the status it refused them with. */
  const whoIs = async (team: { fetch(request: Request): Promise<Response> }, headers: Record<string, string>) => {
    const client = handle({
      backend: http(BOARD_URL, {
        fetch: (input, init) => {
          const request = new Request(input, init)
          for (const [name, value] of Object.entries(headers)) request.headers.set(name, value)
          return team.fetch(request)
        },
      }),
    })
    try {
      return (await client.me()).principal
    } catch (error) {
      return (error as { status?: number }).status
    }
  }

  it('lets in a bearer token the Worker keeps, as its person, and no other', async () => {
    const team = board({ backend: durableObject(durableStorage()), authenticate: bearerTokens({ ada: 'tok_ada' }), url: BOARD_URL })
    expect(await whoIs(team, { authorization: 'Bearer tok_ada' })).toBe('cloudflare:user:ada')
    expect(await whoIs(team, { authorization: 'Bearer tok_bob' })).toBe(401)
  })

  it("lets in a person Cloudflare Access signed in, by email, and refuses another application's token", async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256')
    const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'cf', alg: 'RS256' }] })
    const sign = (aud: string) =>
      new SignJWT({ email: 'Ada@Example.com' })
        .setProtectedHeader({ alg: 'RS256', kid: 'cf' })
        .setIssuer('https://acme.cloudflareaccess.com')
        .setAudience(aud)
        .setExpirationTime('1h')
        .sign(privateKey)
    const team = board({ backend: durableObject(durableStorage()), authenticate: cloudflareAccess({ team: 'acme', aud: 'aud_board', jwks }), url: BOARD_URL })
    expect(await whoIs(team, { 'cf-access-jwt-assertion': await sign('aud_board') })).toBe('cloudflare:user:ada@example.com')
    expect(await whoIs(team, { 'cf-access-jwt-assertion': await sign('aud_other') })).toBe(401)
  })
})
