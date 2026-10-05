# dsh-plugin-current-progress

A DeepSeek Harness Host plugin that keeps a `CURRENT_PROGRESS.md` file in each
session's working directory, so a session opened later in that directory can see
what was already done.

## Behaviour

1. **Session start.** When a session starts — and when the plugin is loaded or
   reloaded while sessions are already live — the session's working directory is
   checked for the progress file.
2. **Existing file.** If it exists, it is read and contributed to the session as
   dynamic model context (a durable runtime-context snapshot). The user is **not**
   asked.
3. **Missing file.** The plugin asks the user, through the shared `userQuestions`
   waterfall — the same interactive card the `ask_user_question` tool uses —
   whether it should create the file. Only an explicit yes writes anything. A
   connected browser registers its answerer shortly after a session becomes
   visible, so a `NO_PROVIDER` outcome is retried on a short backoff instead of
   being treated as a refusal.
4. **End of every turn.** At the `agent/turn-stopping` boundary — exactly where
   the model owes no further output — one entry is appended recording what was
   asked, which tools ran (with the path or command they touched, repeats
   collapsed), and the assistant's closing text.

Compaction and cleared conversations neither re-ask nor re-read: they continue an
existing session rather than starting one. Subagent children are ignored, because
an owned child has no human answerer.

## Install

```sh
# from a checkout of this repository
dsh plugin install /path/to/dsh-plugin-current-progress
```

or point the profile's own patch layer at it. The bundle patch
(`cordis.patch.yml`) inserts the row and carries the default configuration.

## Configuration

Every value in the patch row's `config` is optional.

| Key | Default | Meaning |
| --- | --- | --- |
| `fileName` | `CURRENT_PROGRESS.md` | File name inside the session's working directory (bare name, no separators). |
| `ask` | `true` | Ask the user when the file does not exist yet. |
| `askTimeoutMs` | `120000` | How long one question waits for an answer. |
| `askAttemptsMs` | `[0, 300, 900, 2000, 4500, 9000]` | Retry schedule while no interactive answerer is attached yet. |
| `injectExisting` | `true` | Contribute an existing file to the new session's context. |
| `recordTurns` | `true` | Append one entry per finished turn. |
| `maxEntries` | `100` | Retention: newest entries win. |
| `maxFileBytes` | `131072` | Trim oldest entries until the file fits. |
| `maxReadBytes` | `65536` | How much of an existing file to read into context. |
| `maxAskChars` | `1200` | Per-message truncation for recorded user input. |
| `maxResultChars` | `2400` | Per-message truncation for the recorded closing text. |
| `maxToolLines` | `20` | Tool lines per entry before the list is summarised. |
| `traceFile` | *unset* | Diagnostics: append one line per decision (attach, startup outcome, turn boundary, write result) to this file. Off when unset. |

## How it is built

- **No dependencies.** The Host is reached only through Cordis services
  (`agents`, `fs`, `systemPrompt`, optional `userQuestions` and `sandboxPolicy`)
  and Node built-ins, so the bundle resolves in a profile whose `node_modules`
  does not contain the Harness packages.
- **The session log stays the source of truth.** The per-turn record is a cheap
  in-memory fold over the `session/event` feed (O(1) per event, no rescans) used
  only to write a text file; nothing is appended to the session.
- **Registrations are owned.** Per-agent listeners and the prompt contribution
  live in one `agent.ctx.effect()`, are keyed by agent, and are released both on
  agent disposal and on plugin unload/HMR reload.
- **Writes are guarded.** Every write re-reads the file, merges by entry id,
  trims to the retention limits, and writes through `ctx.fs` with an explicit
  write intent plus the session's own sandbox policy — so two sessions in one
  directory cannot silently drop each other's entries.

## File format

```markdown
<!-- current-progress: {"version":1,"createdAt":"2026-10-05T09:59:52.904Z"} -->
# Current Progress

_Maintained automatically by the DSH `current-progress` plugin. …_

- **Directory**: `/path/to/dir`
- **Started**: 2026-10-05 20:59 GMT+11
- **Last update**: 2026-10-05 21:34 GMT+11
- **Entries**: 1

## Entries

<!-- progress:entry id="<session>:3" -->
### Turn 3 · 2026-10-05 21:34 GMT+11

**Asked**

> fix the header layout

**Tools**

- `edit` — `src/Header.tsx`

**Result**

> Reflowed the header grid …
<!-- /progress:entry -->
```

Entries are delimited by their stable `id` markers, so the file is parsed back
without any other state, a repeated turn boundary refreshes its entry instead of
duplicating it, and marker-like text inside recorded content is escaped.

## Development

```sh
node --check index.js      # syntax
node selftest.mjs          # offline harness: 23 behaviour checks
node selftest.mjs --dump   # … and print a generated sample file
```

`selftest.mjs` drives the plugin against an in-memory Cordis context with fake
`agents`, `fs`, and `userQuestions` services, covering the ask/decline/headless
paths, the existing-file path, retention, deduplication, and escaping.
