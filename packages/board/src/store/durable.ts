// A board's store in a Cloudflare Durable Object's SQLite: A2's SQLite store and the board's tables,
// on the storage the object keeps, in the same place as everything it writes.
import { sqlite as a2Sqlite } from 'experimental-a2/store-sqlite'
import { openDurable } from './node-sqlite.ts'
import { ddl, sqlTables, type Db, type Sql } from './sql.ts'
import type { BoardStore } from './types.ts'

/** What a Durable Object's SQL cursor gives back: its rows. */
export type DurableCursor = { toArray(): Record<string, unknown>[] }

/** The part of a Durable Object's `ctx.storage` a board uses: its SQL, and its alarm. */
export type DurableStorage = {
  sql: { exec(query: string, ...bindings: unknown[]): DurableCursor }
  transactionSync<T>(fn: () => T): T
  getAlarm(): Promise<number | null>
  setAlarm(scheduledTime: number | Date): Promise<void>
}

/** A Durable Object takes no booleans and no `Uint8Array`, and gives blobs back as `ArrayBuffer`s. */
const bind = (value: unknown) => {
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value instanceof Uint8Array) return value.slice().buffer
  return value ?? null
}
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
/** A value as SQL: what a statement past the bound-parameter limit writes in its text instead. */
const literal = (value: unknown): string => {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`SQLite can't store ${value}`)
    return String(value)
  }
  if (value instanceof Uint8Array) return `x'${hex(value)}'`
  if (value instanceof ArrayBuffer) return `x'${hex(new Uint8Array(value))}'`
  return `'${String(value).replaceAll("'", "''")}'`
}

/** A Durable Object binds at most 100 parameters to a statement. */
const MAX_BINDINGS = 100

/**
 * `query` on the object's SQL with `values` for its `?` or `?N` parameters, written into its text
 * when there are more than it binds.
 */
function exec(storage: DurableStorage, query: string, values: readonly unknown[]): DurableCursor {
  if (values.length <= MAX_BINDINGS) return storage.sql.exec(query, ...values.map(bind))
  let next = 0
  return storage.sql.exec(query.replace(/\?(\d*)/g, (_, n: string) => literal(values[n ? Number(n) - 1 : next++])))
}

const rows = (cursor: DurableCursor) =>
  cursor.toArray().map((row) => {
    for (const key in row) if (row[key] instanceof ArrayBuffer) row[key] = new Uint8Array(row[key] as ArrayBuffer)
    return row
  })

/**
 * A Durable Object refuses `pragma`s it doesn't know and every `begin`: its transactions are
 * `transactionSync`'s, which A2's store takes when the database has one.
 */
const SKIPPED = /^\s*(pragma|begin|commit|rollback)\b/i

/** `node:sqlite`'s `DatabaseSync`, as much of it as A2's SQLite store uses, on a Durable Object's SQL. */
class DurableDatabase {
  private readonly storage: DurableStorage

  constructor(storage: DurableStorage) {
    this.storage = storage
  }

  exec(query: string) {
    if (!SKIPPED.test(query)) this.storage.sql.exec(query).toArray()
  }

  prepare(query: string) {
    const { sql } = this.storage
    const all = (...values: unknown[]) => rows(exec(this.storage, query, values))
    return {
      all,
      get: (...values: unknown[]) => all(...values)[0],
      run: (...values: unknown[]) => {
        all(...values)
        const [changed] = sql.exec('select changes() as changes').toArray()
        return { changes: Number(changed?.changes ?? 0), lastInsertRowid: 0 }
      },
    }
  }

  transactionSync<T>(fn: () => T): T {
    return this.storage.transactionSync(fn)
  }

  close() {}
}

/** `$1` → `?1`: SQLite's numbered parameters, bound in order. */
const numbered = (text: string) => text.replace(/\$(\d+)/g, '?$1')

/** The board's tables on a Durable Object's SQL. Each of its turns runs alone, so a read is one snapshot. */
export function durableDb(storage: DurableStorage): Db {
  for (const statement of ddl()) storage.sql.exec(statement).toArray()
  const run = (query: Sql) => rows(exec(storage, numbered(query.text), query.values))
  const unclaimed = Symbol('unclaimed')
  return {
    all: async (query) => run(query),
    read: async (queries) => queries.map(run),
    async commit(claim, writes) {
      try {
        return storage.transactionSync(() => {
          if (run(claim).length === 0) throw unclaimed
          for (const write of writes) run(write)
          return true
        })
      } catch (error) {
        if (error === unclaimed) return false
        throw error
      }
    },
    async close() {},
  }
}

/** A board's log and tables, both in the Durable Object `storage` is. */
export function durableStore(storage: DurableStorage): BoardStore {
  const log = openDurable(
    () => new DurableDatabase(storage),
    () => a2Sqlite({ path: ':memory:' }),
  )
  const tables = sqlTables(durableDb(storage))
  return {
    log,
    tables,
    async close() {
      await tables.close()
      log.close()
    },
  }
}
