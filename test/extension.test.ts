import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import cheaperinferenceExtension, { PROVIDER_ID } from "../extensions/index.ts";
import { saveSnapshot } from "../src/snapshot.ts";
import type { CiCatalog } from "../src/catalog.ts";

const claudeRow = {
	id: "claude-opus-4.6",
	object: "model",
	type: "text",
	provider: "anthropic",
	endpoint: "/v1/chat/completions",
	supported_endpoints: ["/v1/chat/completions"],
	capabilities: { vision: true, video: false, reasoning: true, streaming: true, image_generation: false, image_edit: false },
	context_length: 200_000,
	max_output_tokens: 64_000,
	pricing: {
		currency: "USD",
		input_per_million: "2.500000",
		output_per_million: "12.500000",
		cache_read_input_per_million: "0.250000",
		cache_write_input_per_million: "3.125000",
	},
};

const okBody = JSON.stringify({ object: "list", data: [claudeRow], pricing_version: "sha256:1" });

interface RegisteredProvider {
	name?: string;
	baseUrl?: string;
	apiKey?: string;
	api?: string;
	headers?: Record<string, string>;
	models?: Array<Record<string, unknown>>;
	oauth?: {
		name: string;
		login: (interaction: { onPrompt: (prompt: { message: string }) => Promise<string> }) => Promise<{ access: string; refresh: string; expires: number }>;
		refreshToken: (credential: { access: string }, signal?: AbortSignal) => Promise<{ access: string }>;
		getApiKey: (credential: { access: string }) => string;
	};
	refreshModels?: (context: { allowNetwork?: boolean; signal?: AbortSignal; credential?: { type?: string; key?: string; access?: unknown } }) => Promise<Array<Record<string, unknown>>>;
}

interface CapturedHandler {
	event: string;
	handler: (event: { payload: unknown }, ctx: unknown) => unknown;
}

function mockPi() {
	const providers = new Map<string, RegisteredProvider>();
	const handlers: CapturedHandler[] = [];
	return {
		providers,
		handlers,
		registerProvider(name: string, config: RegisteredProvider) {
			providers.set(name, config);
		},
		on(event: string, handler: CapturedHandler["handler"]) {
			handlers.push({ event, handler });
			return () => {};
		},
	};
}

function fetchOk(): typeof fetch {
	return (async () => new Response(okBody, { status: 200 })) as unknown as typeof fetch;
}

function fetchStatus(status: number): typeof fetch {
	return (async () => new Response("nope", { status })) as unknown as typeof fetch;
}

function sessionCtx(sessionId: string | undefined) {
	return { sessionManager: sessionId === undefined ? undefined : { getSessionId: () => sessionId } };
}

describe("cheaperinference extension", () => {
	let dir: string;
	let snapshotPath: string;

	before(async () => {
		dir = await mkdtemp(join(tmpdir(), "ci-extension-"));
		snapshotPath = join(dir, "catalog.json");
	});

	after(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("registers the provider from a live catalog with cache headers and pricing", async () => {
		const pi = mockPi();
		const warnings: string[] = [];
		await cheaperinferenceExtension(pi as never, {
			env: { CHEAPERINFERENCE_API_KEY: "ci_live_test" },
			warn: (m) => warnings.push(m),
			fetchFn: fetchOk(),
			snapshotPath: join(dir, "live-catalog.json"),
		});

		const provider = pi.providers.get(PROVIDER_ID);
		assert.ok(provider);
		assert.equal(provider.baseUrl, "https://api.cheaperinference.com/v1");
		assert.equal(provider.apiKey, "ci_live_test");
		assert.equal(provider.api, "openai-completions");
		assert.deepEqual(provider.headers, { "x-ci-prompt-cache": "on" });
		const model = provider.models?.[0];
		assert.equal(model?.id, "claude-opus-4.6");
		assert.equal(model?.reasoning, true);
		// pi only surfaces xhigh/max when thinkingLevelMap lists them; assert with
		// pi's own helper so the full effort set is contractually offered.
		assert.deepEqual(getSupportedThinkingLevels(model as never), [
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		assert.deepEqual(model?.compat, {
			supportsReasoningEffort: true,
			thinkingFormat: "openai",
			cacheControlFormat: "anthropic",
			supportsLongCacheRetention: true,
		});
		assert.deepEqual(model?.cost, {
			input: 2.5,
			output: 12.5,
			cacheRead: 0.25,
			cacheWrite: 3.125,
		});
		assert.ok(warnings.some((w) => w.includes("registered 1 models")));
	});

	it("registers without an API key from the public catalog and points at /login", async () => {
		const pi = mockPi();
		const warnings: string[] = [];
		const urls: string[] = [];
		await cheaperinferenceExtension(pi as never, {
			env: {},
			warn: (m) => warnings.push(m),
			fetchFn: (async (url: string | URL) => {
				urls.push(String(url));
				return new Response(okBody, { status: 200 });
			}) as typeof fetch,
			snapshotPath: join(dir, "public-catalog.json"),
		});

		assert.ok(pi.providers.has(PROVIDER_ID), "provider must be registered without a key");
		const provider = pi.providers.get(PROVIDER_ID);
		assert.equal(provider?.apiKey, "$CHEAPERINFERENCE_API_KEY");
		assert.ok(provider?.oauth, "oauth login flow must be present");
		assert.ok(urls.every((u) => u.endsWith("/public/models")), "no-key startup must use the public catalog");
		assert.ok(warnings.some((w) => w.includes("/login")));
	});

	it("does not register when the API key is rejected", async () => {
		const pi = mockPi();
		const warnings: string[] = [];
		await cheaperinferenceExtension(pi as never, {
			env: { CHEAPERINFERENCE_API_KEY: "ci_live_bad" },
			warn: (m) => warnings.push(m),
			fetchFn: fetchStatus(403),
			snapshotPath,
		});
		assert.equal(pi.providers.size, 0);
		assert.ok(warnings.some((w) => w.includes("API key")));
	});

	it("oauth login stores the pasted key after validating it", async () => {
		const pi = mockPi();
		const calls: Array<{ url: string; auth: boolean }> = [];
		await cheaperinferenceExtension(pi as never, {
			env: {},
			warn: () => {},
			fetchFn: (async (url: string | URL, init?: RequestInit) => {
				calls.push({ url: String(url), auth: new Headers(init?.headers).has("Authorization") });
				return new Response(okBody, { status: 200 });
			}) as typeof fetch,
			snapshotPath: join(dir, "oauth.json"),
		});
		const oauth = pi.providers.get(PROVIDER_ID)?.oauth;
		assert.ok(oauth);

		const credential = await oauth.login({
			onPrompt: async () => "  ci_live_pasted  ",
		});
		assert.equal(credential.access, "ci_live_pasted");
		assert.equal(credential.refresh, "");
		assert.ok(credential.expires > Date.now() + 365 * 24 * 60 * 60 * 1000);
		assert.equal(oauth.getApiKey(credential), "ci_live_pasted");
		assert.deepEqual(await oauth.refreshToken(credential), credential);
		// validation used the authenticated endpoint with the pasted key
		assert.ok(calls.some((c) => c.url.endsWith("/v1/models") && c.auth));
	});

	it("oauth login rejects a key the gateway refuses", async () => {
		const pi = mockPi();
		await cheaperinferenceExtension(pi as never, {
			env: {},
			warn: () => {},
			// startup catalog comes from /public/models; validation hits /v1/models with the key
			fetchFn: (async (url: string | URL) =>
				new Response(String(url).endsWith("/public/models") ? okBody : "denied", {
					status: String(url).endsWith("/public/models") ? 200 : 401,
				})) as typeof fetch,
			snapshotPath: join(dir, "oauth-bad.json"),
		});
		const oauth = pi.providers.get(PROVIDER_ID)?.oauth;
		assert.ok(oauth);
		await assert.rejects(
			oauth.login({ onPrompt: async () => "ci_live_bad" }),
			/rejected this API key/,
		);
	});

	it("oauth login accepts a key when the gateway cannot be reached", async () => {
		const pi = mockPi();
		await cheaperinferenceExtension(pi as never, {
			env: {},
			warn: () => {},
			fetchFn: (async (url: string | URL) => {
				if (String(url).endsWith("/public/models")) return new Response(okBody, { status: 200 });
				throw new Error("EAI_AGAIN");
			}) as typeof fetch,
			snapshotPath: join(dir, "oauth-offline.json"),
		});
		const oauth = pi.providers.get(PROVIDER_ID)?.oauth;
		assert.ok(oauth);
		const credential = await oauth.login({ onPrompt: async () => "ci_live_offline" });
		assert.equal(credential.access, "ci_live_offline");
	});

	it("falls back to the snapshot when the catalog is unreachable", async () => {
		const saved = await saveSnapshot(snapshotPath, {
			models: [claudeRow] as CiCatalog["models"],
			pricingVersion: "sha256:snap",
		});
		assert.equal(saved, true);

		const pi = mockPi();
		const warnings: string[] = [];
		await cheaperinferenceExtension(pi as never, {
			env: { CHEAPERINFERENCE_API_KEY: "ci_live_test" },
			warn: (m) => warnings.push(m),
			fetchFn: (async () => {
				throw new Error("EAI_AGAIN");
			}) as typeof fetch,
			snapshotPath,
		});
		assert.equal(pi.providers.size, 1);
		assert.ok(warnings.some((w) => w.includes("snapshot")));

		const stored: unknown = JSON.parse(await readFile(snapshotPath, "utf8"));
		assert.equal((stored as { catalog?: { models?: unknown[] } })?.catalog?.models?.length, 1);
	});

	it("accepts the CHEAPER_INFERENCE_API_KEY spelling and a base URL with /v1", async () => {
		const pi = mockPi();
		await cheaperinferenceExtension(pi as never, {
			env: { CHEAPER_INFERENCE_API_KEY: "ci_live_legacy", CHEAPERINFERENCE_BASE_URL: "https://api.cheaperinference.com/v1/" },
			warn: () => {},
			fetchFn: fetchOk(),
			snapshotPath: join(dir, "legacy.json"),
		});
		const provider = pi.providers.get(PROVIDER_ID);
		assert.equal(provider?.apiKey, "ci_live_legacy");
		assert.equal(provider?.baseUrl, "https://api.cheaperinference.com/v1");
	});

	it("injects the session prompt_cache_key only into its own requests", async () => {
		const pi = mockPi();
		await cheaperinferenceExtension(pi as never, {
			env: { CHEAPERINFERENCE_API_KEY: "ci_live_test" },
			warn: () => {},
			fetchFn: fetchOk(),
			snapshotPath: join(dir, "affinity.json"),
		});
		const hook = pi.handlers.find((h) => h.event === "before_provider_request");
		assert.ok(hook);

		const payload = {
			model: "claude-opus-4.6",
			messages: [],
			stream: true,
			stream_options: { include_usage: true },
		};
		const next = hook.handler({ payload }, sessionCtx("sess-42")) as Record<string, unknown>;
		assert.equal(next.prompt_cache_key, "pi-sess-42");

		// another provider's identical model id without the openai-completions marker
		const foreign = { model: "claude-opus-4.6", messages: [], stream: true };
		assert.equal(hook.handler({ payload: foreign }, sessionCtx("sess-42")), undefined);
		// no session id available
		assert.equal(hook.handler({ payload }, sessionCtx(undefined)), undefined);
		// adapter already set a key
		const preset = { ...payload, prompt_cache_key: "existing" };
		assert.equal(hook.handler({ payload: preset }, sessionCtx("sess-42")), undefined);
	});

	it("refreshModels replaces models and uses the session credential", async () => {
		const snapshotPathForRefresh = join(dir, "refresh.json");
		let respondWith = okBody;
		const authSeen: Array<string | undefined> = [];
		const pi = mockPi();
		await cheaperinferenceExtension(pi as never, {
			env: {},
			warn: () => {},
			fetchFn: (async (url: string | URL, init?: RequestInit) => {
				if (String(url).endsWith("/v1/models")) {
					authSeen.push(new Headers(init?.headers).get("Authorization") ?? undefined);
				}
				return new Response(respondWith, { status: 200 });
			}) as typeof fetch,
			snapshotPath: snapshotPathForRefresh,
		});
		const provider = pi.providers.get(PROVIDER_ID);
		assert.ok(provider?.refreshModels);

		respondWith = JSON.stringify({ object: "list", data: [claudeRow, { ...claudeRow, id: "gpt-5.6-luna", provider: "openai" }], pricing_version: "sha256:2" });
		const refreshed = await provider.refreshModels({
			allowNetwork: true,
			credential: { type: "api_key", key: "ci_live_stored" },
		});
		assert.equal(refreshed.length, 2);
		assert.ok(authSeen.includes("Bearer ci_live_stored"), "refresh must use the stored credential");

		const hook = pi.handlers.find((h) => h.event === "before_provider_request");
		assert.ok(hook);
		const payload = { model: "gpt-5.6-luna", messages: [], stream: true, stream_options: { include_usage: true } };
		const next = hook.handler({ payload }, sessionCtx("sess-9")) as Record<string, unknown>;
		assert.equal(next.prompt_cache_key, "pi-sess-9");

		// offline refresh keeps the current list
		respondWith = "unreachable";
		const kept = await provider.refreshModels({ allowNetwork: false });
		assert.equal(kept.length, 2);
		const failed = await provider.refreshModels({ allowNetwork: true });
		assert.equal(failed.length, 2);

		await rm(snapshotPathForRefresh, { force: true });
	});
});
