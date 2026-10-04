import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PROMPT_CACHE_KEY_MAX_LENGTH, injectPromptCacheKey, sessionCacheKey } from "../src/cache.ts";

const MODELS = new Set(["claude-opus-4.6", "gpt-5.6-luna"]);

const chatPayload = (model: string, extra: Record<string, unknown> = {}) => ({
	model,
	messages: [{ role: "user", content: "hi" }],
	stream: true,
	stream_options: { include_usage: true },
	...extra,
});

describe("sessionCacheKey", () => {
	it("prefixes and trims the session id", () => {
		assert.equal(sessionCacheKey("abc-123"), "pi-abc-123");
		assert.equal(sessionCacheKey("  abc  "), "pi-abc");
	});

	it("clamps to the documented 64-character limit", () => {
		const key = sessionCacheKey("s".repeat(200));
		assert.equal(key?.length, PROMPT_CACHE_KEY_MAX_LENGTH);
	});

	it("returns undefined without a usable session id", () => {
		assert.equal(sessionCacheKey(undefined), undefined);
		assert.equal(sessionCacheKey(null), undefined);
		assert.equal(sessionCacheKey(""), undefined);
		assert.equal(sessionCacheKey("   "), undefined);
	});
});

describe("injectPromptCacheKey", () => {
	it("injects the session key into our own chat requests", () => {
		const payload = chatPayload("claude-opus-4.6");
		const next = injectPromptCacheKey(payload, MODELS, "pi-s1") as Record<string, unknown>;
		assert.equal(next.prompt_cache_key, "pi-s1");
		assert.equal(next.model, "claude-opus-4.6");
	});

	it("does not mutate the original payload", () => {
		const payload = chatPayload("gpt-5.6-luna");
		injectPromptCacheKey(payload, MODELS, "pi-s1");
		assert.ok(!("prompt_cache_key" in payload));
	});

	it("leaves requests to other providers untouched", () => {
		assert.equal(injectPromptCacheKey(chatPayload("claude-opus-4.6"), MODELS, "pi-s1") !== undefined, true);
		// same id but no openai-completions marker (e.g. built-in Anthropic Messages)
		const anthropicPayload = chatPayload("claude-opus-4.6", { stream_options: undefined });
		delete (anthropicPayload as Record<string, unknown>).stream_options;
		assert.equal(injectPromptCacheKey(anthropicPayload, MODELS, "pi-s1"), undefined);
		// unknown model id
		assert.equal(injectPromptCacheKey(chatPayload("gpt-4o"), MODELS, "pi-s1"), undefined);
	});

	it("preserves a prompt_cache_key already set by the adapter", () => {
		const payload = chatPayload("claude-opus-4.6", { prompt_cache_key: "adapter-set" });
		assert.equal(injectPromptCacheKey(payload, MODELS, "pi-s1"), undefined);
	});

	it("returns undefined without a key or a usable payload", () => {
		assert.equal(injectPromptCacheKey(chatPayload("claude-opus-4.6"), MODELS, undefined), undefined);
		assert.equal(injectPromptCacheKey(null, MODELS, "pi-s1"), undefined);
		assert.equal(injectPromptCacheKey("payload", MODELS, "pi-s1"), undefined);
		assert.equal(injectPromptCacheKey([1, 2], MODELS, "pi-s1"), undefined);
	});
});
