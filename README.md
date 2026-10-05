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
   whether it should create the file. The question names the action rather than
   asking for a bare yes ("Record progress in this directory?", offering *Create
   CURRENT_PROGRESS.md* and *Continue without it*), and the create option carries
   the card's recommendation suffix, so a client that understands it pre-selects
   and badges that choice. Only an explicit yes writes anything. A connected
   browser registers its answerer shortly after a session becomes visible, so a
   `NO_PROVIDER` outcome is retried on a short backoff instead of being treated
   as a refusal.
4. **End of every turn.** At the `agent/turn-stopping` boundary — exactly where
   the model owes no further output — one entry is appended recording what was
   asked, which tools ran (with the path or command they touched, repeats
   collapsed), and the assistant's closing text. Only the newest three turns are
   kept; see [Compaction](#compaction) below.

Conversation compaction and cleared conversations neither re-ask nor re-read:
they continue an existing session rather than starting one. Subagent children are
ignored, because an owned child has no human answerer.

## Install

From npm, into any profile:

```sh
dsh plugin --profile web add dsh-plugin-current-progress
```

From a local checkout (development):

```sh
dsh plugin --profile web add /path/to/dsh-plugin-current-progress
```

Either way the bundle patch (`cordis.patch.yml`) inserts the row and carries the
default configuration; override any of it from the profile's own patch layer.
Installing into a running Harness takes effect on reload; a profile that reports
`restart-required` needs the app restarted to load the new package generation.

## Publishing (maintainers)

The package is publish-ready: `npm pack --dry-run` shows exactly the eight files
that ship, and the version lives in `package.json`.

### 1. Put it on GitHub

```sh
# create an empty public repository named dsh-plugin-current-progress at
# https://github.com/new (no README, no .gitignore — this repo already has both)
cd ~/.dsh/plugins/current-progress
git remote add origin https://github.com/JWIMaster/dsh-plugin-current-progress.git
git push -u origin main
```

Use the SSH form (`git@github.com:JWIMaster/dsh-plugin-current-progress.git`) or
a personal access token instead of a password if HTTPS asks for credentials.

### 2. Publish to npm

```sh
npm login                     # once per machine; opens the browser
npm publish                   # unscoped name, public by default (publishConfig.access)
npm view dsh-plugin-current-progress version   # confirm what the registry serves
```

For a later release, bump with `npm version patch|minor|major` and run
`npm publish` again — the tag it creates is worth pushing (`git push --tags`).

If you would rather keep it private to a scope, rename the package to
`@yourscope/dsh-plugin-current-progress`, set
`"publishConfig": { "access": "public" }` (unchanged), publish with
`npm publish --access public`, and update the `name` in `cordis.patch.yml` to
match, because the patch inserts the row by package name.

### 3. Switch an install from a local link to the registry copy

```sh
cd ~/.dsh/profiles/web
pnpm remove dsh-plugin-current-progress
dsh plugin --profile web add dsh-plugin-current-progress
```

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
| `maxEntries` | `3` | Retention: only this many of the newest turns are kept. |
| `maxFileBytes` | `16384` | Trim oldest entries until the file fits. |
| `maxReadBytes` | `12288` | How much of an existing file to read into context. |
| `maxAskChars` | `400` | Per-message truncation for recorded user input. |
| `maxResultChars` | `700` | Per-message truncation for the closing summary — the part that tells a later session where the work stopped. |
| `maxFiles` | `6` | Files named in an entry's `Done:` line before the rest are counted. |
| `maxActions` | `3` | Commands named in an entry's `Done:` line. |
| `maxFailures` | `4` | Failed calls listed in an entry's `Failed:` section. |
| `maxTodos` | `6` | Open tasks listed in an entry's `To go:` section. |
| `maxToolDetailChars` | `72` | Truncation for a pattern or query in a recorded summary. Paths are never clipped. |
| `maxFailureChars` | `72` | Truncation for a failure reason. |
| `traceFile` | *unset* | Diagnostics: append one line per decision (attach, startup outcome, turn boundary, write result) to this file. Off when unset. |

## What an entry says

An entry is written for the next session, which has to pick the work up without
re-reading the whole transcript. It answers four questions and nothing else:

| Section | Carries |
| --- | --- |
| Heading | `### Turn 4 · 2026-10-05 21:34 GMT+11` — when, and which turn of the session. |
| `Query:` | What the human asked for, as one line. |
| `Summary:` | The assistant's closing prose — what happened and where it stopped. |
| `Done:` | What the turn left behind: the files it changed, then `ran npm test` for the commands that build, check, or ship something. |
| `Failed:` | Each call that errored with its reason: ``- `bash` npm publish — one-time password required``. The most valuable line for whoever continues the work. |
| `To go:` | Whatever the session's own task list still has open, from the latest `todo/write` snapshot. Absent when nothing is open. |

There is deliberately no tool inventory. The order calls ran in, and the calls
that only read or searched something, are activity rather than state: a session
resuming the work cannot act on "read `index.js` twelve times", but it can act on
"`index.js` changed". Read-only calls are therefore dropped entirely, an ordinary
command is dropped in favour of the notable one beside it, and a failure is kept
because it is the reason the work is unfinished.

Two details make the sections trustworthy:

- **Failures come from the log, not from prose.** A call is joined to its
  `tool/result` by `callId` — the only place the session records that a tool did
  not work — and the reason shown is the tool's own message (`cannot modify
  selftest.mjs: file has not been read — read the file, then retry`) rather than
  its error identity (`FsError`), which names the problem without helping.
- **`To go:` is never invented from prose.** It is read from the task list the
  agent maintains, which is a whole-list snapshot: completed items are simply
  absent, so nothing has to be guessed and nothing checked off reappears.

## Compaction

The file is not an archive; it is a handover note that a later session reads in
full, so it is bounded on five axes:

- **Three turns.** `maxEntries` keeps the newest three and drops the rest on the
  next write, including turns an older version left behind.
- **One entry per turn.** A turn that stops twice refreshes its entry rather
  than appending a second one, so a long session does not inflate the file.
- **A handover, not a transcript.** Reads and searches are not recorded at all,
  so a turn that inspected twenty files costs the same as one that inspected two.
- **Repeats collapse.** The tenth `read` of the same file is one line with a
  `×10` count.
- **A byte ceiling.** `maxFileBytes` drops the oldest entry until the file fits,
  even when that means fewer than `maxEntries` turns.

In practice a turn costs roughly 250–400 bytes, so the whole file stays near
1.5 KB and a fresh session pays about that much context to learn where the last
three turns left off.

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

_What happened in this directory — the last 3 turns here. Each entry records the summary, what it left behind, what failed, and what was still open; nothing here is edited by hand._

- **Directory**: `/path/to/dir`
- **Started**: 2026-10-05 20:59 GMT+11
- **Last update**: 2026-10-05 21:34 GMT+11
- **Entries**: 3 (through turn 12)

## Entries

<!-- progress:entry id="<session>:12" -->
### Turn 12 · 2026-10-05 21:34 GMT+11
Query: the card looks bad and the file is huge — fix both, then publish

Summary: Reworked the card copy and capped the file at three compact turns.
·
The publish is unfinished: it needs a one-time password, so the build is pushed
but not on the registry.

Done: `src/Header.tsx`, `src/Card.tsx` · ran npm test

Failed:
- `bash` npm publish — one-time password required

To go:
- Publish 1.3.0 _(in progress)_
- Re-check the card in a directory without a progress file
<!-- /progress:entry -->
```

Turn numbers count within one session, so `- **Entries**: 3 (through turn 12)`
appears only while every retained entry came from the same session; after a trim
that leaves entries from two sessions the header says "the most recent 3
recorded" instead, because two sessions' turn numbers are not one sequence.

Entries are delimited by their stable `id` markers, so the file is parsed back
without any other state, a repeated turn boundary refreshes its entry instead of
duplicating it, and marker-like text inside recorded content is escaped. Each
label sits on its own line: `**Asked** > text` would render the `>` as literal
text and drop the bold run, because both are inline there. An entry's identity is
read back out of its id, because that is the one part of it that survives a
re-parse — the `turn` used for retention is not stored anywhere else.

## Development

```sh
node --check index.js      # syntax
node selftest.mjs          # offline harness: 83 behaviour checks
node selftest.mjs --dump   # … and print a generated sample file
```

`selftest.mjs` drives the plugin against an in-memory Cordis context with fake
`agents`, `fs`, and `userQuestions` services, covering the ask/decline/headless
paths, the shape of the question card, the existing-file path, retention,
compaction of a verbose file left by an older version, the handover sections and
their reading order, failures joined to their calls, deduplication, and escaping.
