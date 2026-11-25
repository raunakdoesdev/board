// `node:sqlite` as board's build sees it. In Node it's Node's own; while `openDurable` runs, the database
// a store opens is the one a Durable Object keeps, so A2's SQLite store runs on Cloudflare unchanged.
import type * as NodeSqlite from 'node:sqlite'

let opening: (() => unknown) | null = null

/** Runs `open`, where any database A2's SQLite store makes in it is `make()`'s. */
export function openDurable<T>(make: () => unknown, open: () => T): T {
  const outer = opening
  opening = make
  try {
    return open()
  } finally {
    opening = outer
  }
}

export class DatabaseSync {
  constructor(path: string, options?: NodeSqlite.DatabaseSyncOptions) {
    if (opening) return opening() as DatabaseSync
    const { DatabaseSync: Database } = process.getBuiltinModule('node:sqlite') as typeof NodeSqlite
    return (options === undefined ? new Database(path) : new Database(path, options)) as unknown as DatabaseSync
  }
}

export const StatementSync = class {}
