import {
  deliverSchedulerAppend,
  deliverSchedulerClear,
  type A2Scheduler,
  type DrainableServer,
  type SchedulerTask,
} from 'experimental-a2/server'
import type { DurableStorage } from '../store/durable.ts'

/** A task that keeps failing is tried this many times, waiting RETRY_MS, then twice as long each time. */
const MAX_ATTEMPTS = 8
const RETRY_MS = 5_000

/** A scheduler on a Durable Object's alarm, which the object's `alarm()` handler runs. */
export type AlarmScheduler = A2Scheduler & {
  /** Runs every task that's due, then sets the alarm for the next one. */
  alarm(): Promise<void>
}

/**
 * A scheduler that keeps its tasks in the Durable Object's SQL and wakes it with its alarm: retries,
 * leases, wake-ups, and scheduled messages keep their times across restarts and evictions.
 */
export function alarmScheduler(storage: DurableStorage): AlarmScheduler {
  storage.sql
    .exec(
      `create table if not exists board_alarms (
  key text primary key,
  due_at integer not null,
  task text not null,
  attempts integer not null default 0
)`,
    )
    .toArray()
  let servers: readonly DrainableServer[] = []

  async function run(task: SchedulerTask) {
    const server = servers.find((candidate) => candidate.contract.name === task.contract)
    if (!server) throw new Error(`no server for contract ${task.contract}: mount it with scheduler.handler(...)`)
    if (task.kind === 'drain') await server.drain(task.sessionId)
    else if (task.kind === 'append') await deliverSchedulerAppend(server, task)
    else await deliverSchedulerClear(server, task)
  }

  async function arm() {
    const [next] = storage.sql.exec('select min(due_at) as at from board_alarms').toArray()
    const at = next?.at
    if (typeof at !== 'number') return
    const set = await storage.getAlarm()
    if (set === null || set > at || set <= Date.now()) await storage.setAlarm(at)
  }

  return {
    async schedule(task) {
      // The same task asked for twice runs once, as a queue's deduplication would.
      const key = task.kind === 'drain' ? `drain\u001f${task.contract}\u001f${task.sessionId}\u001f${task.dueAt}` : task.id
      storage.sql.exec('insert or ignore into board_alarms (key, due_at, task) values (?, ?, ?)', key, task.dueAt, JSON.stringify(task)).toArray()
      await arm()
    },
    async alarm() {
      const due = storage.sql.exec('select key, task, attempts from board_alarms where due_at <= ? order by due_at', Date.now()).toArray()
      for (const { key, task, attempts } of due) {
        try {
          await run(JSON.parse(String(task)) as SchedulerTask)
          storage.sql.exec('delete from board_alarms where key = ?', key).toArray()
        } catch (error) {
          // Tried again later, as a queue retries a message, until it has failed MAX_ATTEMPTS times.
          const tries = Number(attempts) + 1
          console.error(`[board] a scheduled task failed (attempt ${tries} of ${MAX_ATTEMPTS}):`, error)
          if (tries >= MAX_ATTEMPTS) storage.sql.exec('delete from board_alarms where key = ?', key).toArray()
          else storage.sql.exec('update board_alarms set due_at = ?, attempts = ? where key = ?', Date.now() + RETRY_MS * 2 ** (tries - 1), tries, key).toArray()
        }
      }
      await arm()
    },
    handler(...mounted) {
      servers = mounted
      // Nothing calls it: the object's alarm runs the tasks.
      return async () => new Response(null, { status: 204 })
    },
  }
}
