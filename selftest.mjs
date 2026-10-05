/**
 * Offline harness for the current-progress plugin: a fake Cordis context with
 * just the services the plugin touches, so the startup check, the ask, the
 * context contribution, and the end-of-turn write can be exercised without the
 * Harness running.
 */
import { apply } from './index.js';

let failures = 0;
const check = (label, condition, extra = '') => {
	const ok = Boolean(condition);
	if (!ok) failures += 1;
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
};

function harness({ initial = {}, answer = 'yes', ask = true, askService = true, config = {} } = {}) {
	const files = new Map(Object.entries(initial));
	const versions = new Map();
	const log = [];
	const listeners = new Map();
	const contexts = [];
	/** The question batches the plugin asked, for card-shape assertions. */
	const asked = [];
	let askCount = 0;

	const makeCtx = () => {
		const ctx = {
			logger: { warn: (m) => log.push(m) },
			get: (key) => {
				if (key === 'userQuestions') {
					if (!askService) return undefined;
					return {
						ask: async (request) => {
							askCount += 1;
							asked.push(request.questions[0]);
							log.push(`ASK: ${request.questions[0].question}`);
							// Answer the way a recommending client does: it shows the
							// first option with its "(Recommended)" suffix and returns the
							// bare label when the user submits it.
							const options = request.questions[0].options ?? [];
							const bare = (label) => String(label).replace(/\s*\((?:recommended|推荐)\)\s*$/iu, '');
							if (answer === 'yes') {
								return { answers: [{ id: request.questions[0].id, selected: [bare(options[0].label)] }] };
							}
							if (answer === 'yes-suffixed') {
								return { answers: [{ id: request.questions[0].id, selected: [options[0].label] }] };
							}
							if (answer === 'custom') {
								return { answers: [{ id: request.questions[0].id, selected: [], custom: 'yes please' }] };
							}
							return { answers: [{ id: request.questions[0].id, selected: [options.at(-1).label] }] };
						}
					};
				}
				if (key === 'sandboxPolicy') return { resolve: () => ({ mode: 'workspace-write', workspaceRoot: '/ws' }) };
				return undefined;
			},
			effect: (callback, label) => {
				const disposer = callback();
				const entry = { label, disposer };
				ctx.effects.push(entry);
				return () => {
					entry.disposed = true;
					if (typeof disposer === 'function') disposer();
				};
			},
			effects: [],
			on: (event, listener) => {
				listeners.set(event, [...(listeners.get(event) ?? []), listener]);
				return () => {
					listeners.set(event, (listeners.get(event) ?? []).filter((l) => l !== listener));
				};
			}
		};
		return ctx;
	};

	const ctx = makeCtx();
	const agentCtx = {
		effect: (callback) => {
			const disposer = callback();
			return () => {
				if (typeof disposer === 'function') disposer();
			};
		},
		on: (event, listener) => {
			const key = `agent:${event}`;
			listeners.set(key, [...(listeners.get(key) ?? []), listener]);
			return () => {
				listeners.set(key, (listeners.get(key) ?? []).filter((l) => l !== listener));
			};
		},
		systemPrompt: {
			context: (contribution) => {
				contexts.push(contribution);
				return () => {
					const index = contexts.indexOf(contribution);
					if (index !== -1) contexts.splice(index, 1);
				};
			}
		},
		inject: (deps, callback) => {
			callback(agentCtx);
		}
	};

	const session = { id: 'session-1', header: { cwd: '/ws' }, events: [] };
	const agent = { id: 'session-1', session, ctx: agentCtx };

	ctx.agents = { list: () => [agent], roots: () => [agent] };
	ctx.fs = {
		resolve: (path, opts) => Promise.resolve({ targetKey: path, displayPath: path }),
		stat: (target) => Promise.resolve(files.has(target.targetKey)
			? { version: versions.get(target.targetKey) ?? 1, type: 'file', size: files.get(target.targetKey).length }
			: undefined),
		readText: (target) => Promise.resolve(files.get(target.targetKey)),
		writeText: (target, content, expected) => {
			const exists = files.has(target.targetKey);
			if (expected?.kind === 'createIfAbsent' && exists) return Promise.reject(Object.assign(new Error('exists'), { code: 'FS_NOT_OBSERVED' }));
			if (expected?.kind === 'replaceIfVersion' && (!exists || expected.version !== (versions.get(target.targetKey) ?? 1))) {
				return Promise.reject(Object.assign(new Error('stale'), { code: 'FS_STALE_VERSION' }));
			}
			files.set(target.targetKey, content);
			versions.set(target.targetKey, (versions.get(target.targetKey) ?? 0) + 1);
			return Promise.resolve({ operation: exists ? 'update' : 'create', version: versions.get(target.targetKey) });
		}
	};

	const emit = async (event, data, extra = {}) => {
		for (const listener of listeners.get(`agent:${event}`) ?? []) {
			await listener({ agent, turn: data?.turn ?? 1, signal: new AbortController().signal, ...extra });
		}
	};
	const feed = (type, data, time = Date.now()) => {
		for (const listener of listeners.get('agent:session/event') ?? []) {
			listener(session, { type, seq: 0, time, data });
		}
	};
	/** Dispatch one plugin-level event (`agent/created`, `agent/disposed`, …). */
	const emitGlobal = (event, payload) => {
		for (const listener of listeners.get(event) ?? []) listener(payload);
	};

	apply(ctx, { fileName: 'CURRENT_PROGRESS.md', askAttemptsMs: [0], askTimeoutMs: 500, ...config, ask });
	return {
		ctx,
		agent,
		session,
		files,
		log,
		contexts,
		emit,
		feed,
		emitGlobal,
		asked,
		get askCount() { return askCount; },
		listeners
	};
}

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const userMessage = (text) => ({ id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });

// 1. No file: the plugin asks, and a "yes" creates the file.
{
	const h = harness();
	await tick();
	check('asks when the file is missing', h.askCount === 1, `asks=${h.askCount}`);
	check('creates the file after yes', h.files.has('/ws/CURRENT_PROGRESS.md'));
	check('contributes context after creating', h.contexts[0]?.text().length > 0);

	h.feed('turn/start', { turn: 1 });
	h.feed('user/message', userMessage('build the progress plugin'));
	h.feed('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: JSON.stringify({ file_path: '/ws/index.js', content: 'x' }) });
	h.feed('assistant/message', { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'Plugin written and installed.' }] } });
	await h.emit('agent/turn-stopping', { turn: 1 });
	await tick(5);
	const text = h.files.get('/ws/CURRENT_PROGRESS.md');
	check('records the ask', text.includes('> build the progress plugin'));
	check('records the tool call', text.includes('`write` — `/ws/index.js`'), text.split('\n').find((l) => l.includes('write')) ?? '');
	check('records the result', text.includes('> Plugin written and installed.'));
	check('entry is id-marked', text.includes('<!-- progress:entry id="session-1:1" -->'));
	check('file parses back', text.includes('<!-- /progress:entry -->'));

	// Second stop of the same turn replaces rather than duplicates.
	await h.emit('agent/turn-stopping', { turn: 1 });
	await tick(5);
	const again = h.files.get('/ws/CURRENT_PROGRESS.md');
	check('one entry per turn', (again.match(/progress:entry id=/gu) ?? []).length === 1);
}

// 2. The create question is shaped for the question card, not for a yes/no prompt.
{
	const h = harness({ answer: 'yes', initial: {} });
	await tick();
	const q = h.asked[0];
	check('card: asks the question once', h.asked.length === 1, `asks=${h.asked.length}`);
	check('card: verb-first question, no stray path', q?.question === 'Record progress in this directory?', q?.question);
	check('card: short eyebrow header', q?.header === 'Current progress', q?.header);
	check('card: detail explains the file and who maintains it', /CURRENT_PROGRESS\.md/u.test(q?.detail ?? '') && /never edit it by hand/u.test(q?.detail ?? ''), q?.detail);
	check('card: detail stays scannable', (q?.detail ?? '').length <= 320, `${(q?.detail ?? '').length} chars`);
	check('card: two options', q?.options?.length === 2, `${q?.options?.length}`);
	check('card: first option is marked recommended', /\(Recommended\)$/u.test(q?.options?.[0]?.label ?? ''), q?.options?.[0]?.label);
	check('card: option labels name their action', q?.options?.[0]?.label?.startsWith('Create') === true && q?.options?.[1]?.label === 'Continue without it', q?.options?.map((o) => o.label).join(' | '));
	check('card: every option carries a description', q?.options?.every((o) => typeof o.description === 'string' && o.description.length > 0) === true);
	check('card: decline says the question returns', /next time a session starts here/u.test(q?.options?.[1]?.description ?? ''), q?.options?.[1]?.description);
	check('card: the recommended option still creates the file', h.files.has('/ws/CURRENT_PROGRESS.md'));
}

// 3. A client that echoes the suffixed recommended label still counts as yes.
{
	const h = harness({ answer: 'yes-suffixed' });
	await tick();
	check('recommendation suffix is stripped when matching', h.files.has('/ws/CURRENT_PROGRESS.md'));
}

// 4. The file already exists: read it, never ask.
{
	const existing = '<!-- current-progress: {"version":1,"createdAt":"2026-01-01T00:00:00.000Z"} -->\n# Current Progress\n\n## Entries\n\n<!-- progress:entry id="old:7" -->\n### Turn 7 · earlier\n\n**Result**\n\n> earlier work\n<!-- /progress:entry -->\n';
	const h = harness({ initial: { '/ws/CURRENT_PROGRESS.md': existing } });
	await tick();
	check('does not ask when the file exists', h.askCount === 0, `asks=${h.askCount}`);
	const context = h.contexts[0]?.text() ?? '';
	check('reads the existing file into context', context.includes('> earlier work') && context.includes('/ws/CURRENT_PROGRESS.md'));

	h.feed('turn/start', { turn: 2 });
	h.feed('user/message', userMessage('continue'));
	h.feed('assistant/message', { turn: 2, step: 1, message: { id: 'a2', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'Continued.' }] } });
	await h.emit('agent/turn-stopping', { turn: 2 });
	await tick(5);
	const text = h.files.get('/ws/CURRENT_PROGRESS.md');
	check('appends without losing earlier entries', text.includes('old:7') && text.includes('session-1:2'));
	check('preserves the original creation stamp', text.includes('"createdAt":"2026-01-01T00:00:00.000Z"'));
}

// 3. Declining writes nothing, at startup and at turn end.
{
	const h = harness({ answer: 'no' });
	await tick();
	check('asks on decline path', h.askCount === 1);
	check('declining creates nothing', !h.files.has('/ws/CURRENT_PROGRESS.md'));
	h.feed('turn/start', { turn: 1 });
	h.feed('user/message', userMessage('do work'));
	h.feed('assistant/message', { turn: 1, step: 1, message: { id: 'a', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'done' }] } });
	await h.emit('agent/turn-stopping', { turn: 1 });
	await tick(5);
	check('no turn entry after declining', !h.files.has('/ws/CURRENT_PROGRESS.md'));
}

// 4. A custom typed answer counts as yes.
{
	const h = harness({ answer: 'custom' });
	await tick();
	check('typed answer creates the file', h.files.has('/ws/CURRENT_PROGRESS.md'));
}

// 5. No answerer (headless): retries once, then gives up without throwing.
{
	const h = harness({ askService: false });
	await tick();
	check('survives a profile without user-questions', !h.files.has('/ws/CURRENT_PROGRESS.md'));
	check('logs the reason', h.log.some((line) => line.includes('user-questions service')), h.log.at(-1) ?? '');
}

// 6. Only genuine user input is recorded.
{
	const h = harness();
	await tick();
	h.feed('turn/start', { turn: 1 });
	h.feed('user/message', { id: 'ctx', role: 'user', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'runtime context blob' }] });
	h.feed('user/message', userMessage('real ask'));
	h.feed('assistant/message', { turn: 1, step: 1, message: { id: 'a', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'ok' }] } });
	await h.emit('agent/turn-stopping', { turn: 1 });
	await tick(5);
	const text = h.files.get('/ws/CURRENT_PROGRESS.md');
	check('skips injected context messages', text.includes('> real ask') && !text.includes('runtime context blob'));
}

// 7. Retention keeps the newest entries.
{
	const h = harness({ config: { maxEntries: 2, maxFileBytes: 100000 } });
	await tick();
	for (const turn of [1, 2, 3]) {
		h.feed('turn/start', { turn });
		h.feed('user/message', userMessage(`ask ${turn}`));
		await h.emit('agent/turn-stopping', { turn });
		await tick(2);
	}
	const text = h.files.get('/ws/CURRENT_PROGRESS.md');
	const ids = [...text.matchAll(/progress:entry id="([^"]+)"/gu)].map((m) => m[1]);
	check('retention keeps only the newest', JSON.stringify(ids) === JSON.stringify(['session-1:2', 'session-1:3']), ids.join(','));
}

// 8. By default only the last three turns are kept, and the file stays small.
{
	const h = harness();
	await tick();
	for (const turn of [1, 2, 3, 4, 5]) {
		h.feed('turn/start', { turn });
		h.feed('user/message', userMessage(`ask ${turn}`));
		h.feed('tool/call', { turn, step: 1, callId: `c${turn}`, name: 'bash', arguments: JSON.stringify({ command: `run the ${turn}th thing with a deliberately long command line that should be clipped rather than stored in full` }) });
		h.feed('assistant/message', { turn, step: 1, message: { id: `a${turn}`, role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: `Finished ${turn}.` }] } });
		await h.emit('agent/turn-stopping', { turn });
		await tick(2);
	}
	const text = h.files.get('/ws/CURRENT_PROGRESS.md');
	const ids = [...text.matchAll(/progress:entry id="([^"]+)"/gu)].map((m) => m[1]);
	check('default retention keeps exactly three turns', JSON.stringify(ids) === JSON.stringify(['session-1:3', 'session-1:4', 'session-1:5']), ids.join(','));
	check('the header counts what survived', text.includes('- **Entries**: 3'), text.split('\n').find((l) => l.includes('Entries')) ?? '');
	check('the header says how many turns it holds', /the last 3 turns/u.test(text));
	check('five turns fit well under the byte cap', Buffer.byteLength(text, 'utf8') < 4096, `${Buffer.byteLength(text, 'utf8')} bytes`);
	check('tool details are clipped to one short line', text.split('\n').filter((l) => l.startsWith('- `bash`')).every((l) => l.length < 120), text.split('\n').find((l) => l.startsWith('- `bash`')) ?? '');
	check('a repeat count is compact', text.includes('×2') === false || /×\d/u.test(text));
	check('no label shares its line with a quote marker', !/^\*\*(Asked|Result)\*\* >/mu.test(text));
	check('paragraph breaks are marked, not blank', text.includes('\n>\n') === false || text.includes('>\n> ·\n>'), JSON.stringify(text.split('\n').slice(-6)));
}

// 9. A verbose file left by an older version is compacted on the next write.
{
	const verbose = (id, turn, filler) => `<!-- progress:entry id="${id}" -->\n### Turn ${turn} · earlier\n\n**Asked**\n\n> ${filler}\n\n**Tools**\n\n- \`read\` — \`src/${turn}.js\`\n\n**Result**\n\n> ${filler}\n<!-- /progress:entry -->`;
	const existing = `<!-- current-progress: {"version":1,"createdAt":"2026-01-01T00:00:00.000Z"} -->\n# Current Progress\n\n## Entries\n\n${[1, 2, 3, 4, 5].map((t) => verbose(`old:${t}`, t, 'x'.repeat(400))).join('\n\n')}\n`;
	const h = harness({ initial: { '/ws/CURRENT_PROGRESS.md': existing } });
	await tick();
	h.feed('turn/start', { turn: 9 });
	h.feed('user/message', userMessage('come back to this directory'));
	h.feed('assistant/message', { turn: 9, step: 1, message: { id: 'a9', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'Picked it up.' }] } });
	await h.emit('agent/turn-stopping', { turn: 9 });
	await tick(5);
	const text = h.files.get('/ws/CURRENT_PROGRESS.md');
	const ids = [...text.matchAll(/progress:entry id="([^"]+)"/gu)].map((m) => m[1]);
	check('an over-long file is trimmed to the newest three', JSON.stringify(ids) === JSON.stringify(['old:4', 'old:5', 'session-1:9']), ids.join(','));
	check('the merged file is small', Buffer.byteLength(text, 'utf8') < 4096, `${Buffer.byteLength(text, 'utf8')} bytes`);
	check('the original creation stamp survives', text.includes('"createdAt":"2026-01-01T00:00:00.000Z"'));

	// A second write of the same turn must refresh that entry, not duplicate it.
	await h.emit('agent/turn-stopping', { turn: 9 });
	await tick(5);
	const again = h.files.get('/ws/CURRENT_PROGRESS.md');
	check('a repeated turn boundary still replaces', (again.match(/progress:entry id=/gu) ?? []).length === 3, `${(again.match(/progress:entry id=/gu) ?? []).length} entries`);
}

// 10. The injected context stays bounded, which is the point of the compaction.
{
	const filler = 'x'.repeat(3000);
	const entry = (turn) => `<!-- progress:entry id="old:${turn}" -->\n### Turn ${turn} · earlier\n\n**Asked**\n> ${filler}\n\n**Result**\n> ${filler}\n<!-- /progress:entry -->`;
	const existing = `<!-- current-progress: {"version":1,"createdAt":"2026-01-01T00:00:00.000Z"} -->\n# Current Progress\n\n## Entries\n\n${[1, 2, 3].map(entry).join('\n\n')}\n`;
	const h = harness({ initial: { '/ws/CURRENT_PROGRESS.md': existing } });
	await tick();
	const injected = h.contexts[0]?.text() ?? '';
	check('a huge existing file is clipped into context', injected.length <= 12288 + 400, `${injected.length} chars`);
	check('the clipped block still closes its tag', injected.includes('</current-progress-file>'));
}

// 11. A marker-looking result cannot break the file structure.
{
	const h = harness();
	await tick();
	h.feed('turn/start', { turn: 1 });
	h.feed('assistant/message', { turn: 1, step: 1, message: { id: 'a', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'oops <!-- /progress:entry -->' }] } });
	await h.emit('agent/turn-stopping', { turn: 1 });
	await tick(5);
	const text = h.files.get('/ws/CURRENT_PROGRESS.md');
	check('escapes marker-like text', !text.includes('> oops <!--') && text.includes('&lt;!--'));
	check('entry count stays coherent', (text.match(/<!-- \/progress:entry -->/gu) ?? []).length === (text.match(/progress:entry id=/gu) ?? []).length);
}

// Sample output, for eyeballing the generated file.
if (process.argv.includes('--dump')) {
	const h = harness();
	await tick();
	h.feed('turn/start', { turn: 1 });
	h.feed('user/message', userMessage('build the progress plugin and install it'));
	h.feed('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'npm test -- --run\nsecond line' }) });
	h.feed('tool/call', { turn: 1, step: 1, callId: 'c2', name: 'read', arguments: JSON.stringify({ file_path: 'src/index.js' }) });
	h.feed('tool/call', { turn: 1, step: 1, callId: 'c3', name: 'read', arguments: JSON.stringify({ file_path: 'src/index.js' }) });
	h.feed('assistant/message', { turn: 1, step: 1, message: { id: 'a', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'Installed the plugin.\n\nIt asks at session start and appends after each turn.' }] } });
	await h.emit('agent/turn-stopping', { turn: 1 });
	await tick(5);
	console.log(`\n---SAMPLE FILE---\n${h.files.get('/ws/CURRENT_PROGRESS.md')}---END SAMPLE---`);
}

// 9. A disposed runtime stops observing at once, and the runtime that follows
//    it for the same session is wired again instead of being blocked by a stale
//    session key.
{
	const existing = '<!-- current-progress: {"version":1,"createdAt":"2026-01-01T00:00:00.000Z"} -->\n# Current Progress\n\n## Entries\n';
	const h = harness({ initial: { '/ws/CURRENT_PROGRESS.md': existing } });
	await tick();
	check('handover: existing file arms without asking', h.askCount === 0 && h.log.length === 0, h.log.join('|'));

	h.emitGlobal('agent/disposed', { agent: h.agent });
	h.feed('turn/start', { turn: 9 });
	h.feed('assistant/message', { turn: 9, step: 1, message: { id: 'a', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'stale runtime' }] } });
	await h.emit('agent/turn-stopping', { turn: 9 });
	await tick(5);
	check('handover: a disposed runtime writes nothing', !h.files.get('/ws/CURRENT_PROGRESS.md').includes('session-1:9'));

	h.emitGlobal('agent/created', { agent: h.agent, source: 'resume' });
	await tick();
	h.feed('turn/start', { turn: 10 });
	h.feed('user/message', userMessage('after the handover'));
	h.feed('assistant/message', { turn: 10, step: 1, message: { id: 'a2', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'handled' }] } });
	await h.emit('agent/turn-stopping', { turn: 10 });
	await tick(5);
	const text = h.files.get('/ws/CURRENT_PROGRESS.md');
	check('handover: the new runtime records its turn', text.includes('session-1:10'), text.split('\n').filter((l) => l.includes('entry id')).join('|'));
}

// 10. A registration that collides (a stale prompt context left in the agent's
//     scope) must not silently kill the listeners.
{
	const h = harness();
	await tick();
	let collisions = 0;
	// Occupy the plugin's context name in the same scope, then re-create the
	// runtime so the plugin wires itself again while the name is taken.
	h.ctx.agents.roots = () => [h.agent];
	h.emitGlobal('agent/disposed', { agent: h.agent });
	const occupied = [];
	const realContext = h.agent.ctx.systemPrompt.context;
	h.agent.ctx.systemPrompt.context = (contribution) => {
		if (contribution.name === 'current-progress:file') {
			collisions += 1;
			throw new Error('prompt context "current-progress:file" is already registered in this scope');
		}
		return realContext(contribution);
	};
	h.emitGlobal('agent/created', { agent: h.agent, source: 'resume' });
	await tick();
	h.agent.ctx.systemPrompt.context = realContext;
	check('collision: the context registration was attempted', collisions === 1, `collisions=${collisions}`);
	check('collision: the failure is logged, not swallowed', h.log.some((line) => line.includes('prompt context')), h.log.join('|'));

	h.feed('turn/start', { turn: 1 });
	h.feed('user/message', userMessage('still recording?'));
	await h.emit('agent/turn-stopping', { turn: 1 });
	await tick(5);
	check('collision: the listeners still record the turn', h.files.get('/ws/CURRENT_PROGRESS.md').includes('session-1:1'));
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
