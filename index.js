/**
 * current-progress — keeps a `CURRENT_PROGRESS.md` file in each session's
 * working directory.
 *
 * Behaviour
 * ---------
 * 1. When a session starts — and when this plugin is loaded while sessions are
 *    already live — the session's working directory is checked for the progress
 *    file.
 * 2. If the file already exists it is read and contributed as dynamic model
 *    context, so the new session begins with the progress an earlier session
 *    recorded. The user is NOT asked in that case.
 * 3. If the file does not exist, the plugin asks the user, through the shared
 *    `userQuestions` waterfall (the same interactive card the
 *    `ask_user_question` tool uses), whether it should create it. Only an
 *    explicit yes creates anything.
 * 4. Once the file is armed, one entry is appended after every turn — the
 *    `agent/turn-stopping` boundary, which is exactly the point where the model
 *    owes no further output — recording what was asked, which tools ran, and
 *    how the turn ended.
 *
 * Design notes
 * ------------
 * - No dependencies: the Host is reached only through Cordis services
 *   (`agents`, `fs`, `systemPrompt`, optional `userQuestions`, optional
 *   `sandboxPolicy`) and through Node built-ins, so the bundle resolves in a
 *   profile whose `node_modules` does not contain the Harness packages.
 * - The session log stays the source of truth: the turn accumulator is a cheap
 *   in-memory fold over the `session/event` feed (no rescans, O(1) per event)
 *   that is only used to write a text file. Nothing is appended to the session.
 * - Per-agent registrations live on `agent.ctx` so agent disposal removes them,
 *   and their disposers are also held by this plugin so unloading it or
 *   reloading it through HMR removes them too.
 * - Writes go through `ctx.fs` with an explicit write intent, so the composed
 *   filesystem stays authoritative and the sandbox policy still applies.
 */

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

/** Event/context names owned by this plugin. */
const CONTEXT_NAME = 'current-progress:file';
/** Placement of the contributed context inside the runtime context snapshot. */
const CONTEXT_ORDER = 130;
/** Stable question id, echoed back in the answer batch. */
const QUESTION_ID = 'current-progress:create';
const YES_LABEL = 'Yes, create it';
const NO_LABEL = 'No, continue without it';
/** Entry markers, so the file can be parsed back without any other state. */
const ENTRY_OPEN = '<!-- progress:entry id=';
const ENTRY_CLOSE = '<!-- /progress:entry -->';
const META_PATTERN = /<!--\s*current-progress:\s*(\{[\s\S]*?\})\s*-->/u;
const ENTRY_PATTERN = /<!-- progress:entry id="([^"]*)" -->\r?\n?([\s\S]*?)<!-- \/progress:entry -->/gu;

/** Defaults; every one of them can be overridden by the patch row's `config`. */
const DEFAULTS = {
	fileName: 'CURRENT_PROGRESS.md',
	ask: true,
	askTimeoutMs: 120000,
	askAttemptsMs: [0, 300, 900, 2000, 4500, 9000],
	injectExisting: true,
	recordTurns: true,
	maxEntries: 100,
	maxFileBytes: 131072,
	maxReadBytes: 65536,
	maxAskChars: 1200,
	maxResultChars: 2400,
	maxToolLines: 20,
	// Diagnostics only: when set to a file path, the plugin appends one line per
	// decision (attach, startup outcome, turn boundary, write result) to it.
	traceFile: ''
};

export const name = 'current-progress';
export const inject = ['agents', 'fs', 'systemPrompt'];

/**
 * Mount the plugin.
 * @param ctx - Host plugin context.
 * @param config - optional `config` object from the patch row.
 */
export function apply(ctx, config = {}) {
	const cfg = resolveConfig(config, warn);
	/**
	 * Live wiring per agent *runtime*, keyed by the Agent itself rather than by
	 * its Session id: a session can be handed a new runtime (and the old one
	 * disposed) while this plugin is mounted, and a stale key must neither block
	 * the new runtime's wiring nor tear it down.
	 */
	const wired = new Map();
	let unloading = false;

	/**
	 * Release one runtime's wiring and forget it.
	 * @param agent - the exact agent runtime whose registrations are dropped.
	 */
	const unwire = (agent) => {
		const entry = wired.get(agent);
		if (entry === undefined) return;
		wired.delete(agent);
		entry.state.closed = true;
		// Cancels a pending question, a retry sleep, and in-flight file I/O, so a
		// runtime that is going away can no longer write anything.
		entry.state.controller.abort(new Error('session wiring released'));
		try {
			entry.dispose();
		} catch (error) {
			warn(`could not release session registrations: ${describe(error)}`);
		}
	};

	ctx.effect(() => () => {
		unloading = true;
		for (const agent of [...wired.keys()]) unwire(agent);
	}, 'current-progress: per-session registrations');

	ctx.on('agent/disposed', ({ agent }) => unwire(agent));
	ctx.on('agent/created', ({ agent, source }) => {
		void attach(agent, source).catch((error) => {
			warn(`session setup failed: ${describe(error)}`);
		});
	});

	// A plugin (re)loaded while sessions are already live adopts them, so the
	// capability is available without waiting for the next session.
	for (const agent of ctx.agents.list()) {
		void attach(agent, 'startup').catch((error) => {
			warn(`session setup failed: ${describe(error)}`);
		});
	}

	/**
	 * Wire one live agent's session, then run its startup check.
	 * @param agent - live agent announced by the registry.
	 * @param source - why this runtime was created.
	 */
	async function attach(agent, source) {
		if (unloading) return;
		// A compaction or a cleared conversation continues an existing session
		// rather than starting one, so it neither asks nor re-reads.
		if (source === 'compact' || source === 'clear') {
			trace(cfg, agent.id, `attach skipped: source=${source}`);
			return;
		}
		if (!isRoot(ctx, agent)) {
			trace(cfg, agent.id, 'attach skipped: not a runtime root');
			return;
		}
		if (wired.has(agent)) return;
		// A newer runtime for the same session supersedes an older one.
		for (const [other, entry] of wired) {
			if (other.id !== agent.id) continue;
			trace(cfg, agent.id, 'superseding an older runtime of the same session');
			unwire(other);
		}
		const cwd = agent.session?.header?.cwd;
		if (typeof cwd !== 'string' || cwd.length === 0) {
			warn(`session "${agent.id}" has no working directory; skipping ${cfg.fileName}`);
			trace(cfg, agent.id, 'attach skipped: no working directory');
			return;
		}

		const state = {
			agent,
			session: agent.session,
			sessionId: agent.id,
			cwd,
			cfg,
			controller: new AbortController(),
			closed: false,
			/** Whether a progress file exists that this session may append to. */
			armed: false,
			createdAt: undefined,
			/** Contributed to the runtime context snapshot; empty contributes nothing. */
			contextText: '',
			/** Last context text reported to the trace, so the trace shows participation. */
			tracedContext: undefined,
			/** Fold of the turn currently being driven. */
			current: null,
			lastTurn: 0
		};
		const entry = { state, dispose: () => {} };
		wired.set(agent, entry);
		trace(cfg, agent.id, `attach source=${source} cwd=${cwd}`);
		entry.dispose = wire(ctx, agent, state, warn);
		trace(cfg, agent.id, 'listeners + context registered');

		await startup(ctx, state);
	}

	function warn(message) {
		const logger = ctx.logger ?? console;
		try {
			(logger.warn ?? console.warn).call(logger, `current-progress: ${message}`);
		} catch {
			/* logging must never break a session */
		}
	}
}

/**
 * Register one runtime's per-agent behaviour on its own scope, so agent
 * disposal removes it.
 *
 * Each registration is isolated: a failing one (for example a prompt-context
 * name already held in that scope by a previous, not-yet-unwound generation)
 * must not roll back the others, or the plugin would silently stop observing a
 * session it had already adopted.
 *
 * @param ctx - Host plugin context.
 * @param agent - the exact agent runtime being wired.
 * @param state - that runtime's state.
 * @param warn - plugin logger.
 * @returns the disposer of every registration made here.
 */
function wire(ctx, agent, state, warn) {
	const offs = [];
	const attempt = (label, register) => {
		try {
			const off = register();
			if (typeof off === 'function') offs.push(off);
		} catch (error) {
			warn(`could not register the ${label} for session "${state.sessionId}": ${describe(error)}`);
			trace(state.cfg, state.sessionId, `${label} registration failed: ${describe(error)}`);
		}
	};
	return agent.ctx.effect(() => {
		attempt('session event listener', () => agent.ctx.on('session/event', (session, event) => {
			if (session !== state.session) return;
			try {
				fold(state, event);
			} catch (error) {
				warn(`session fold failed: ${describe(error)}`);
			}
		}));
		attempt('turn-stopping listener', () => agent.ctx.on('agent/turn-stopping', (payload) => {
			try {
				return recordTurn(ctx, state, payload);
			} catch (error) {
				warn(`could not append a turn entry: ${describe(error)}`);
				return undefined;
			}
		}));
		attempt('prompt context', () => agent.ctx.systemPrompt.context({
			name: CONTEXT_NAME,
			order: CONTEXT_ORDER,
			text: () => {
				if (state.tracedContext !== state.contextText) {
					state.tracedContext = state.contextText;
					trace(state.cfg, state.sessionId, `context provider ran: ${state.contextText.length} chars`);
				}
				return state.contextText;
			}
		}));
		return () => {
			for (const off of offs.splice(0)) {
				try {
					off();
				} catch (error) {
					warn(`could not remove a session registration: ${describe(error)}`);
				}
			}
		};
	}, 'current-progress: session wiring');
}

/**
 * Look for the progress file and read it, or ask the user to create it.
 * @param ctx - Host plugin context.
 * @param state - session state.
 */
async function startup(ctx, state) {
	const { cfg } = state;
	const signal = state.controller.signal;
	let target;
	try {
		target = await resolveTarget(ctx, state);
	} catch (error) {
		warnFor(ctx, `cannot resolve ${cfg.fileName} in "${state.cwd}": ${describe(error)}`);
		return;
	}

	let info;
	try {
		info = await ctx.fs.stat(target, signal);
	} catch (error) {
		warnFor(ctx, `cannot inspect ${target.displayPath}: ${describe(error)}`);
		return;
	}
	if (state.closed) return;

	if (info !== undefined && info.type !== 'file') {
		warnFor(ctx, `"${target.displayPath}" exists but is not a regular file; leaving it alone`);
		trace(cfg, state.sessionId, `startup: "${target.displayPath}" is not a regular file (${info.type})`);
		return;
	}

	if (info !== undefined) {
		// The file is already there: read it, never ask.
		let text = '';
		try {
			text = await ctx.fs.readText(target, signal);
		} catch (error) {
			warnFor(ctx, `cannot read ${target.displayPath}: ${describe(error)}`);
			trace(cfg, state.sessionId, `startup: read failed: ${describe(error)}`);
			return;
		}
		if (state.closed) return;
		state.armed = true;
		state.createdAt = readMeta(text)?.createdAt;
		if (cfg.injectExisting) state.contextText = existingContext(target, text, cfg);
		trace(cfg, state.sessionId, `startup: existing file read (${text.length} chars), armed, no question asked`);
		return;
	}

	trace(cfg, state.sessionId, `startup: file missing, ask=${cfg.ask}`);
	if (!cfg.ask) {
		state.contextText = createdContext(target, false);
		return;
	}

	const decision = await askToCreate(ctx, state);
	if (state.closed) return;
	if (!decision.yes) {
		warnFor(ctx, `${cfg.fileName} not created (${decision.reason})`);
		trace(cfg, state.sessionId, `startup: not created (${decision.reason})`);
		return;
	}

	try {
		await appendEntries(ctx, state, []);
	} catch (error) {
		warnFor(ctx, `cannot create ${target.displayPath}: ${describe(error)}`);
		trace(cfg, state.sessionId, `startup: create failed: ${describe(error)}`);
		return;
	}
	state.armed = true;
	state.contextText = createdContext(target, true);
	trace(cfg, state.sessionId, `startup: created and armed "${target.displayPath}"`);
}

/**
 * Ask the user whether the progress file should be created.
 *
 * The question travels the standard `userQuestions` waterfall, which is what a
 * connected client renders as an interactive card in the session's composer.
 * A browser client only registers its answerer once the session is visible, so
 * a `NO_PROVIDER` outcome is retried on a short backoff instead of being
 * treated as a refusal.
 *
 * @param ctx - Host plugin context.
 * @param state - session state.
 * @returns whether the user agreed, plus the reason when they did not.
 */
async function askToCreate(ctx, state) {
	const { cfg } = state;
	const userQuestions = ctx.get('userQuestions');
	if (userQuestions === undefined || typeof userQuestions.ask !== 'function') {
		return { yes: false, reason: 'no user-questions service in this profile' };
	}
	const questions = [{
		id: QUESTION_ID,
		header: 'Current progress',
		question: `Create ${cfg.fileName} in ${state.cwd}?`,
		detail: `This plugin appends one short entry after every turn of this session — what was asked, which tools ran, and how it ended — so a later session opened in this directory can pick up where this one stopped. Nothing is written unless you agree, and an existing ${cfg.fileName} is read instead of being recreated.`,
		options: [
			{ label: YES_LABEL, description: `Create ${cfg.fileName} now and keep it updated after each turn.` },
			{ label: NO_LABEL, description: `Work without a progress file; the question comes back at the next session start.` }
		]
	}];

	let reason = 'the question was never answered';
	for (const delay of cfg.askAttemptsMs) {
		if (delay > 0) {
			try {
				await sleep(delay, state.controller.signal);
			} catch {
				return { yes: false, reason: 'the session closed while waiting to ask' };
			}
		}
		if (state.closed) return { yes: false, reason: 'the session closed before the question was answered' };
		try {
			const answer = await userQuestions.ask({
				questions,
				agent: state.agent,
				signal: AbortSignal.any([state.controller.signal, AbortSignal.timeout(cfg.askTimeoutMs)])
			});
			return { yes: isYes(answer), reason: 'declined' };
		} catch (error) {
			if (error?.code === 'NO_PROVIDER') {
				reason = 'no interactive client answered the question';
				continue;
			}
			reason = describe(error);
			break;
		}
	}
	return { yes: false, reason };
}

/**
 * Append (or replace) one turn entry in the progress file.
 * @param ctx - Host plugin context.
 * @param state - session state.
 * @param payload - the closing turn's payload, whose `turn` is authoritative
 *   (a session adopted mid-turn never saw its `turn/start`).
 * @returns the write promise, so the serial turn boundary awaits it.
 */
function recordTurn(ctx, state, payload) {
	const current = state.current;
	state.current = null;
	const turn = typeof payload?.turn === 'number' ? payload.turn : state.lastTurn;
	trace(state.cfg, state.sessionId, `turn-stopping: turn=${turn} armed=${state.armed} recorded=${current !== null} asks=${current?.ask.length ?? 0} tools=${current?.tools.length ?? 0} result=${current?.result.length ?? 0}`);
	if (!state.armed || !state.cfg.recordTurns || current === null) return undefined;
	const entry = {
		id: `${state.sessionId}:${turn}`,
		turn,
		time: Date.now(),
		ask: current.ask,
		tools: current.tools,
		result: current.result
	};
	if (entry.ask.length === 0 && entry.tools.length === 0 && entry.result.trim().length === 0) return undefined;
	return appendEntries(ctx, state, [entry]).catch((error) => {
		warnFor(ctx, `could not update ${state.cfg.fileName}: ${describe(error)}`);
	});
}

/**
 * Re-read the file, merge the new entries, trim, and write it back.
 *
 * The file is the shared record of a directory, so every write is a
 * read-modify-write guarded by the observed version; two sessions in the same
 * directory therefore cannot silently drop each other's entries.
 *
 * @param ctx - Host plugin context.
 * @param state - session state.
 * @param entries - entries to merge in, in append order.
 */
async function appendEntries(ctx, state, entries) {
	const { cfg } = state;
	const signal = state.controller.signal;
	const target = await resolveTarget(ctx, state);
	for (let attempt = 1; ; attempt += 1) {
		const info = await ctx.fs.stat(target, signal);
		const existing = info === undefined ? undefined : await ctx.fs.readText(target, signal);
		if (state.closed) return;
		const parsed = parseFile(existing ?? '');
		const merged = mergeEntries(parsed.entries, entries, cfg);
		const kept = trimEntries(merged, cfg);
		const content = renderFile({
			fileName: cfg.fileName,
			dir: state.cwd,
			createdAt: parsed.createdAt ?? state.createdAt ?? new Date().toISOString(),
			entries: kept
		});
		const expected = info === undefined
			? { kind: 'createIfAbsent' }
			: { kind: 'replaceIfVersion', version: info.version };
		try {
			await ctx.fs.writeText(target, content, expected, signal, sandboxPolicyOf(ctx, state));
			trace(cfg, state.sessionId, `write: ${expected.kind} -> ${kept.length} entries, ${byteLength(content)} bytes (attempt ${attempt})`);
			return;
		} catch (error) {
			// Another writer (or the model) touched the file between the read and
			// the write: re-read and merge again instead of clobbering it.
			trace(cfg, state.sessionId, `write failed (attempt ${attempt}, ${expected.kind}): ${describe(error)}`);
			if (error?.code === 'FS_STALE_VERSION' && attempt < 3) continue;
			throw error;
		}
	}
}

/**
 * Resolve the progress file target inside the session's working directory.
 * @param ctx - Host plugin context.
 * @param state - session state.
 * @returns the opaque filesystem target.
 */
function resolveTarget(ctx, state) {
	return ctx.fs.resolve(join(state.cwd, state.cfg.fileName), { cwd: state.cwd, signal: state.controller.signal });
}

/**
 * Resolve the sandbox policy that governs this session, so an explicit write
 * honors the same mode and workspace root as the model's own file tools.
 * @param ctx - Host plugin context.
 * @param state - session state.
 * @returns a per-call policy, or `undefined` to let the backend decide.
 */
function sandboxPolicyOf(ctx, state) {
	try {
		return ctx.get('sandboxPolicy')?.resolve({ session: state.session });
	} catch {
		return undefined;
	}
}

/**
 * Fold one committed session event into the current turn's record.
 * @param state - session state.
 * @param event - committed session event.
 */
function fold(state, event) {
	const data = event?.data;
	switch (event?.type) {
		case 'turn/start':
			state.lastTurn = typeof data?.turn === 'number' ? data.turn : state.lastTurn;
			state.current = null;
			trace(state.cfg, state.sessionId, `fold: turn/start ${state.lastTurn}`);
			break;
		case 'user/message': {
			// Only genuine human input; injected context, instructions, and
			// runtime snapshots carry their own source kind.
			if (data?.source?.kind !== 'user') break;
			const text = textOf(data);
			if (text.length > 0) turn(state).ask.push(clip(text, state.cfg.maxAskChars));
			break;
		}
		case 'assistant/message': {
			const text = textOf(data?.message);
			if (text.length > 0) turn(state).result = clip(text, state.cfg.maxResultChars);
			break;
		}
		case 'tool/call': {
			turn(state).tools.push({
				name: typeof data?.name === 'string' && data.name.length > 0 ? data.name : 'tool',
				detail: summarizeCall(data?.arguments)
			});
			break;
		}
		default:
			break;
	}
}

/**
 * Read or create the accumulator for the open turn.
 * @param state - session state.
 * @returns the accumulator.
 */
function turn(state) {
	if (state.current === null) {
		state.current = { turn: state.lastTurn, ask: [], tools: [], result: '' };
		trace(state.cfg, state.sessionId, `fold: turn accumulator opened (turn ${state.lastTurn})`);
	}
	return state.current;
}

/** Config normalization; every unusable value falls back to its default. */
function resolveConfig(config, warn) {
	const cfg = {};
	for (const [key, fallback] of Object.entries(DEFAULTS)) {
		const value = config?.[key];
		if (value === undefined) {
			cfg[key] = Array.isArray(fallback) ? [...fallback] : fallback;
			continue;
		}
		if (Array.isArray(fallback)) {
			const list = Array.isArray(value)
				? value.filter((item) => Number.isSafeInteger(item) && item >= 0)
				: [];
			if (list.length !== (Array.isArray(value) ? value.length : -1) || list.length === 0) {
				warn(`ignoring unusable "${key}"; using the default schedule`);
				cfg[key] = [...fallback];
			} else {
				cfg[key] = list;
			}
			continue;
		}
		if (typeof fallback === 'boolean') {
			cfg[key] = typeof value === 'boolean' ? value : fallback;
			continue;
		}
		if (typeof fallback === 'number') {
			cfg[key] = Number.isSafeInteger(value) && value > 0 ? value : fallback;
			continue;
		}
		cfg[key] = typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
	}
	if (cfg.fileName.includes('/') || cfg.fileName.includes('\\')) {
		warn('fileName must be a bare file name; using the default');
		cfg.fileName = DEFAULTS.fileName;
	}
	return cfg;
}

/** Whether one live agent is a runtime root (a real session, not a child). */
function isRoot(ctx, agent) {
	try {
		return ctx.agents.roots().includes(agent);
	} catch {
		return false;
	}
}

/** Read the answer batch and decide whether the user said yes. */
function isYes(answer) {
	const item = Array.isArray(answer?.answers)
		? answer.answers.find((entry) => entry?.id === QUESTION_ID)
		: undefined;
	if (item === undefined) return false;
	if (Array.isArray(item.selected) && item.selected.includes(YES_LABEL)) return true;
	const custom = typeof item.custom === 'string' ? item.custom.trim() : '';
	return /^y(es)?\b/iu.test(custom);
}

/** Parse the plugin's metadata comment out of the file. */
function readMeta(text) {
	const match = META_PATTERN.exec(text ?? '');
	if (match === null) return undefined;
	try {
		const parsed = JSON.parse(match[1]);
		return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Parse a progress file back into its metadata and entries.
 * @param text - file contents.
 * @returns the creation stamp and the entries in file order.
 */
function parseFile(text) {
	const meta = readMeta(text);
	const entries = [];
	if (typeof text === 'string' && text.length > 0) {
		ENTRY_PATTERN.lastIndex = 0;
		for (const match of text.matchAll(ENTRY_PATTERN)) {
			entries.push({ id: match[1], body: match[2].replace(/\s+$/u, '') });
		}
	}
	return {
		createdAt: typeof meta?.createdAt === 'string' ? meta.createdAt : undefined,
		entries
	};
}

/**
 * Merge new entries into parsed ones, replacing an entry with the same id so a
 * turn that stops twice still has exactly one record.
 * @param entries - entries parsed from the file.
 * @param additions - turn records to add or refresh.
 * @param cfg - resolved plugin configuration.
 * @returns the merged entries in file order.
 */
function mergeEntries(entries, additions, cfg) {
	const merged = [...entries];
	for (const addition of additions) {
		const body = addition.body ?? renderEntryBody(addition, cfg);
		const index = merged.findIndex((entry) => entry.id === addition.id);
		const next = { id: addition.id, body };
		if (index === -1) merged.push(next);
		else merged[index] = next;
	}
	return merged;
}

/** Keep the newest entries that satisfy both retention limits. */
function trimEntries(entries, cfg) {
	let kept = entries.slice(-cfg.maxEntries);
	while (kept.length > 1 && byteLength(kept.map(renderEntry).join('\n')) > cfg.maxFileBytes) {
		kept = kept.slice(1);
	}
	return kept;
}

/** Render the complete file. */
function renderFile({ fileName, dir, createdAt, entries }) {
	const now = new Date().toISOString();
	const lines = [
		`<!-- current-progress: ${JSON.stringify({ version: 1, createdAt })} -->`,
		`# ${titleOf(fileName)}`,
		'',
		'_Maintained automatically by the DSH `current-progress` plugin. One entry is appended after every turn so that a session opened later in this directory can see what was already done; nothing here is written by hand._',
		'',
		`- **Directory**: \`${dir}\``,
		`- **Started**: ${formatTime(createdAt)}`,
		`- **Last update**: ${formatTime(now)}`,
		`- **Entries**: ${entries.length}`,
		'',
		'## Entries',
		''
	];
	if (entries.length === 0) {
		lines.push('_No turn has been recorded yet._', '');
	}
	for (const entry of entries) lines.push(renderEntry(entry), '');
	return `${lines.join('\n').replace(/\n+$/u, '')}\n`;
}

/** Render one entry with its stable id marker. */
function renderEntry(entry) {
	return `${ENTRY_OPEN}"${entry.id}" -->\n${entry.body}\n${ENTRY_CLOSE}`;
}

/** Render one entry's markdown body. */
function renderEntryBody(entry, cfg) {
	const lines = [`### Turn ${entry.turn} · ${formatTime(new Date(entry.time).toISOString())}`, ''];
	if (entry.ask.length > 0) {
		lines.push('**Asked**', '');
		for (const message of entry.ask) lines.push(...quote(message), '');
	}
	const tools = renderTools(entry.tools, cfg.maxToolLines);
	if (tools.length > 0) lines.push('**Tools**', '', ...tools, '');
	if (entry.result.trim().length > 0) lines.push('**Result**', '', ...quote(entry.result), '');
	return lines.join('\n').replace(/\n+$/u, '');
}

/** Render the tool lines, collapsing repeats and capping the list. */
function renderTools(tools, maxLines) {
	const order = [];
	const counts = new Map();
	for (const tool of tools ?? []) {
		const key = `${tool.name}\u0000${tool.detail ?? ''}`;
		if (!counts.has(key)) {
			counts.set(key, { tool, count: 0 });
			order.push(key);
		}
		counts.get(key).count += 1;
	}
	const lines = [];
	for (const key of order.slice(0, maxLines)) {
		const { tool, count } = counts.get(key);
		const detail = typeof tool.detail === 'string' && tool.detail.length > 0
			? ` — \`${tool.detail.replace(/`/gu, "'")}\``
			: '';
		lines.push(`- \`${tool.name.replace(/`/gu, "'")}\`${detail}${count > 1 ? ` (×${count})` : ''}`);
	}
	if (order.length > maxLines) lines.push(`- … and ${order.length - maxLines} more`);
	return lines;
}

/**
 * Prefix every line of a text block so it stays inside the entry, and defuse
 * anything that would look like one of this file's own markers.
 * @param text - arbitrary text recorded from the session.
 * @returns the block's lines, already quoted.
 */
function quote(text) {
	return String(text)
		.replace(/<!--/gu, '&lt;!--')
		.replace(/-->/gu, '--&gt;')
		.split('\n')
		.map((line) => (line.trim().length === 0 ? '>' : `> ${line}`));
}

/** Read a tool call's most useful argument as a one-line summary. */
function summarizeCall(argumentsText) {
	let args;
	try {
		args = JSON.parse(argumentsText ?? '');
	} catch {
		return '';
	}
	if (typeof args !== 'object' || args === null) return '';
	for (const key of ['file_path', 'filePath', 'path', 'target_file', 'notebook_path', 'filename', 'file']) {
		const value = args[key];
		if (typeof value === 'string' && value.trim().length > 0) return firstLine(value);
	}
	for (const key of ['command', 'pattern', 'query', 'url', 'description', 'prompt']) {
		const value = args[key];
		if (typeof value === 'string' && value.trim().length > 0) return clip(firstLine(value), 120);
	}
	return '';
}

/** Join the text blocks of one message. */
function textOf(message) {
	if (message === undefined || message === null || !Array.isArray(message.content)) return '';
	return message.content
		.filter((block) => block?.type === 'text' && typeof block.text === 'string')
		.map((block) => block.text)
		.join('\n')
		.trim();
}

/** The context contributed when an earlier session already left a file. */
function existingContext(target, text, cfg) {
	const body = clip(text, cfg.maxReadBytes);
	return [
		`A progress file for this directory already exists: ${target.displayPath}`,
		`It records what earlier sessions in this directory did. This is its state at the start of the current session:`,
		'',
		'<current-progress-file>',
		body,
		'</current-progress-file>',
		'',
		'The `current-progress` plugin appends to this file after each turn; you do not need to maintain it yourself.'
	].join('\n');
}

/** The context contributed when this session created (or was told about) the file. */
function createdContext(target, created) {
	return [
		created
			? `This session created ${target.displayPath}.`
			: `This session is expected to keep ${target.displayPath}, but it does not exist yet.`,
		'The `current-progress` plugin appends one entry to it after each turn, so you do not need to maintain it yourself.'
	].join(' ');
}

/** Shorten text to a character budget on a line boundary. */
function clip(text, maxChars) {
	const value = String(text ?? '');
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars).replace(/\s+$/u, '')}\n… (truncated)`;
}

/** First non-empty line, trimmed. */
function firstLine(text) {
	const line = String(text).split('\n').find((candidate) => candidate.trim().length > 0) ?? '';
	return line.trim();
}

/** Local wall-clock stamp, falling back to ISO when Intl is unavailable. */
function formatTime(iso) {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return String(iso);
	try {
		// `sv-SE` yields the sortable `YYYY-MM-DD HH:mm` shape; `dateStyle` and
		// `timeStyle` cannot be combined with `timeZoneName`.
		return new Intl.DateTimeFormat('sv-SE', {
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			timeZoneName: 'short'
		}).format(date);
	} catch {
		return date.toISOString();
	}
}

/** Derive a human title from the file name. */
function titleOf(fileName) {
	return fileName
		.replace(/\.md$/iu, '')
		.split(/[_\-\s]+/u)
		.filter((word) => word.length > 0)
		.map((word) => `${word[0].toUpperCase()}${word.slice(1).toLowerCase()}`)
		.join(' ') || 'Progress';
}

/** UTF-8 byte length of a string. */
function byteLength(text) {
	return Buffer.byteLength(text, 'utf8');
}

/** Sleep that rejects as soon as the given signal aborts. */
function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error('aborted'));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error('aborted'));
		};
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

/** Render an unknown error for a log line. */
function describe(error) {
	return error instanceof Error ? `${error.message}${error.code === undefined ? '' : ` [${error.code}]`}` : String(error);
}

/**
 * Append one diagnostic line, when the `traceFile` option names a file.
 *
 * The Host logger writes to whatever stream the process was started with, which
 * is not always reachable from the session that asks why a turn produced no
 * entry; this channel is. It is off unless configured, and it never throws.
 *
 * @param cfg - resolved plugin configuration.
 * @param subject - session id the line belongs to.
 * @param message - what happened.
 */
function trace(cfg, subject, message) {
	if (cfg.traceFile.length === 0) return;
	try {
		appendFileSync(cfg.traceFile, `${new Date().toISOString()} [${subject}] ${message}\n`);
	} catch {
		// A broken trace target must not break the plugin.
		cfg.traceFile = '';
	}
}

/** Log one warning without letting logging itself break the session. */
function warnFor(ctx, message) {
	const logger = ctx.logger ?? console;
	try {
		(logger.warn ?? console.warn).call(logger, `current-progress: ${message}`);
	} catch {
		/* ignore */
	}
}
