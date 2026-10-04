/**
 * Per-session prompt-cache affinity for CheaperInference.
 *
 * The gateway routes every request to a supplier from its marketplace;
 * consecutive requests of one conversation only get prompt-cache hits when
 * they land on the same supplier. The documented affinity knob is the
 * OpenAI-style `prompt_cache_key` body field (see
 * https://cheaperinference.com/docs#prompt-caching).
 *
 * pi's openai-completions adapter only sends `prompt_cache_key` for
 * api.openai.com base URLs or when long cache retention is requested, so this
 * extension injects it for every CheaperInference request through the
 * `before_provider_request` hook, keyed by the pi session id.
 */

/** OpenAI documents a 64-character limit for prompt_cache_key. */
export const PROMPT_CACHE_KEY_MAX_LENGTH = 64;

/**
 * Stable per-conversation cache key derived from the pi session id.
 * Returns undefined when no session id is available — the request is then
 * sent unmodified rather than with a constant key that would collapse all
 * conversations onto one affinity bucket.
 */
export function sessionCacheKey(sessionId: string | null | undefined): string | undefined {
	const id = typeof sessionId === "string" ? sessionId.trim() : "";
	if (!id) return undefined;
	return `pi-${id}`.slice(0, PROMPT_CACHE_KEY_MAX_LENGTH);
}

/**
 * Returns a replacement payload with `prompt_cache_key` set, or undefined when
 * the payload must be left untouched.
 *
 * Requests are gated on the model id (one of ours) AND the
 * `stream_options.include_usage` marker that pi's openai-completions adapter
 * sets on every request. The second check keeps same-named models on other
 * providers (e.g. built-in Anthropic Messages models) unmodified.
 */
export function injectPromptCacheKey(
	payload: unknown,
	modelIds: ReadonlySet<string>,
	key: string | undefined,
): unknown {
	if (!key) return undefined;
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	const body = payload as Record<string, unknown>;
	if (typeof body.model !== "string" || !modelIds.has(body.model)) return undefined;
	const streamOptions = body.stream_options;
	if (
		!streamOptions ||
		typeof streamOptions !== "object" ||
		(streamOptions as Record<string, unknown>).include_usage !== true
	) {
		return undefined;
	}
	const existing = body.prompt_cache_key;
	if (typeof existing === "string" && existing.trim()) return undefined;
	return { ...body, prompt_cache_key: key };
}
