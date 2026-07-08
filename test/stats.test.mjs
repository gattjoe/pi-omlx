import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;

// Drives the extension's default export against a fake pi/ctx and a stubbed
// fetch, exercising the chat/completions intercept (stream_options injection,
// SSE usage capture, pass-through) plus the turn_end status update and the
// session_shutdown fetch restore.
const script = `
	const requests = [];
	const sse =
		'data: {"usage":{"generation_tokens_per_second":42.5,"generation_duration":2}}\\n' +
		"data: [DONE]\\n";

	const stubFetch = async (input, init) => {
		const url = typeof input === "string" ? input : input.url;
		requests.push({ url, body: init?.body ?? null });
		if (url.includes("/chat/completions")) {
			return new Response(sse, { status: 200 });
		}
		return new Response("{}", { status: 200 });
	};
	globalThis.fetch = stubFetch;

	const handlers = {};
	const pi = { on: (event, handler) => { handlers[event] = handler; } };

	const statuses = [];
	const working = [];
	const ctx = {
		hasUI: true,
		ui: {
			setStatus: (key, text) => statuses.push([key, text]),
			setWorkingMessage: (msg) => working.push(msg),
		},
	};

	const extension = (await import(${JSON.stringify(indexUrl)})).default;
	extension(pi);

	await handlers.before_agent_start({ type: "before_agent_start" }, ctx);

	const res = await globalThis.fetch("http://127.0.0.1:8000/v1/chat/completions", {
		method: "POST",
		body: JSON.stringify({ model: "test-model", stream: true }),
	});
	const passthrough = await res.text();

	await handlers.turn_end({ type: "turn_end" }, ctx);
	await handlers.session_shutdown({ type: "session_shutdown" }, ctx);

	console.log(JSON.stringify({
		sentBody: requests.find((r) => r.url.includes("/chat/completions")).body,
		passthroughIntact: passthrough === sse,
		statuses,
		fetchRestored: globalThis.fetch === stubFetch,
	}));
`;

const child = spawnSync(process.execPath, ["--input-type=module"], {
	input: script,
	cwd: new URL("..", import.meta.url).pathname,
	env: { ...process.env, OMLX_API_KEY: "test-key" },
	encoding: "utf8",
	maxBuffer: 2 * 1024 * 1024,
});
assert.equal(child.status, 0, child.stderr);
const result = JSON.parse(child.stdout.trim());

test("injects stream_options.include_usage into the request body", () => {
	const body = JSON.parse(result.sentBody);
	assert.deepEqual(body.stream_options, { include_usage: true });
	assert.equal(body.model, "test-model");
});

test("passes the SSE stream through unchanged", () => {
	assert.equal(result.passthroughIntact, true);
});

test("turn_end reports throughput from the captured usage chunk", () => {
	assert.deepEqual(result.statuses.at(-1), ["omlx-tps", "↓42.5 tok/s (2s)"]);
});

test("session_shutdown restores the original fetch", () => {
	assert.equal(result.fetchRestored, true);
});
