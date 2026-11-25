# fx

How fx's `subagent` tool maps onto the commands in [SKILL.md](../SKILL.md).

## The tool

```text
subagent(action: "message"|"wait"|"status"|"stop"|"close",
         agent, message?, instructions?, report?: "final"|"every_turn"|"never",
         model?, effort?, profile?)
```

A subagent is started by messaging a new name and continued by messaging the same name. Sending
does not wait; reports arrive as the parent's next message; siblings have no address for each
other; nesting stops at two levels. `stop` ends its current turn and keeps the subagent; `close`
removes it.

## Mapping

| fx | Board |
| --- | --- |
| `message` to a new name | `vb tasks create <channel> "…" --label role=reviewer --as lead` and a worker that claims it |
| `message` to an existing name | `vb reply <task-id> "…" --as lead`, while a worker holds the task |
| `wait` | wait on the channel for a settle event (below) |
| `status` | `vb tasks <channel> --state claimed` |
| `stop` | reply with the stop, which the worker reads at its next step; cancel only to end the task |
| `close` | `vb tasks cancel <task-id> "<reason>"` |
| `report: "final"` | `vb tasks complete <id> "<result>"` |
| `report: "every_turn"` | a reply per step, then the same `complete` |
| `report: "never"` | the same `complete`, without the progress replies |

```bash
vb wait <channel> --label 'board.task=completed|blocked|failed' --after <cursor>
```

Create and cancel with the same `--as lead`: without `manage` in the channel, a profile changes
only the tasks it made, so a task created under the reviewer's profile is `task_not_owned` when
the lead cancels it.

## What does not carry over

- **No `Monitor` tool.** Run `vb tail <channel> --json` as a long-running command and read
  what it printed; filter with `--label` so the lines are the ones you want.
- **Sibling silence is fx's rule.** The board lets any agent reply in any thread. If peers must not
  talk, that is the runtime's rule, not the board's: a run narrowed through a proxy that sets
  `x-board-can` loses the rights, not the channels.
- **Two-level nesting is fx's rule.** Board tasks nest freely; `--needs` keeps a deep tree readable.
- **`report: "never"` must still complete.** A task left open returns to `ready` when its lease
  lapses, and is done again.
- **A reply reaches a worker, not a finished task.** Once the task has completed, continue the work
  with a new task that `--needs` the old one.

## Verify

```bash
vb tasks work/ --state ready
vb tasks work/ --state claimed
vb wait work/ --label board.task=completed --after <cursor> --timeout 30m
```

Written against fx 0.0.17.
