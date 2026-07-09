import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;

// Drives pollStats() (via before_agent_start's 300ms interval) against a stubbed
// fetch that models oMLX's real auth split: /admin/api/login only accepts the
// server's main key (sub-keys get 401, matching oMLX's admin-login route), and
// /admin/api/stats only accepts the resulting session cookie, never a Bearer
// header. Exercises both the success path (main key) and the give-up path
// (sub-key that can never obtain a session).
async function run(apiKey) {
	const script = `
		const calls = { login: 0, stats: 0 };
		const stubFetch = async (input, init) => {
			const url = typeof input === "string" ? input : input.url;
			if (url.endsWith("/admin/api/login")) {
				calls.login++;
				const body = JSON.parse(init.body);
				if (body.api_key !== "main-key") {
					return new Response(JSON.stringify({ detail: "Invalid API key" }), { status: 401 });
				}
				return new Response(JSON.stringify({ success: true }), {
					status: 200,
					headers: { "set-cookie": "omlx_admin_session=tok123; HttpOnly; SameSite=Lax" },
				});
			}
			if (url.endsWith("/admin/api/stats")) {
				calls.stats++;
				const cookie = init?.headers?.Cookie ?? init?.headers?.cookie;
				if (cookie !== "omlx_admin_session=tok123") {
					return new Response(JSON.stringify({ detail: "Admin authentication required" }), { status: 401 });
				}
				return new Response(JSON.stringify({ active_models: { models: [], memory_pressure: null }, runtime_cache: { models: [] } }), { status: 200 });
			}
			return new Response("{}", { status: 200 });
		};
		globalThis.fetch = stubFetch;

		const handlers = {};
		const pi = { on: (event, handler) => { handlers[event] = handler; } };
		const ctx = { hasUI: true, ui: { setStatus: () => {}, setWorkingMessage: () => {} } };

		const extension = (await import(${JSON.stringify(indexUrl)})).default;
		extension(pi);

		await handlers.before_agent_start({ type: "before_agent_start" }, ctx);
		// let two 300ms poll ticks land
		await new Promise((r) => setTimeout(r, 700));
		await handlers.session_shutdown({ type: "session_shutdown" }, ctx);

		console.log(JSON.stringify(calls));
	`;

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		cwd: new URL("..", import.meta.url).pathname,
		env: { ...process.env, OMLX_API_KEY: apiKey },
		encoding: "utf8",
		maxBuffer: 2 * 1024 * 1024,
		timeout: 5000,
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim());
}

test("main key: logs in once, then reuses the session cookie across polls", async () => {
	const calls = await run("main-key");
	assert.equal(calls.login, 1);
	assert.ok(calls.stats >= 2, `expected multiple stats polls, got ${calls.stats}`);
});

test("sub-key: login is rejected, poller gives up instead of retrying every tick", async () => {
	const calls = await run("sub-key-cant-admin");
	assert.equal(calls.login, 1);
	assert.equal(calls.stats, 0);
});
