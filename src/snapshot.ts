/**
 * Offline snapshot of the last good CheaperInference catalog.
 *
 * The live catalog is fetched on every pi start; the snapshot lets the
 * provider register (with stale, last-known pricing) when the gateway is
 * unreachable. Written atomically and best-effort: a snapshot failure never
 * blocks registration.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CiCatalog } from "./catalog.ts";

/** pi's config dir name (see `piConfig.configDir` in the pi package); agent state lives under `<configDir>/agent`. */
const PI_CONFIG_DIR = ".pi";

export function defaultSnapshotPath(): string {
	return (
		process.env.CHEAPERINFERENCE_SNAPSHOT_PATH ??
		join(homedir(), PI_CONFIG_DIR, "agent", "cheaperinference-catalog.json")
	);
}

export interface SnapshotFile {
	savedAt: string;
	catalog: CiCatalog;
}

export async function saveSnapshot(path: string, catalog: CiCatalog): Promise<boolean> {
	try {
		const file: SnapshotFile = { savedAt: new Date().toISOString(), catalog };
		const tmp = `${path}.${process.pid}.tmp`;
		await mkdir(dirname(path), { recursive: true });
		await writeFile(tmp, JSON.stringify(file));
		await rename(tmp, path);
		return true;
	} catch {
		return false;
	}
}

export async function loadSnapshot(path: string): Promise<SnapshotFile | null> {
	try {
		const raw: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!raw || typeof raw !== "object") return null;
		const file = raw as Partial<SnapshotFile>;
		const catalog = file.catalog;
		if (!catalog || !Array.isArray(catalog.models) || catalog.models.length === 0) return null;
		return { catalog, savedAt: typeof file.savedAt === "string" ? file.savedAt : "" };
	} catch {
		return null;
	}
}
