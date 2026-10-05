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

function harness({ initial = {}, commands = true, config = {}, create = false } = {}) {
	const files = new Map(Object.entries(initial));
	// `create` stands in for the directory having opted in already: the tests about
	// recording are not about how the file came to exist.
	if (create && !files.has('/ws/CURRENT_PROGRESS.md')) files.set('/ws/CURRENT_PROGRESS.md', defaultFile());
	const versions = new Map();
	const log = [];
	const listeners = new Map();
	const contexts = [];
	/** Registered commands, by name, in registration order. */
	const registered = new Map();

	const makeCtx = () => {
		const ctx = {
			logger: { warn: (m) => log.push(m) },
			get: (key) => {
				if (key === 'commands') {
					if (!commands) return undefined;
					return {
						register: (definition) => {
							registered.set(definition.name, definition);
							return () => registered.delete(definition.name);
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

	apply(ctx, { fileName: 'CURRENT_PROGRESS.md', ...config });
	/** Run one registered command as if its name had been typed in the composer. */
	const run = async (name, rawInput = '') => {
		const definition = registered.get(name);
		if (definition === undefined) return { kind: 'error', text: `no command named ${name}` };
		return definition.handler({ agent, rawInput, signal: new AbortController().signal, commandId: 'c1', attachments: [] });
	};
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
		registered,
		run,
		create,
		listeners
	};
}

/** The default file body, for tests that start from an opted-in directory. */
const defaultFile = () => '<!-- current-progress: {"version":1,"createdAt":"2026-01-01T00:00:00.000Z"} -->\n# Current Progress\n\n_What happened in this directory — the last 0 turns here._\n\n- **Directory**: `/ws`\n- **Entries**: 0\n\n## Entries\n\n_No turn has been recorded yet._\n';

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const userMessage = (text) => ({ id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });

// 1. A directory with no file is left alone: nothing is created, nothing asked.
{
	const h = harness();
	await tick();
	check('creates nothing on its own', !h.files.has('/ws/CURRENT_PROGRESS.md'), [...h.files.keys()].join(','));
	check('contributes no context', h.contexts.length === 0 || h.contexts[0].text().length === 0);
	check('says nothing to the user', h.log.length === 0, h.log.join(' | '));
	check('registers both commands', h.registered.has('progress-new') && h.registered.has('progress-clear'), [...h.registered.keys()].join(','));

	// Without the command, a turn records nothing.
	h.feed('turn/start', { turn: 1 });
	h.feed('user/message', userMessage('build the progress plugin'));
	h.feed('assistant/message', { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'Plugin written.' }] } });
	await h.emit('agent/turn-stopping', { turn: 1 });
	await tick(5);
	check('an unarmed session writes no file', !h.files.has('/ws/CURRENT_PROGRESS.md'));
}

// 2. /progress-new creates the file and arms the session.
{
	const h = harness();
	await tick();
	const created = await h.run('progress-new');
	check('the command reports success', created.kind === 'success', created.text);
	check('it names the file it created', created.text.includes('CURRENT_PROGRESS.md'), created.text);
	check('the file exists', h.files.has('/ws/CURRENT_PROGRESS.md'));
	check('it holds the default header', h.files.get('/ws/CURRENT_PROGRESS.md').includes('# Current Progress'));
	check('it starts with no entries', h.files.get('/ws/CURRENT_PROGRESS.md').includes('_No turn has been recorded yet._'));
	check('the header is written by this version', h.files.get('/ws/CURRENT_PROGRESS.md').includes('_What happened in this directory'), h.files.get('/ws/CURRENT_PROGRESS.md').split('\n')[3]);

	h.feed('turn/start', { turn: 1 });
	h.feed('user/message', userMessage('build the progress plugin'));
	h.feed('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: JSON.stringify({ file_path: '/ws/index.js', content: 'x' }) });
	h.feed('assistant/message', { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'Plugin written and installed.' }] } });
	await h.emit('agent/turn-stopping', { turn: 1 });
	await tick(5);
	const text = h.files.get('/ws/CURRENT_PROGRESS.md');
	check('records the query', text.includes('Query: build the progress plugin'));
	check('records what the turn left behind', text.includes('Done: `/ws/index.js`'), text.split('\n').find((l) => l.startsWith('Done:')) ?? '');
	check('records the summary', text.includes('Summary: Plugin written and installed.'), text.split('\n').find((l) => l.startsWith('Summary:')) ?? '');
	check('entry is id-marked', text.includes('<!-- progress:entry id="session-1:1" -->'));
	check('file parses back', text.includes('<!-- /progress:entry -->'));

	// Second stop of the same turn replaces rather than duplicates.
	await h.emit('agent/turn-stopping', { turn: 1 });
	await tick(5);
	const again = h.files.get('/ws/CURRENT_PROGRESS.md');
	check('one entry per turn', (again.match(/progress:entry id=/gu) ?? []).length === 1);

	// Running it again must not overwrite a file that already has history.
	const second = await h.run('progress-new');
	check('a second run changes nothing', second.kind === 'success' && h.files.get('/ws/CURRENT_PROGRESS.md') === again, second.text);
	check('it says the file already exists', /already exists/u.test(second.text), second.text);
}

// 3. /progress-clear resets the file, dropping what earlier sessions left.
{
	const h = harness({ create: true });
	await tick();
	await h.run('progress-new');
	h.feed('turn/start', { turn: 1 });
	h.feed('user/message', userMessage('first turn'));
	h.feed('assistant/message', { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'Did the first thing.' }] } });
	await h.emit('agent/turn-stopping', { turn: 1 });
	await tick(5);
	const before = h.files.get('/ws/CURRENT_PROGRESS.md');
	check('the turn was recorded before clearing', before.includes('<!-- progress:entry id="session-1:1" -->'));
	const created = JSON.parse(/<!-- current-progress: (\{[^]*?\}) -->/u.exec(before)[1]).createdAt;

	const cleared = await h.run('progress-clear');
	check('the clear reports success', cleared.kind === 'success', cleared.text);
	const after = h.files.get('/ws/CURRENT_PROGRESS.md');
	check('the entries are gone', !after.includes('progress:entry id='), after.split('\n').filter((l) => l.includes('progress:entry')).join(' | '));
	check('it is a fresh file again', after.includes('_No turn has been recorded yet._'));
	check('the cleared file is smaller', after.length < before.length, `${before.length} -> ${after.length}`);
	check('the file keeps its identity', JSON.parse(/<!-- current-progress: (\{[^]*?\}) -->/u.exec(after)[1]).createdAt === created);
	check('the entries count resets', after.includes('- **Entries**: 0'), after.split('\n').find((l) => l.includes('Entries')) ?? '');

	// The session keeps recording into the cleared file.
	h.feed('turn/start', { turn: 2 });
	h.feed('user/message', userMessage('second turn'));
	h.feed('assistant/message', { turn: 2, step: 1, message: { id: 'a2', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'Did the second thing.' }] } });
	await h.emit('agent/turn-stopping', { turn: 2 });
	await tick(5);
	const next = h.files.get('/ws/CURRENT_PROGRESS.md');
	check('the session records again after a clear', next.includes('Did the second thing.'), next.split('\n').filter((l) => l.startsWith('Summary:')).join(' | '));
	check('no earlier entry came back', !next.includes('Did the first thing.'));
}

// 4. Clearing a directory with no file creates one, and needs no prior state.
{
	const h = harness();
	await tick();
	const cleared = await h.run('progress-clear');
	check('clearing without a file still succeeds', cleared.kind === 'success', cleared.text);
	check('and leaves a valid default file', h.files.get('/ws/CURRENT_PROGRESS.md')?.includes('_No turn has been recorded yet._') === true);
}

// 5. A profile without a command service still records turns.
{
	const h = harness({ commands: false });
	await tick();
	check('a missing command service is logged', h.log.some((line) => line.includes('command service')), h.log.join(' | '));
	const attempted = await h.run('progress-new');
	check('the command is simply absent', attempted.kind === 'error', attempted.text);
}

// 6. The file already exists: it is read into context and appended to.
{
	const existing = '<!-- current-progress: {"version":1,"createdAt":"2026-01-01T00:00:00.000Z"} -->\n# Current Progress\n\n## Entries\n\n<!-- progress:entry id="old:7" -->\n### Turn 7 · earlier\n\nSummary: earlier work\n<!-- /progress:entry -->\n';
	const h = harness({ initial: { '/ws/CURRENT_PROGRESS.md': existing } });
	await tick();
	check('asks nothing when the file exists', h.log.length === 0, h.log.join(' | '));
	check('arms the session without a command', h.contexts.length > 0 && h.contexts[0].text().length > 0, 'no context');
	const context = h.contexts[0]?.text() ?? '';
	check('reads the existing file into context', context.includes('earlier work') && context.includes('/ws/CURRENT_PROGRESS.md'));

	h.feed('turn/start', { turn: 2 });
	h.feed('user/message', userMessage('continue'));
	h.feed('assistant/message', { turn: 2, step: 1, message: { id: 'a2', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'Continued.' }] } });
	await h.emit('agent/turn-stopping', { turn: 2 });
	await tick(5);
	const text = h.files.get('/ws/CURRENT_PROGRESS.md');
	check('appends without losing earlier entries', text.includes('old:7') && text.includes('session-1:2'));
	check('preserves the original creation stamp', text.includes('"createdAt":"2026-01-01T00:00:00.000Z"'));
}

// 7. Only genuine user input is recorded.
{
	const h = harness({ create: true });
	await tick();
	h.feed('turn/start', { turn: 1 });
	h.feed('user/message', { id: 'ctx', role: 'user', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'runtime context blob' }] });
	h.feed('user/message', userMessage('real ask'));
	h.feed('assistant/message', { turn: 1, step: 1, message: { id: 'a', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'ok' }] } });
	await h.emit('agent/turn-stopping', { turn: 1 });
	await tick(5);
	const text = h.files.get('/ws/CURRENT_PROGRESS.md');
	check('skips injected context messages', text.includes('Query: real ask') && !text.includes('runtime context blob'));
}

// 8. Retention keeps the newest entries.
{
	const h = harness({ create: true, config: { maxEntries: 2, maxFileBytes: 100000 } });
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

// 9. By default only the last three turns are kept, and the file stays small.
{
	const h = harness({ create: true });
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
	const h = harness({ create: true });
	await tick();
	h.feed('turn/start', { turn: 1 });
	h.feed('assistant/message', { turn: 1, step: 1, message: { id: 'a', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'oops <!-- /progress:entry -->' }] } });
	await h.emit('agent/turn-stopping', { turn: 1 });
	await tick(5);
	const text = h.files.get('/ws/CURRENT_PROGRESS.md');
	check('escapes marker-like text', !text.includes('oops <!--') && text.includes('&lt;!--'));
	check('entry count stays coherent', (text.match(/<!-- \/progress:entry -->/gu) ?? []).length === (text.match(/progress:entry id=/gu) ?? []).length);
}

// 12. The entry reads as a handover: what changed, what failed, what was read.
{
	const h = harness({ create: true });
	await tick();
	h.feed('turn/start', { turn: 1 });
	h.feed('user/message', userMessage('add the retention cap and pick a test runner'));
	h.feed('tool/call', { turn: 1, step: 1, callId: 'r1', name: 'read', arguments: JSON.stringify({ file_path: 'index.js' }) });
	h.feed('tool/call', { turn: 1, step: 1, callId: 'e1', name: 'edit', arguments: JSON.stringify({ file_path: 'index.js', old_string: 'a', new_string: 'b' }) });
	h.feed('tool/call', { turn: 1, step: 1, callId: 'e2', name: 'edit', arguments: JSON.stringify({ file_path: 'index.js', old_string: 'c', new_string: 'd' }) });
	h.feed('tool/call', { turn: 1, step: 1, callId: 'b1', name: 'bash', arguments: JSON.stringify({ command: 'npm test -- --run', description: 'run the suite' }) });
	h.feed('tool/call', { turn: 1, step: 1, callId: 'b2', name: 'bash', arguments: JSON.stringify({ command: 'npx vitest run --reporter=verbose', description: 'try vitest' }) });
	h.feed('tool/result', { turn: 1, step: 1, message: { id: 't2', role: 'tool', toolCallId: 'b2', isError: true, source: { kind: 'tool', name: 'bash' }, content: [{ type: 'text', text: 'command not found: vitest' }] }, error: { name: 'BashError', code: 'ENOENT', reason: 'vitest is not installed' } });
	h.feed('tool/call', { turn: 1, step: 1, callId: 'g1', name: 'grep', arguments: JSON.stringify({ pattern: 'maxEntries' }) });
	h.feed('assistant/message', { turn: 1, step: 1, message: { id: 'a', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'Capped retention at three turns and switched the suite to npm test.\n\nVitest is not installed, so the runner switch is unfinished.' }] } });
	h.feed('todo/write', { todos: [{ content: 'Cap retention at three turns', status: 'completed' }, { content: 'Pick a test runner for CI', status: 'in_progress' }, { content: 'Publish the release', status: 'pending' }] });
	await h.emit('agent/turn-stopping', { turn: 1 });
	await tick(5);
	const text = h.files.get('/ws/CURRENT_PROGRESS.md');
	const body = text.slice(text.indexOf('### Turn'));
	const order = ['Query:', 'Summary:', 'Done:', 'Failed:', 'To go:'].map((label) => body.indexOf(label));
	check('sections appear in reading order', order.every((at, index) => at !== -1 && (index === 0 || at > order[index - 1])), order.join(','));
	check('no label shares its line with a quote marker', !/^(Query|Summary|Done|Failed|To go): >/mu.test(text));
	check('the calling question is recorded', body.includes('Query: add the retention cap and pick a test runner'));
	check('the closing summary is the handover', body.includes('Summary: Capped retention at three turns'), body.split('\n').find((l) => l.startsWith('Summary:')) ?? '');
	check('the summary keeps its second paragraph', body.includes('Vitest is not installed, so the runner switch is unfinished.'));
	check('changed files are named once', body.includes('Done: `index.js`'), body.split('\n').find((l) => l.startsWith('Done:')) ?? '');
	check('a notable command is kept as an action', body.includes('ran npm test'), body.split('\n').find((l) => l.startsWith('Done:')) ?? '');
	check('an ordinary command is not listed as done', !body.split('\n').some((l) => l.startsWith('Done:') && l.includes('vitest')));
	check('a failure is reported with its reason', body.includes('— vitest is not installed'), body.split('\n').find((l) => l.startsWith('- `')) ?? '');
	check('the failed call is not also counted as done', !body.includes('Done: `vitest'));
	check('reads are not listed at all', !/Read:|Also/u.test(body), body.split('\n').find((l) => /Read:|Also/u.test(l)) ?? '');
	check('what is still open comes from the task list', body.includes('- Pick a test runner for CI _(in progress)_') && body.includes('- Publish the release'), body.split('\n').filter((l) => l.startsWith('- ')).join(' | '));
	check('a completed task is not reported as open', !body.includes('Cap retention at three turns'));
	check('a successful tool is not listed as failed', !body.includes('_failed_'));
}

// 13. The header says which part of the work the file covers.
{
	const h = harness({ create: true });
	await tick();
	for (const turn of [1, 2, 3, 4, 5]) {
		h.feed('turn/start', { turn });
		h.feed('user/message', userMessage(`ask ${turn}`));
		h.feed('assistant/message', { turn, step: 1, message: { id: `a${turn}`, role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: `Finished ${turn}.` }] } });
		await h.emit('agent/turn-stopping', { turn });
		await tick(2);
	}
	const text = h.files.get('/ws/CURRENT_PROGRESS.md');
	check('the header says what the file is', /_What happened in this directory/u.test(text));
	check('the header counts the retained turns', text.includes('the last 3 turns here'), text.split('\n')[3] ?? '');
	check('the header says how far the work got', text.includes('- **Entries**: 3 (through turn 5)'), text.split('\n').find((l) => l.includes('Entries')) ?? '');
}

// 14. A recorded summary keeps the markdown structures that need their line breaks.
{
	const h = harness({ create: true });
	await tick();
	h.feed('turn/start', { turn: 1 });
	h.feed('user/message', userMessage('summarise the release state'));
	h.feed('assistant/message', { turn: 1, step: 1, message: { id: 'a', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: '| Check | Result |\n| --- | --- |\n| tests | 70 pass |\n| publish | blocked |\n\nNext:\n1. run npm publish\n2. restart dsh web\n\nThe suite passed.' }] } });
	await h.emit('agent/turn-stopping', { turn: 1 });
	await tick(5);
	const text = h.files.get('/ws/CURRENT_PROGRESS.md');
	check('a table keeps one row per line', text.includes('| tests | 70 pass |\n| publish | blocked |'), text.split('\n').find((l) => l.includes('tests')) ?? '');
	check('a numbered list keeps its items apart', text.includes('1. run npm publish\n2. restart dsh web'), text.split('\n').find((l) => l.includes('npm publish')) ?? '');
	check('prose after a structure still renders', text.includes('The suite passed.'));
	check('no structure line was merged into another', !/\| [^|]*\| \|/u.test(text));

	// Prose paragraphs still collapse, so the entry stays compact.
	const h2 = harness({ create: true });
	await tick();
	h2.feed('turn/start', { turn: 1 });
	h2.feed('assistant/message', { turn: 1, step: 1, message: { id: 'b', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'A single paragraph\nwrapped by the model\nover three lines.' }] } });
	await h2.emit('agent/turn-stopping', { turn: 1 });
	await tick(5);
	const wrapped = h2.files.get('/ws/CURRENT_PROGRESS.md');
	check('a wrapped paragraph collapses to one line', wrapped.includes('Summary: A single paragraph wrapped by the model over three lines.'), wrapped.split('\n').find((l) => l.includes('single paragraph')) ?? '');
}

// 15. A restart resets the turn counter, so a range that goes backwards is dropped.
{
	const hand = '<!-- current-progress: {"version":1,"createdAt":"2026-10-05T10:21:54.439Z"} -->\n# Current Progress\n\n## Entries\n\n<!-- progress:entry id="session-1:6" -->\n### Turn 6 · earlier\n\n**Done**\n> recorded before the restart\n<!-- /progress:entry -->\n';
	const h = harness({ initial: { '/ws/CURRENT_PROGRESS.md': hand } });
	await tick();
	h.feed('turn/start', { turn: 1 });
	h.feed('user/message', userMessage('pick the work back up'));
	h.feed('assistant/message', { turn: 1, step: 1, message: { id: 'a', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'Resumed.' }] } });
	await h.emit('agent/turn-stopping', { turn: 1 });
	await tick(5);
	const text = h.files.get('/ws/CURRENT_PROGRESS.md');
	check('the earlier entry survives the restart', text.includes('> recorded before the restart'));
	check('both entries are kept', (text.match(/progress:entry id=/gu) ?? []).length === 2);
	check('a backwards turn range is not claimed', !text.includes('through turn'), text.split('\n').find((l) => l.includes('Entries')) ?? '');
	check('the header still counts the entries', text.includes('- **Entries**: 2'), text.split('\n').find((l) => l.includes('Entries')) ?? '');
}

// Sample output, for eyeballing the generated file.
if (process.argv.includes('--dump')) {
	const h = harness({ create: true });
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
	check('handover: an existing file arms the session silently', h.log.length === 0, h.log.join('|'));

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
	const h = harness({ create: true });
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
