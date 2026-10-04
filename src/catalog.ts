/**
 * CheaperInference model catalog client.
 *
 * Maps the authenticated `GET /v1/models` catalog (see
 * https://cheaperinference.com/api/openapi.json) onto pi provider chat-model
 * configs. Parsing is conservative: rows without parseable input/output rates
 * are skipped rather than guessed, so a mapped model always carries complete
 * cost metadata, and missing cache rates fall back to the base input rate —
 * never to zero and never below full input price.
 */

export const DEFAULT_API_ROOT = "https://api.cheaperinference.com";
export const DEFAULT_CATALOG_TIMEOUT_MS = 8_000;
export const FALLBACK_CONTEXT_WINDOW = 128_000;
export const FALLBACK_MAX_OUTPUT_TOKENS = 16_384;

/** Anthropic prompt-cache lifetime (seconds) for the default short retention tier. */
export const CLAUDE_CACHE_SHORT_SECONDS = 300;
/** Anthropic long-retention cache lifetime (seconds) — only used with an explicit 1h TTL. */
export const CLAUDE_CACHE_LONG_SECONDS = 3600;
/** OpenAI-style implicit prompt caches typically persist minutes, not hours. */
export const GENERIC_CACHE_SHORT_SECONDS = 300;

export const CHAT_COMPLETIONS_ENDPOINT = "/v1/chat/completions";

/** Only endpoints pi can drive are advertised; see README for Pro-model caveats. */
export const SUPPORTED_ENDPOINTS = ["/v1/chat/completions"];

// ---------------------------------------------------------------------------
// Catalog wire types (subset of the published OpenAPI schema)
// ---------------------------------------------------------------------------

export interface CiCapabilities {
	vision: boolean;
	video: boolean;
	reasoning: boolean;
	streaming: boolean;
	image_generation?: boolean;
	image_edit?: boolean;
}

export interface CiAboveThreshold {
	input_token_price_threshold?: number | null;
	input_per_million?: string | number;
	output_per_million?: string | number;
	cache_read_input_per_million?: string | number | null;
	cache_read_per_million?: string | number | null;
	cache_write_input_per_million?: string | number | null;
	cache_write_per_million?: string | number | null;
}

export interface CiPricing {
	currency?: string;
	input_per_million?: string | number;
	output_per_million?: string | number;
	cache_read_input_per_million?: string | number | null;
	cache_read_per_million?: string | number | null;
	cache_write_input_per_million?: string | number | null;
	cache_write_per_million?: string | number | null;
	input_token_price_threshold?: number | null;
	above_threshold?: CiAboveThreshold | null;
}

export interface CiModel {
	id: string;
	object?: string;
	type?: string;
	provider?: string | null;
	owned_by?: string;
	endpoint?: string;
	supported_endpoints?: string[];
	capabilities?: Partial<CiCapabilities>;
	context_length?: number | null;
	max_output_tokens?: number | null;
	pricing?: CiPricing;
}

export interface CiCatalog {
	models: CiModel[];
	pricingVersion?: string;
	pricingCheckedAt?: string | null;
	pricingUpdatedAt?: string | null;
	/** Which endpoint produced the catalog: "authenticated" or "public". */
	source?: "authenticated" | "public";
}

// ---------------------------------------------------------------------------
// pi model config types (structural subset of pi's ProviderChatModelConfig)
// ---------------------------------------------------------------------------

export interface ChatModelCostRates {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface ChatModelCost extends ChatModelCostRates {
	/** Highest matching input threshold applies to the full request (pi semantics). */
	tiers?: Array<ChatModelCostRates & { inputTokensAbove: number }>;
}

export interface ChatModelCompat {
	supportsReasoningEffort?: boolean;
	thinkingFormat?: "openai";
	/** Anthropic-style cache_control markers applied by pi to system, last tool and last message. */
	cacheControlFormat?: "anthropic";
	supportsLongCacheRetention?: boolean;
}

export interface ChatModelConfig {
	id: string;
	name: string;
	reasoning: boolean;
	/**
	 * Identity mapping for every effort level. pi only offers xhigh/max in its
	 * thinking-level UI when thinkingLevelMap lists them explicitly; without a
	 * map, minimal/low/medium/high still work but the two highest are hidden.
	 */
	thinkingLevelMap?: Record<"minimal" | "low" | "medium" | "high" | "xhigh" | "max", string>;
	input: Array<"text" | "image">;
	cost: ChatModelCost;
	contextWindow: number;
	maxTokens: number;
	/** Best-effort cache lifetime per retention tier; lets pi keep caches warm. */
	promptCache?: { short?: number; long?: number };
	compat?: ChatModelCompat;
	headers?: Record<string, string>;
}

/** CheaperInference accepts pi's full effort set verbatim as reasoning_effort. */
export const IDENTITY_THINKING_LEVEL_MAP = {
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
} as const;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const toRate = (value: unknown): number | null => {
	const n = typeof value === "string" ? Number(value.trim()) : typeof value === "number" ? value : NaN;
	return Number.isFinite(n) && n >= 0 ? n : null;
};

const toPositiveInt = (value: unknown): number | null => {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	return Number.isInteger(n) && n > 0 ? n : null;
};

const asString = (value: unknown): string | null =>
	typeof value === "string" && value.trim() ? value.trim() : null;

/** Cache rate fields have had two documented spellings; accept both. */
function cacheRate(pricing: CiPricing, kind: "read" | "write"): number | null {
	const primary = kind === "read" ? "cache_read_input_per_million" : "cache_write_input_per_million";
	const legacy = kind === "read" ? "cache_read_per_million" : "cache_write_per_million";
	const value = pricing[primary] ?? pricing[legacy];
	return value === undefined || value === null ? null : toRate(value);
}

function parseCapabilities(value: unknown): Partial<CiCapabilities> | undefined {
	if (!value || typeof value !== "object") return undefined;
	const caps = value as Record<string, unknown>;
	return {
		vision: caps.vision === true,
		video: caps.video === true,
		reasoning: caps.reasoning === true,
		streaming: caps.streaming === true,
		image_generation: caps.image_generation === true,
		image_edit: caps.image_edit === true,
	};
}

/**
 * The public `/public/models` view flattens capabilities onto the row as
 * `supports_*` booleans. Only fields that are present are set so an absent
 * `supports_streaming` stays "unknown" (and does not exclude the model).
 */
function capabilitiesFromFlatRow(r: Record<string, unknown>): Partial<CiCapabilities> | undefined {
	const flags: Array<[keyof CiCapabilities, string]> = [
		["vision", "supports_vision"],
		["video", "supports_video"],
		["reasoning", "supports_reasoning"],
		["streaming", "supports_streaming"],
		["image_edit", "supports_image_edit"],
	];
	const out: Partial<CiCapabilities> = {};
	let present = false;
	for (const [key, source] of flags) {
		if (r[source] === undefined) continue;
		out[key] = r[source] === true;
		present = true;
	}
	return present ? out : undefined;
}

/**
 * The public view also flattens pricing onto the row (top-level
 * `input_per_million`, `cache_read_per_million`, and `*_above_threshold`
 * tier fields) instead of the authenticated view's nested `pricing` object.
 * Normalize both spellings; rates are validated later by toRate.
 */
function pricingFromRow(r: Record<string, unknown>): CiPricing | undefined {
	if (r.pricing && typeof r.pricing === "object") return r.pricing as CiPricing;
	const flatKeys = [
		"input_per_million",
		"output_per_million",
		"cache_read_per_million",
		"cache_write_per_million",
		"input_token_price_threshold",
		"input_per_million_above_threshold",
		"output_per_million_above_threshold",
	];
	if (!flatKeys.some((key) => r[key] !== undefined)) return undefined;
	const threshold = toPositiveInt(r.input_token_price_threshold);
	const hasTier = r.input_per_million_above_threshold !== undefined || r.output_per_million_above_threshold !== undefined;
	return {
		input_per_million: r.input_per_million as CiPricing["input_per_million"],
		output_per_million: r.output_per_million as CiPricing["output_per_million"],
		cache_read_per_million: (r.cache_read_per_million ?? undefined) as CiPricing["cache_read_per_million"],
		cache_write_per_million: (r.cache_write_per_million ?? undefined) as CiPricing["cache_write_per_million"],
		input_token_price_threshold: threshold,
		above_threshold: hasTier
			? {
					input_token_price_threshold: threshold,
					input_per_million: r.input_per_million_above_threshold as CiAboveThreshold["input_per_million"],
					output_per_million: r.output_per_million_above_threshold as CiAboveThreshold["output_per_million"],
				}
			: null,
	};
}

function parseModelRow(row: unknown): CiModel | null {
	if (!row || typeof row !== "object") return null;
	const r = row as Record<string, unknown>;
	if (r.is_visible === false) return null;
	const id = asString(r.id) ?? asString(r.model_id);
	if (!id) return null;
	const capabilities = parseCapabilities(r.capabilities) ?? capabilitiesFromFlatRow(r);
	return {
		id,
		object: asString(r.object) ?? undefined,
		type: asString(r.type) ?? asString(r.model_type) ?? undefined,
		provider: asString(r.provider) ?? asString(r.provider_name),
		owned_by: asString(r.owned_by) ?? undefined,
		endpoint: asString(r.endpoint) ?? undefined,
		supported_endpoints: Array.isArray(r.supported_endpoints)
			? r.supported_endpoints.filter((s): s is string => typeof s === "string")
			: undefined,
		capabilities,
		context_length: toPositiveInt(r.context_length),
		max_output_tokens: toPositiveInt(r.max_output_tokens),
		pricing: pricingFromRow(r),
	};
}

function extractRows(payload: unknown): unknown[] {
	if (Array.isArray(payload)) return payload;
	if (!payload || typeof payload !== "object") return [];
	const container = payload as Record<string, unknown>;
	if (Array.isArray(container.data)) return container.data;
	if (Array.isArray(container.models)) return container.models;
	return [];
}

export function parseCatalog(payload: unknown, source?: CiCatalog["source"]): CiCatalog {
	const models: CiModel[] = [];
	for (const row of extractRows(payload)) {
		const model = parseModelRow(row);
		if (model) models.push(model);
	}
	const meta = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
	return {
		models,
		pricingVersion: asString(meta.pricing_version) ?? undefined,
		pricingCheckedAt: asString(meta.pricing_checked_at),
		pricingUpdatedAt: asString(meta.pricing_updated_at),
		source,
	};
}

// ---------------------------------------------------------------------------
// Mapping catalog rows -> pi chat model configs
// ---------------------------------------------------------------------------

/** Parse catalog pricing. Returns null when input or output rates are missing/unparseable. */
export function ratesFromPricing(pricing: CiPricing | undefined): ChatModelCost | null {
	if (!pricing) return null;
	const input = toRate(pricing.input_per_million);
	const output = toRate(pricing.output_per_million);
	if (input === null || output === null) return null;
	// Missing cache rates cost at the full input rate: an estimate that is never
	// lower than what an uncached token could cost.
	const cacheRead = cacheRate(pricing, "read") ?? input;
	const cacheWrite = cacheRate(pricing, "write") ?? input;
	const cost: ChatModelCost = { input, output, cacheRead, cacheWrite };
	const tier = tierFromPricing(pricing, { input, output, cacheRead, cacheWrite });
	if (tier) cost.tiers = [tier];
	return cost;
}

function tierFromPricing(
	pricing: CiPricing,
	base: ChatModelCostRates,
): (ChatModelCostRates & { inputTokensAbove: number }) | null {
	const above = pricing.above_threshold;
	if (!above || typeof above !== "object") return null;
	const threshold = toPositiveInt(above.input_token_price_threshold) ?? toPositiveInt(pricing.input_token_price_threshold);
	if (threshold === null) return null;
	const tierInput = toRate(above.input_per_million) ?? base.input;
	const tierOutput = toRate(above.output_per_million) ?? base.output;
	const tierRead = cacheRate(above, "read") ?? tierInput;
	const tierWrite = cacheRate(above, "write") ?? tierInput;
	return { input: tierInput, output: tierOutput, cacheRead: tierRead, cacheWrite: tierWrite, inputTokensAbove: threshold };
}

/**
 * A model is usable by pi when it is a text model, streamed Chat Completions
 * is an advertised endpoint, and it does not declare streaming unsupported.
 */
export function isChatStreamable(model: CiModel): boolean {
	if ((model.type ?? "text") !== "text") return false;
	const endpoints = model.supported_endpoints;
	if (endpoints && endpoints.length > 0 && !endpoints.includes(CHAT_COMPLETIONS_ENDPOINT)) return false;
	return model.capabilities?.streaming !== false;
}

export function isClaudeModel(model: CiModel): boolean {
	if (model.id.toLowerCase().startsWith("claude")) return true;
	return /anthropic/i.test(`${model.provider ?? ""} ${model.owned_by ?? ""}`);
}

const ACRONYMS = new Set(["ai", "aws", "glm", "gpt", "llm"]);
const NAME_OVERRIDES: Record<string, string> = { deepseek: "DeepSeek" };

/** "claude-opus-4.6" -> "Claude Opus 4.6", "gpt-5.6-luna" -> "GPT 5.6 Luna". */
export function humanizeModelName(id: string): string {
	const bare = id.includes("/") ? (id.split("/").pop() ?? id) : id;
	return bare
		.split(/[-_]/)
		.filter(Boolean)
		.map((token) => {
			const lower = token.toLowerCase();
			if (NAME_OVERRIDES[lower]) return NAME_OVERRIDES[lower];
			if (ACRONYMS.has(lower)) return token.toUpperCase();
			if (/^\d/.test(token)) return token;
			return token.charAt(0).toUpperCase() + token.slice(1);
		})
		.join(" ");
}

export function catalogToChatModels(catalog: CiCatalog): ChatModelConfig[] {
	const byId = new Map<string, ChatModelConfig>();
	for (const model of catalog.models) {
		if (byId.has(model.id)) continue;
		if (!isChatStreamable(model)) continue;
		const cost = ratesFromPricing(model.pricing);
		if (!cost) continue;
		const contextWindow = model.context_length ?? FALLBACK_CONTEXT_WINDOW;
		const maxTokens = Math.min(model.max_output_tokens ?? FALLBACK_MAX_OUTPUT_TOKENS, contextWindow);
		const claude = isClaudeModel(model);
		byId.set(model.id, {
			id: model.id,
			name: humanizeModelName(model.id),
			reasoning: model.capabilities?.reasoning === true,
			...(model.capabilities?.reasoning === true
				? { thinkingLevelMap: { ...IDENTITY_THINKING_LEVEL_MAP } }
				: {}),
			input: model.capabilities?.vision === true ? ["text", "image"] : ["text"],
			cost,
			contextWindow,
			maxTokens,
			promptCache: claude
				? { short: CLAUDE_CACHE_SHORT_SECONDS, long: CLAUDE_CACHE_LONG_SECONDS }
				: { short: GENERIC_CACHE_SHORT_SECONDS },
			compat: {
				supportsReasoningEffort: true,
				thinkingFormat: "openai",
				...(claude
					? // Explicit anthropic-style markers: pi marks the system/tools prefix and
						// the last conversation block; the gateway preserves markers and lifetimes.
						{ cacheControlFormat: "anthropic", supportsLongCacheRetention: true }
					: // Non-Claude models use implicit provider caches; suppress the undocumented
						// prompt_cache_retention field instead of assuming gateway support.
						{ supportsLongCacheRetention: false }),
			},
		});
	}
	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

export class CatalogError extends Error {
	status?: number;
	authError: boolean;

	constructor(message: string, options: { status?: number; authError?: boolean } = {}) {
		super(message);
		this.name = "CatalogError";
		this.status = options.status;
		this.authError = options.authError ?? false;
	}
}

export interface FetchCatalogOptions {
	apiKey?: string;
	/** API root with or without a "/v1" suffix. Defaults to the public gateway. */
	baseUrl?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	fetchFn?: typeof fetch;
}

/** Normalize a configured base URL to an API root without a "/v1" suffix. */
export function resolveApiRoot(baseUrl: string): string {
	let root = baseUrl.trim().replace(/\/+$/, "");
	if (root.toLowerCase().endsWith("/v1")) root = root.slice(0, -3);
	return root.replace(/\/+$/, "");
}

/**
 * Fetch the model catalog. With an API key the authenticated key-filtered
 * `/v1/models` view is used, falling back to the unauthenticated
 * `/public/models` view on gateway outage or network failure. Without a key
 * only the public view is requested. Auth rejections (401/403) are terminal:
 * models listed without the key would not be callable anyway.
 */
export async function fetchCatalog(options: FetchCatalogOptions = {}): Promise<CiCatalog> {
	const root = resolveApiRoot(options.baseUrl ?? DEFAULT_API_ROOT);
	const fetchFn = options.fetchFn ?? fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_CATALOG_TIMEOUT_MS;
	const timeout = AbortSignal.timeout(timeoutMs);
	const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;

	const attempt = async (url: string, withAuth: boolean): Promise<Response> => {
		const headers: Record<string, string> = { Accept: "application/json" };
		if (withAuth && options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
		return fetchFn(url, { headers, signal });
	};

	if (!options.apiKey) {
		try {
			const publicResponse = await attempt(`${root}/public/models`, false);
			if (publicResponse.ok) return await finalizeCatalog(publicResponse, "public");
			throw new CatalogError(`public catalog request failed (HTTP ${publicResponse.status})`, {
				status: publicResponse.status,
			});
		} catch (error) {
			if (error instanceof CatalogError) throw error;
			throw new CatalogError(`public catalog request failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	let authStatus: number | undefined;
	let networkError: unknown;
	try {
		const response = await attempt(`${root}/v1/models`, true);
		authStatus = response.status;
		if (response.ok) return await finalizeCatalog(response, "authenticated");
	} catch (error) {
		networkError = error;
	}

	if (authStatus === 401 || authStatus === 403) {
		throw new CatalogError(`catalog request rejected (HTTP ${authStatus}) — check your CheaperInference API key`, {
			status: authStatus,
			authError: true,
		});
	}

	if (authStatus === undefined || authStatus === 408 || authStatus === 429 || authStatus >= 500) {
		try {
			const publicResponse = await attempt(`${root}/public/models`, false);
			if (publicResponse.ok) return await finalizeCatalog(publicResponse, "public");
		} catch {
			// fall through to the error report below
		}
	}

	if (authStatus !== undefined) {
		throw new CatalogError(`catalog request failed (HTTP ${authStatus})`, { status: authStatus });
	}
	throw new CatalogError(
		`catalog request failed: ${networkError instanceof Error ? networkError.message : String(networkError)}`,
	);
}

async function finalizeCatalog(response: Response, source: CiCatalog["source"]): Promise<CiCatalog> {
	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		throw new CatalogError(`catalog returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	const catalog = parseCatalog(payload, source);
	if (!catalog.models.length) throw new CatalogError("catalog contained no models");
	return catalog;
}
