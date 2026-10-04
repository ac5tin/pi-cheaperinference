/**
 * CheaperInference provider for the pi coding agent.
 *
 * Registers every chat-capable model from the live catalog — authenticated
 * (key-filtered) when a key is available, unauthenticated `/public/models`
 * otherwise — with real per-million pricing including cache-read/cache-write
 * rates and long-context tiers, so pi's usage and cost reporting matches what
 * the gateway bills.
 *
 * Authentication has three paths that all end at the same key:
 *   1. `CHEAPERINFERENCE_API_KEY` (or `CHEAPER_INFERENCE_API_KEY`) in the
 *      environment — used at registration for the key-filtered catalog.
 *   2. `/login` → "Sign in with an API key" → CheaperInference — pi's built-in
 *      secret prompt, stored in auth.json.
 *   3. `/login` → "Sign in with an account" → CheaperInference — same paste
 *      flow via the extension's oauth config, validated against the gateway.
 * The provider is registered unconditionally so it always appears in /login;
 * models simply stay unavailable until a key is configured.
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
 * Never breaks startup: catalog failure with no snapshot skips registration
 * with a warning. The wallet dashboard always remains the authoritative
 * record of what was actually billed.
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

/** A pasted API key never expires; refresh is a no-op. Milliseconds, per pi's auth code. */
const KEY_CREDENTIAL_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;

export interface ExtensionDeps {
	env?: NodeJS.ProcessEnv;
	warn?: (message: string) => void;
	fetchFn?: typeof fetch;
	snapshotPath?: string;
	catalogTimeoutMs?: number;
}

interface LoginInteraction {
	onPrompt(prompt: { message: string }): Promise<string>;
	signal?: AbortSignal;
}

interface KeyCredential {
	access: string;
	refresh: string;
	expires: number;
	[key: string]: unknown;
}

interface OAuthConfigShape {
	name: string;
	login(interaction: LoginInteraction): Promise<KeyCredential>;
	refreshToken(credential: KeyCredential, signal: AbortSignal): Promise<KeyCredential>;
	getApiKey(credential: KeyCredential): string;
}

interface CredentialShape {
	type?: string;
	key?: string;
	access?: unknown;
}

interface RefreshContext {
	allowNetwork?: boolean;
	signal?: AbortSignal;
	credential?: CredentialShape;
}

function resolveApiKey(env: NodeJS.ProcessEnv): string | undefined {
	return env.CHEAPERINFERENCE_API_KEY || env.CHEAPER_INFERENCE_API_KEY || undefined;
}

export default async function cheaperinferenceExtension(pi: ExtensionAPI, deps: ExtensionDeps = {}) {
	const warn = deps.warn ?? ((message: string) => console.warn(`[cheaperinference] ${message}`));
	const env = deps.env ?? process.env;

	const envKey = resolveApiKey(env);
	const root = resolveApiRoot(env.CHEAPERINFERENCE_BASE_URL || DEFAULT_API_ROOT);
	const snapshotPath = deps.snapshotPath ?? defaultSnapshotPath();
	const catalogTimeoutMs = deps.catalogTimeoutMs ?? catalogTimeoutFromEnv(env) ?? DEFAULT_CATALOG_TIMEOUT_MS;

	// --- resolve the starting catalog: key-filtered when possible, public otherwise ---
	let catalog: CiCatalog | undefined;
	let fromSnapshot: string | undefined;
	try {
		catalog = await fetchCatalog({ apiKey: envKey, baseUrl: root, fetchFn: deps.fetchFn, timeoutMs: catalogTimeoutMs });
		await saveSnapshot(snapshotPath, catalog);
	} catch (error) {
		if (error instanceof CatalogError && error.authError) {
			warn(`${error.message} — fix or remove CHEAPERINFERENCE_API_KEY, or sign in with /login`);
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
	} else if (envKey) {
		warn(`registered ${models.length} models from the ${catalog.source ?? "authenticated"} catalog`);
	} else {
		warn(
			`registered ${models.length} models from the public catalog — sign in with /login or set CHEAPERINFERENCE_API_KEY to use them`,
		);
	}

	const fetchOptionsFor = (apiKey: string | undefined, signal?: AbortSignal): FetchCatalogOptions => ({
		apiKey,
		baseUrl: root,
		fetchFn: deps.fetchFn,
		timeoutMs: catalogTimeoutMs,
		signal,
	});

	// --- /login: paste-key flow, also offered under "Sign in with an account" ---
	const oauth: OAuthConfigShape = {
		name: "CheaperInference",
		login: async (interaction) => {
			const raw = await interaction.onPrompt({
				message: `Paste your CheaperInference API key (create one at ${SIGNUP_URL})`,
			});
			const key = raw.trim();
			if (!key) throw new Error("No API key entered");
			// Validate immediately so typos surface here, not on the first request.
			// Offline or gateway hiccups still accept the key.
			try {
				await fetchCatalog(fetchOptionsFor(key));
			} catch (error) {
				if (error instanceof CatalogError && error.authError) {
					throw new Error("CheaperInference rejected this API key — check it and try again");
				}
			}
			return { access: key, refresh: "", expires: Date.now() + KEY_CREDENTIAL_TTL_MS };
		},
		refreshToken: async (credential) => credential,
		getApiKey: (credential) => credential.access,
	};

	// --- provider registration (always, so /login can offer it) ---
	pi.registerProvider(PROVIDER_ID, {
		name: "CheaperInference",
		baseUrl: `${root}/v1`,
		// Literal when the env provides one (either documented spelling); otherwise the
		// env-ref form, which makes pi offer "Sign in with an API key" for this provider.
		apiKey: envKey ?? "$CHEAPERINFERENCE_API_KEY",
		api: "openai-completions",
		headers: { [PROMPT_CACHE_HEADER]: "on" },
		models: models as ProviderModelConfig[],
		oauth: oauth as never,
		refreshModels: async (context: RefreshContext) => {
			const credential = context.credential;
			const credentialKey =
				credential?.type === "api_key"
					? credential.key
					: credential?.type === "oauth" && typeof credential.access === "string"
						? credential.access
						: undefined;
			if (context.allowNetwork) {
				try {
					const fresh = await fetchCatalog(fetchOptionsFor(credentialKey ?? envKey, context.signal));
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
