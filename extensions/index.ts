/**
 * CheaperInference provider for the pi coding agent.
 *
 * Registers every chat-capable model from the live (authenticated) catalog
 * with real per-million pricing — including cache-read/cache-write rates and
 * long-context tiers — so pi's usage and cost reporting matches what the
 * gateway bills.
 *
 * Prompt caching is wired end to end:
 *   1. Claude models get pi's anthropic-style `cache_control` markers
 *      (`compat.cacheControlFormat`), which the gateway's Chat-to-Messages
 *      bridge preserves; long retention (1h TTL) is enabled for them.
 *   2. The provider header `x-ci-prompt-cache: on` asks the gateway to mark
 *      unmarked requests — a no-op for already-marked ones, a safety net for
 *      pi versions without `cacheControlFormat`.
 *   3. Every request carries a per-session `prompt_cache_key` (injected via
 *      `before_provider_request`) for supplier routing affinity, the main
 *      driver of actual cache hits on a marketplace gateway.
 *   4. `promptCache` lifetimes let pi keep idle caches warm when it estimates
 *      the avoided cache misses are worth it.
 *
 * Thinking effort: reasoning models accept pi's full level set
 * (minimal/low/medium/high/xhigh/max) sent as OpenAI-style `reasoning_effort`,
 * the spelling the gateway documents for Claude reasoning.
 *
 * Never breaks startup: no API key, catalog failure, or an unusable catalog
 * skips registration with a warning (falling back to the last-good catalog
 * snapshot when offline). The wallet dashboard always remains the
 * authoritative record of what was actually billed.
 */

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_API_ROOT,
	DEFAULT_CATALOG_TIMEOUT_MS,
	type CiCatalog,
	CatalogError,
	type FetchCatalogOptions,
	catalogToChatModels,
	type ChatModelConfig,
	fetchCatalog,
	resolveApiRoot,
} from "../src/catalog.ts";
import { injectPromptCacheKey, sessionCacheKey } from "../src/cache.ts";
import { defaultSnapshotPath, loadSnapshot, saveSnapshot } from "../src/snapshot.ts";

export const PROVIDER_ID = "cheaperinference";
export const SIGNUP_URL = "https://www.cheaperinference.com";

/** Header asking the gateway to add cache breakpoints to unmarked requests. */
const PROMPT_CACHE_HEADER = "x-ci-prompt-cache";

export interface ExtensionDeps {
	env?: NodeJS.ProcessEnv;
	warn?: (message: string) => void;
	fetchFn?: typeof fetch;
	snapshotPath?: string;
	catalogTimeoutMs?: number;
}

interface RefreshContext {
	allowNetwork?: boolean;
	signal?: AbortSignal;
}

function resolveApiKey(env: NodeJS.ProcessEnv): string | undefined {
	return env.CHEAPERINFERENCE_API_KEY || env.CHEAPER_INFERENCE_API_KEY || undefined;
}

export default async function cheaperinferenceExtension(pi: ExtensionAPI, deps: ExtensionDeps = {}) {
	const warn = deps.warn ?? ((message: string) => console.warn(`[cheaperinference] ${message}`));
	const env = deps.env ?? process.env;

	const apiKey = resolveApiKey(env);
	if (!apiKey) {
		warn(
			`no API key found — set CHEAPERINFERENCE_API_KEY (or CHEAPER_INFERENCE_API_KEY) to enable the provider. Create one at ${SIGNUP_URL}`,
		);
		return;
	}

	const root = resolveApiRoot(env.CHEAPERINFERENCE_BASE_URL || DEFAULT_API_ROOT);
	const snapshotPath = deps.snapshotPath ?? defaultSnapshotPath();
	const fetchOptions: FetchCatalogOptions = {
		apiKey,
		baseUrl: root,
		fetchFn: deps.fetchFn,
		timeoutMs: deps.catalogTimeoutMs ?? catalogTimeoutFromEnv(env) ?? DEFAULT_CATALOG_TIMEOUT_MS,
	};

	// --- resolve the starting catalog: live fetch, then last-good snapshot ---
	let catalog: CiCatalog | undefined;
	let fromSnapshot: string | undefined;
	try {
		catalog = await fetchCatalog(fetchOptions);
		await saveSnapshot(snapshotPath, catalog);
	} catch (error) {
		if (error instanceof CatalogError && error.authError) {
			warn(error.message);
			return;
		}
		const snapshot = await loadSnapshot(snapshotPath);
		if (!snapshot) {
			warn(
				`catalog unavailable (${describe(error)}) and no snapshot on disk — provider not registered; runs are unaffected`,
			);
			return;
		}
		catalog = snapshot.catalog;
		fromSnapshot = snapshot.savedAt;
	}

	const models: ChatModelConfig[] = catalogToChatModels(catalog);
	if (!models.length) {
		warn("catalog has no models pi can drive (streamed chat completions) — provider not registered");
		return;
	}
	let modelIds = new Set(models.map((model) => model.id));

	if (fromSnapshot) {
		warn(
			`catalog fetch failed — registered ${models.length} models from the snapshot saved ${fromSnapshot || "at an unknown time"}; pricing may be stale`,
		);
	} else {
		warn(`registered ${models.length} models from the ${catalog.source ?? "authenticated"} catalog`);
	}

	// --- provider registration ---
	pi.registerProvider(PROVIDER_ID, {
		name: "CheaperInference",
		baseUrl: `${root}/v1`,
		apiKey,
		api: "openai-completions",
		headers: { [PROMPT_CACHE_HEADER]: "on" },
		models: models as ProviderModelConfig[],
		refreshModels: async (context: RefreshContext) => {
			if (context.allowNetwork) {
				try {
					const fresh = await fetchCatalog({ ...fetchOptions, signal: context.signal });
					const freshModels = catalogToChatModels(fresh);
					if (freshModels.length) {
						models.length = 0;
						models.push(...freshModels);
						modelIds = new Set(freshModels.map((model) => model.id));
						void saveSnapshot(snapshotPath, fresh);
						return freshModels as ProviderModelConfig[];
					}
				} catch (error) {
					warn(`catalog refresh failed (${describe(error)}) — keeping current models`);
				}
			}
			return models as ProviderModelConfig[];
		},
	});

	// --- per-session prompt-cache affinity ---
	pi.on("before_provider_request", (event, ctx) => {
		const sessionId = ctx.sessionManager?.getSessionId?.();
		return injectPromptCacheKey(event.payload, modelIds, sessionCacheKey(sessionId));
	});
}

function catalogTimeoutFromEnv(env: NodeJS.ProcessEnv): number | undefined {
	const raw = Number(env.CHEAPERINFERENCE_CATALOG_TIMEOUT_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
