import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	CHAT_COMPLETIONS_ENDPOINT,
	CatalogError,
	type CiCatalog,
	type CiModel,
	catalogToChatModels,
	fetchCatalog,
	humanizeModelName,
	isChatStreamable,
	isClaudeModel,
	parseCatalog,
	ratesFromPricing,
	resolveApiRoot,
} from "../src/catalog.ts";

const claudeRow: CiModel = {
	id: "claude-opus-4.6",
	object: "model",
	type: "text",
	provider: "anthropic",
	endpoint: CHAT_COMPLETIONS_ENDPOINT,
	supported_endpoints: [CHAT_COMPLETIONS_ENDPOINT],
	capabilities: { vision: true, video: false, reasoning: true, streaming: true, image_generation: false, image_edit: false },
	context_length: 200_000,
	max_output_tokens: 64_000,
	pricing: {
		currency: "USD",
		input_per_million: "2.500000",
		output_per_million: "12.500000",
		cache_read_input_per_million: "0.250000",
		cache_write_input_per_million: "3.125000",
		above_threshold: {
			input_token_price_threshold: 128_000,
			input_per_million: "5.000000",
			output_per_million: "25.000000",
		},
	},
};

const gptRow: CiModel = {
	id: "gpt-5.6-luna",
	object: "model",
	type: "text",
	provider: "openai",
	endpoint: CHAT_COMPLETIONS_ENDPOINT,
	supported_endpoints: [CHAT_COMPLETIONS_ENDPOINT, "/v1/responses"],
	capabilities: { vision: true, video: false, reasoning: true, streaming: true, image_generation: false, image_edit: false },
	context_length: 400_000,
	max_output_tokens: 128_000,
	pricing: {
		currency: "USD",
		input_per_million: "1.750000",
		output_per_million: "14.000000",
	},
};

function catalogOf(...models: CiModel[]): CiCatalog {
	return { models, pricingVersion: "sha256:abc", pricingCheckedAt: null, pricingUpdatedAt: null };
}

describe("parseCatalog", () => {
	it("parses the OpenAI-style data envelope with pricing metadata", () => {
		const catalog = parseCatalog({
			object: "list",
			data: [claudeRow],
			pricing_version: "sha256:deadbeef",
			pricing_checked_at: "2026-10-01T00:00:00Z",
			pricing_updated_at: "2026-09-30T00:00:00Z",
		});
		assert.equal(catalog.models.length, 1);
		assert.equal(catalog.models[0]?.id, "claude-opus-4.6");
		assert.equal(catalog.pricingVersion, "sha256:deadbeef");
		assert.equal(catalog.pricingCheckedAt, "2026-10-01T00:00:00Z");
	});

	it("tolerates bare arrays and models envelopes", () => {
		assert.equal(parseCatalog([claudeRow]).models.length, 1);
		assert.equal(parseCatalog({ models: [gptRow] }).models.length, 1);
		assert.equal(parseCatalog({}).models.length, 0);
		assert.equal(parseCatalog(null).models.length, 0);
	});

	it("skips rows without an id", () => {
		const catalog = parseCatalog([{ nope: true }, { id: "" }, { id: "kept" }]);
		assert.deepEqual(catalog.models.map((m) => m.id), ["kept"]);
	});
});

describe("ratesFromPricing", () => {
	it("parses decimal-string rates including cache rates", () => {
		const rates = ratesFromPricing(claudeRow.pricing);
		assert.deepEqual(rates && { ...rates, tiers: undefined }, {
			input: 2.5,
			output: 12.5,
			cacheRead: 0.25,
			cacheWrite: 3.125,
			tiers: undefined,
		});
	});

	it("builds a long-context tier from above_threshold", () => {
		const rates = ratesFromPricing(claudeRow.pricing);
		assert.ok(rates?.tiers?.length === 1);
		assert.equal(rates.tiers[0]?.inputTokensAbove, 128_000);
		assert.equal(rates.tiers[0]?.input, 5);
		assert.equal(rates.tiers[0]?.output, 25);
		// tier cache rates fall back to the tier input rate, never to zero
		assert.equal(rates.tiers[0]?.cacheRead, 5);
		assert.equal(rates.tiers[0]?.cacheWrite, 5);
	});

	it("falls back missing cache rates to the input rate", () => {
		const rates = ratesFromPricing(gptRow.pricing);
		assert.equal(rates?.cacheRead, 1.75);
		assert.equal(rates?.cacheWrite, 1.75);
		assert.ok(!rates?.tiers?.length);
	});

	it("accepts the legacy cache rate spellings", () => {
		const rates = ratesFromPricing({ input_per_million: "1", output_per_million: "2", cache_read_per_million: "0.1", cache_write_per_million: "0.2" });
		assert.equal(rates?.cacheRead, 0.1);
		assert.equal(rates?.cacheWrite, 0.2);
	});

	it("returns null when input or output rates are missing", () => {
		assert.equal(ratesFromPricing(undefined), null);
		assert.equal(ratesFromPricing({ output_per_million: "2" }), null);
		assert.equal(ratesFromPricing({ input_per_million: "1" }), null);
		assert.equal(ratesFromPricing({ input_per_million: "nan", output_per_million: "2" }), null);
		assert.equal(ratesFromPricing({ input_per_million: "-1", output_per_million: "2" }), null);
	});
});

describe("isChatStreamable / isClaudeModel", () => {
	it("requires text type and a chat completions endpoint", () => {
		assert.equal(isChatStreamable(claudeRow), true);
		assert.equal(
			isChatStreamable({ ...claudeRow, supported_endpoints: ["/v1/responses"] }),
			false,
		);
		assert.equal(isChatStreamable({ ...claudeRow, type: "video" }), false);
		assert.equal(isChatStreamable({ ...claudeRow, capabilities: { ...claudeRow.capabilities, streaming: false } }), false);
		assert.equal(isChatStreamable({ id: "x" }), true); // absent info defaults to usable
	});

	it("detects Claude by id prefix or provider metadata", () => {
		assert.equal(isClaudeModel(claudeRow), true);
		assert.equal(isClaudeModel({ id: "some-alias", provider: "Anthropic" }), true);
		assert.equal(isClaudeModel(gptRow), false);
	});
});

describe("humanizeModelName", () => {
	it("prettifies common ids", () => {
		assert.equal(humanizeModelName("claude-opus-4.6"), "Claude Opus 4.6");
		assert.equal(humanizeModelName("gpt-5.6-luna"), "GPT 5.6 Luna");
		assert.equal(humanizeModelName("deepseek-v3.2"), "DeepSeek V3.2");
		assert.equal(humanizeModelName("kimi-k2-thinking"), "Kimi K2 Thinking");
		assert.equal(humanizeModelName("openai/gpt-5.5-pro"), "GPT 5.5 Pro");
	});
});

describe("catalogToChatModels", () => {
	it("maps rows to pi chat model configs with full cache wiring", () => {
		const models = catalogToChatModels(catalogOf(claudeRow, gptRow));
		assert.equal(models.length, 2);
		const [claude, gpt] = models;

		assert.equal(claude?.id, "claude-opus-4.6");
		assert.equal(claude?.reasoning, true);
		assert.deepEqual(claude?.thinkingLevelMap, {
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
		assert.deepEqual(claude?.input, ["text", "image"]);
		assert.equal(claude?.contextWindow, 200_000);
		assert.equal(claude?.maxTokens, 64_000);
		assert.deepEqual(claude?.compat, {
			supportsReasoningEffort: true,
			thinkingFormat: "openai",
			cacheControlFormat: "anthropic",
			supportsLongCacheRetention: true,
		});
		assert.deepEqual(claude?.promptCache, { short: 300, long: 3600 });
		assert.equal(claude?.cost.cacheRead, 0.25);
		assert.equal(claude?.cost.cacheWrite, 3.125);

		assert.equal(gpt?.id, "gpt-5.6-luna");
		assert.deepEqual(gpt?.input, ["text", "image"]);
		assert.deepEqual(gpt?.compat, {
			supportsReasoningEffort: true,
			thinkingFormat: "openai",
			supportsLongCacheRetention: false,
		});
		assert.deepEqual(gpt?.promptCache, { short: 300 });
		assert.equal(gpt?.cost.cacheRead, 1.75);
	});

	it("filters unusable rows and unpriced rows", () => {
		const models = catalogToChatModels(
			catalogOf(
				claudeRow,
				gptRow,
				{ ...claudeRow, id: "video-gen", type: "video" },
				{ ...claudeRow, id: "pro-only", supported_endpoints: ["/v1/responses"] },
				{ ...claudeRow, id: "no-stream", capabilities: { ...claudeRow.capabilities, streaming: false } },
				{ ...claudeRow, id: "no-price", pricing: { currency: "USD" } },
			),
		);
		assert.deepEqual(models.map((m) => m.id), ["claude-opus-4.6", "gpt-5.6-luna"]);
	});

	it("falls back context and output limits and clamps maxTokens to the context window", () => {
		const models = catalogToChatModels(
			catalogOf({ id: "mystery", capabilities: { vision: false, video: false, reasoning: false, streaming: true }, pricing: { input_per_million: "1", output_per_million: "2" } }),
		);
		const model = models[0];
		assert.equal(model?.contextWindow, 128_000);
		assert.equal(model?.maxTokens, 16_384);
		assert.equal(model?.reasoning, false);
		assert.equal(model?.thinkingLevelMap, undefined);
		assert.deepEqual(model?.input, ["text"]);

		const clamped = catalogToChatModels(
			catalogOf({ ...claudeRow, id: "tiny", context_length: 4_000, max_output_tokens: 32_000 }),
		)[0];
		assert.equal(clamped?.contextWindow, 4_000);
		assert.equal(clamped?.maxTokens, 4_000);
	});

	it("deduplicates ids keeping the first row", () => {
		const models = catalogToChatModels(catalogOf(claudeRow, { ...claudeRow, id: "claude-opus-4.6" }));
		assert.equal(models.length, 1);
	});
});

describe("resolveApiRoot", () => {
	it("normalizes base urls", () => {
		assert.equal(resolveApiRoot("https://api.cheaperinference.com"), "https://api.cheaperinference.com");
		assert.equal(resolveApiRoot("https://api.cheaperinference.com/"), "https://api.cheaperinference.com");
		assert.equal(resolveApiRoot("https://api.cheaperinference.com/v1"), "https://api.cheaperinference.com");
		assert.equal(resolveApiRoot("https://api.cheaperinference.com/v1/"), "https://api.cheaperinference.com");
		assert.equal(resolveApiRoot(" http://127.0.0.1:8080/api "), "http://127.0.0.1:8080/api");
	});
});

describe("public catalog shape (GET /public/models)", () => {
	// Trimmed from the live endpoint: flat capabilities/pricing, model_type,
	// provider_name, flat above-threshold tier fields.
	const publicRow = {
		id: "aion-labs-aion-3-0",
		context_length: 128000,
		max_output_tokens: 32768,
		aliases: [],
		model_type: "text",
		endpoint: "/v1/chat/completions",
		supported_endpoints: ["/v1/chat/completions", "/v1/completions", "/v1/responses", "/v1/messages"],
		input_per_million: "1.650000",
		output_per_million: "3.300000",
		cache_read_per_million: "0.412500",
		cache_write_per_million: "1.650000",
		discount_percent: "45.00",
		provider_name: "Aion Labs",
		supports_vision: false,
		supports_video: false,
		supports_reasoning: true,
		supports_streaming: true,
		supports_image_edit: false,
		is_free: false,
		input_token_price_threshold: 128000,
		input_per_million_above_threshold: "2.200000",
		output_per_million_above_threshold: "4.400000",
	};

	it("parses flat rows: capabilities, pricing, provider_name, model_type", () => {
		const catalog = parseCatalog({ models: [publicRow] }, "public");
		assert.equal(catalog.models.length, 1);
		const model = catalog.models[0]!;
		assert.equal(model.type, "text");
		assert.equal(model.provider, "Aion Labs");
		assert.equal(model.capabilities?.reasoning, true);
		assert.equal(model.capabilities?.streaming, true);
		assert.equal(model.capabilities?.vision, false);
		const rates = ratesFromPricing(model.pricing);
		assert.deepEqual(rates && { ...rates, tiers: undefined }, {
			input: 1.65,
			output: 3.3,
			cacheRead: 0.4125,
			cacheWrite: 1.65,
			tiers: undefined,
		});
		assert.equal(rates?.tiers?.[0]?.inputTokensAbove, 128_000);
		assert.equal(rates?.tiers?.[0]?.input, 2.2);
		assert.equal(rates?.tiers?.[0]?.output, 4.4);
	});

	it("maps flat rows to chat models with full compat wiring", () => {
		const models = catalogToChatModels(parseCatalog({ models: [publicRow] }, "public"));
		assert.equal(models.length, 1);
		const model = models[0]!;
		assert.equal(model.reasoning, true);
		assert.equal(model.thinkingLevelMap?.xhigh, "xhigh");
		assert.equal(model.thinkingLevelMap?.max, "max");
		assert.deepEqual(model.input, ["text"]);
		assert.equal(model.contextWindow, 128_000);
		assert.equal(model.maxTokens, 32_768);
		assert.equal(model.cost.cacheRead, 0.4125);
		assert.equal(model.compat?.supportsReasoningEffort, true);
		assert.equal(model.compat?.thinkingFormat, "openai");
	});

	it("claude detection works via provider_name", () => {
		const catalog = parseCatalog(
			{ models: [{ ...publicRow, id: "marketplace-alias-x", provider_name: "Anthropic" }] },
			"public",
		);
		assert.equal(isClaudeModel(catalog.models[0]!), true);
		const models = catalogToChatModels(catalog);
		assert.equal(models[0]?.compat?.cacheControlFormat, "anthropic");
	});

	it("skips rows hidden with is_visible: false and rows with no pricing at all", () => {
		const catalog = parseCatalog(
			{
				models: [
					publicRow,
					{ ...publicRow, id: "hidden-model", is_visible: false },
					{ ...publicRow, id: "no-pricing", input_per_million: undefined, output_per_million: undefined },
				],
			},
			"public",
		);
		assert.deepEqual(catalog.models.map((m) => m.id), ["aion-labs-aion-3-0", "no-pricing"]);
		assert.equal(catalogToChatModels(catalog).length, 1);
	});

	it("treats an absent supports_streaming as unknown, not false", () => {
		const row = { ...publicRow };
		delete (row as Record<string, unknown>).supports_streaming;
		const models = catalogToChatModels(parseCatalog({ models: [row] }, "public"));
		assert.equal(models.length, 1);
	});

	it("filters public non-chat endpoint sets (video/image-only models)", () => {
		const catalog = parseCatalog(
			{
				models: [
					{ ...publicRow, id: "veo-thing", model_type: "video", supported_endpoints: ["/v1/videos/generations"] },
					{ ...publicRow, id: "image-thing", model_type: "image", supported_endpoints: ["/v1/images/generations"] },
				],
			},
			"public",
		);
		assert.equal(catalogToChatModels(catalog).length, 0);
	});
});

describe("fetchCatalog", () => {
	const okBody = { object: "list", data: [claudeRow], pricing_version: "sha256:1" };

	it("fetches the authenticated catalog and parses it", async () => {
		const calls: Array<{ url: string; auth: boolean }> = [];
		const catalog = await fetchCatalog({
			apiKey: "ci_live_test",
			fetchFn: async (url, init) => {
				calls.push({ url: String(url), auth: new Headers(init?.headers).has("Authorization") });
				return new Response(JSON.stringify(okBody), { status: 200 });
			},
		});
		assert.equal(catalog.source, "authenticated");
		assert.equal(catalog.models.length, 1);
		assert.deepEqual(calls, [{ url: "https://api.cheaperinference.com/v1/models", auth: true }]);
	});

	it("throws a terminal auth error on 401/403 without public fallback", async () => {
		await assert.rejects(
			fetchCatalog({
				apiKey: "ci_live_bad",
				fetchFn: async () => new Response('{"error":"bad key"}', { status: 401 }),
			}),
			(error: unknown) => error instanceof CatalogError && error.authError && error.status === 401,
		);
	});

	it("falls back to the public catalog on gateway outage", async () => {
		const urls: string[] = [];
		const catalog = await fetchCatalog({
			apiKey: "ci_live_test",
			fetchFn: async (url) => {
				urls.push(String(url));
				if (String(url).endsWith("/public/models")) {
					return new Response(JSON.stringify(okBody), { status: 200 });
				}
				return new Response("upstream unavailable", { status: 503 });
			},
		});
		assert.equal(catalog.source, "public");
		assert.equal(catalog.models.length, 1);
		assert.equal(urls.length, 2);
	});

	it("falls back to the public catalog on network failure", async () => {
		const catalog = await fetchCatalog({
			fetchFn: async (url) => {
				if (String(url).endsWith("/public/models")) {
					return new Response(JSON.stringify(okBody), { status: 200 });
				}
				throw new Error("EAI_AGAIN");
			},
		});
		assert.equal(catalog.source, "public");
	});

	it("reports the HTTP status when both endpoints fail", async () => {
		await assert.rejects(
			fetchCatalog({
				fetchFn: async () => new Response("nope", { status: 502 }),
			}),
			(error: unknown) => error instanceof CatalogError && error.status === 502,
		);
	});

	it("rejects a 200 response with no models", async () => {
		await assert.rejects(
			fetchCatalog({ fetchFn: async () => new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 }) }),
			/error|no models|CatalogError/i,
		);
	});
});
