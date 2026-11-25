import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose'
import { describe, expect, it, vi } from 'vitest'
import { board as handle } from '../src/server/index.ts'
import { http } from '../src/backend-http/index.ts'
import { bearerTokens, cloudflareAccess, durableObject, firstOf, type DurableStorage } from '../src/backend-cloudflare/index.ts'
import { alarmScheduler } from '../src/scheduler/alarms.ts'
import { memoryBlob } from '../src/server/blob.ts'
import { oidcTokens } from '../src/access/index.ts'
import { conformance } from '../src/conformance/index.ts'
import { durableStorage } from './durable-storage.ts'
import { bearer, board, BOARD_URL, personToken, testAuth } from './harness.ts'

vi.setConfig({ testTimeout: 60_000 })

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

  it('keeps a message that mentions more people than a statement binds, and shows a full page of the latest', async () => {
    const client = await clientOf(objectBoard(durableStorage()).fetch)
    const text = Array.from({ length: 40 }, (_, i) => `@agent${i}`).join(' ')
    await client.post('ops', text)
    for (let i = 0; i < 100; i++) await client.post('load', `note ${i}`)
    const { messages } = await client.channel('ops').messages({ limit: 10 })
    expect(messages.map((message) => message.text)).toEqual([text])
    expect((await client.channel('load').messages({ limit: 100 })).messages).toHaveLength(100)
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

describe('a Durable Object alarm', () => {
  it('keeps a task that fails and wakes again to retry it', async () => {
    const storage = durableStorage()
    const scheduler = alarmScheduler(storage)
    const dueAt = Date.now() - 1
    await scheduler.schedule({ version: 1, kind: 'drain', contract: 'nobody-serves-this', sessionId: 's1', dueAt })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await scheduler.alarm()
    const retry = storage.alarmAt()
    expect(retry).toBeGreaterThan(Date.now())
    // A restart still has it, and tries it again when that alarm goes off.
    vi.spyOn(Date, 'now').mockReturnValue(retry! + 1)
    await alarmScheduler(storage).alarm()
    vi.mocked(Date.now).mockRestore()
    expect(error.mock.calls.map(([line]) => String(line))).toEqual([expect.stringContaining('attempt 1 of'), expect.stringContaining('attempt 2 of')])
    expect(storage.alarmAt()).toBeGreaterThan(retry!)
    error.mockRestore()
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

    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const odd = board({ backend: durableObject(durableStorage()), authenticate: bearerTokens({ _bot: 'tok_bot', 'no one': 'tok_none' }), url: BOARD_URL })
    expect(await whoIs(odd, { authorization: 'Bearer tok_bot' })).toBe('cloudflare:user:_bot')
    expect(await whoIs(odd, { authorization: 'Bearer tok_none' })).toBe(401)
    error.mockRestore()
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
    expect(await whoIs(team, { cookie: `CF_Authorization=${await sign('aud_board')}`, 'sec-fetch-site': 'cross-site' })).toBe(403)
    expect(await whoIs(team, { cookie: `CF_Authorization=${await sign('aud_board')}`, 'sec-fetch-site': 'same-origin' })).toBe('cloudflare:user:ada@example.com')

    const both = board({
      backend: durableObject(durableStorage()),
      authenticate: firstOf(bearerTokens({ bot: 'tok_bot' }), cloudflareAccess({ team: 'acme', aud: 'aud_board', jwks })),
      url: BOARD_URL,
    })
    expect(await whoIs(both, { authorization: 'Bearer tok_bot' })).toBe('cloudflare:user:bot')
    expect(await whoIs(both, { 'cf-access-jwt-assertion': await sign('aud_board') })).toBe('cloudflare:user:ada@example.com')
  })

  it("keeps two people whose emails differ only by + and _ apart", async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256')
    const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'cf', alg: 'RS256' }] })
    const sign = (email: string) =>
      new SignJWT({ email })
        .setProtectedHeader({ alg: 'RS256', kid: 'cf' })
        .setIssuer('https://acme.cloudflareaccess.com')
        .setAudience('aud_board')
        .setExpirationTime('1h')
        .sign(privateKey)
    const team = board({ backend: durableObject(durableStorage()), authenticate: cloudflareAccess({ team: 'acme', aud: 'aud_board', jwks }), url: BOARD_URL })
    const plain = await whoIs(team, { 'cf-access-jwt-assertion': await sign('a_b@example.com') })
    const plus = await whoIs(team, { 'cf-access-jwt-assertion': await sign('a+b@example.com') })
    expect(plain).toBe('cloudflare:user:a_b@example.com')
    expect(plus).not.toBe(plain)
    expect(await whoIs(team, { 'cf-access-jwt-assertion': await sign("o'connor@example.com") })).toBe("cloudflare:user:o'connor@example.com")
  })
})
