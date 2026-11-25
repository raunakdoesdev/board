import { DatabaseSync } from 'node:sqlite'
import type { DurableStorage } from '../src/store/durable.ts'

/**
 * A Durable Object's storage on Node's SQLite, held to what Cloudflare's takes: no `begin`, `commit`,
 * `rollback`, or savepoints of the caller's own (`transactionSync` instead), and no `pragma`s.
 */
export function durableStorage() {
  const db = new DatabaseSync(':memory:')
  let alarm: number | null = null
  let depth = 0
  const storage: DurableStorage = {
    sql: {
      exec(query, ...bindings) {
        if (/^\s*(begin|commit|rollback|savepoint|release|pragma)\b/i.test(query)) throw new Error(`not authorized: ${query.trim().split(/\s/)[0]}`)
        if (bindings.length > 100) throw new Error('too many SQL variables')
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

