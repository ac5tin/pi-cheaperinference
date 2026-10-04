# pi-cheaperinference

[CheaperInference](https://www.cheaperinference.com) as a first-class provider for the [pi coding agent](https://github.com/earendil-works/pi).

One command install, the full live model catalog with real pricing (including cache rates and long-context tiers), and prompt caching wired end to end so you are billed for cache hits — not for re-reading the same context at full price.

```sh
pi install git:github.com/ac5tin/pi-cheaperinference
```

## Requirements

- pi ≥ 1.0
- A CheaperInference API key (create one in the [dashboard](https://www.cheaperinference.com))

## Setup

Export your key before starting pi:

```sh
export CHEAPERINFERENCE_API_KEY=ci_live_...
```

`CHEAPER_INFERENCE_API_KEY` (with underscores around `INFERENCE`) is accepted too. Then pick a model inside pi with `/model` — every model your key can call appears under the `cheaperinference` provider, e.g. `cheaperinference/claude-opus-4.6`.

## What it does

**Live catalog.** On startup the extension calls `GET /v1/models` with your key and registers every model that pi can drive: streamed Chat Completions, text type, streaming capable. Vision models accept images, and `capabilities.reasoning` enables thinking. Because the catalog is fetched live (and `refreshModels` re-fetches it during a session), new models show up automatically — nothing is hardcoded.

**Real pricing.** Each model carries the catalog's per-million rates for input, output, **cache read** and **cache write**, plus the long-context `above_threshold` tier when the gateway publishes one. pi's cost reporting therefore tracks what the wallet is actually billed. (The wallet dashboard stays the authoritative record; the gateway may route a request to a differently-priced fallback supplier.)

**Thinking effort.** Reasoning models accept pi's full level set — off, minimal, low, medium, high, xhigh, max — sent as OpenAI-style `reasoning_effort`, the spelling CheaperInference documents for Claude reasoning. Pick a level with `/thinking`. Models that don't support a given effort return a descriptive 400; just lower the level.

**Offline snapshot.** The last good catalog is snapshotted to `~/.pi/agent/cheaperinference-catalog.json`. If the gateway is unreachable at startup (offline, outage), the provider still registers from the snapshot with a warning. An auth rejection (401/403) is not masked — fix the key.

## Prompt caching — the part that saves you money

Coding-agent conversations re-send the same system prompt, tools and history on every turn. With caching working, that prefix is billed at the (much cheaper) cache-read rate. The extension layers every mechanism the gateway supports:

| Layer | Mechanism | Applies to |
|---|---|---|
| Explicit markers | `compat.cacheControlFormat: "anthropic"` — pi adds `cache_control` breakpoints to the system prompt, last tool definition and last conversation block | Claude models |
| Long retention | `supportsLongCacheRetention: true` — 1h cache TTL when you set `PI_CACHE_RETENTION=long` | Claude models |
| Gateway fallback | Provider header `x-ci-prompt-cache: on` — the gateway marks *unmarked* requests itself | Claude models on older pi builds; a no-op when markers are already present |
| Routing affinity | Per-session `prompt_cache_key` (injected via `before_provider_request`, keyed by the pi session id) — keeps consecutive requests of one conversation on the same supplier, which is what actually produces cache hits on a marketplace gateway | All models |
| Cache warming | `promptCache` lifetimes (5 min short, 1 h long for Claude) let pi keep idle caches warm when it estimates the avoided misses are worth ≥ $0.05 | All models |

The affinity key is only injected into requests that go to CheaperInference models — the same model id on another provider (e.g. a built-in Anthropic model) is never touched. Non-Claude models use implicit provider caches; the undocumented `prompt_cache_retention` field is deliberately suppressed for them.

Usage accounting matches the gateway's semantics: `prompt_tokens_details.cached_tokens` is reported as cache-read (it is *part of* `prompt_tokens`, and pi costs it at the cache-read rate), cache writes at the cache-write rate.

## Configuration (environment variables)

| Variable | Meaning |
|---|---|
| `CHEAPERINFERENCE_API_KEY` | API key (`ci_live_...`). `CHEAPER_INFERENCE_API_KEY` also accepted |
| `CHEAPERINFERENCE_BASE_URL` | Alternate gateway root (default `https://api.cheaperinference.com`; a `/v1` suffix is tolerated) |
| `CHEAPERINFERENCE_CATALOG_TIMEOUT_MS` | Catalog fetch timeout (default 8000) |
| `CHEAPERINFERENCE_SNAPSHOT_PATH` | Override the snapshot file location |
| `PI_CACHE_RETENTION` | pi's cache retention preference (`short` default, `long` = 1 h TTL for Claude) |

## Model coverage notes

- Models whose endpoints don't include `/v1/chat/completions`, or that can't stream (e.g. `gpt-5.5-pro`, which requires non-streamed `/v1/responses`), are not registered — pi drives streaming Chat Completions.
- If the catalog reports no context window or output cap, conservative defaults (128k / 16,384) are used, and the output cap is clamped to the context window.
- The catalog is key-filtered: you see exactly what your key can call.

## Development

```sh
npm install
npm test         # node:test over src/ and the extension registration
npm run typecheck
```

## License

[MIT](LICENSE). Not affiliated with CheaperInference.
