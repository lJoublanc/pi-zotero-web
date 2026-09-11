import { SettingsManager, getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Mode selection: how the Zotero tools choose between the Web API
 * (api.zotero.org, requires an API key) and the Local API
 * (http://127.0.0.1:23119/api, keyless reads).
 *
 * Resolution follows the discussion design:
 * - Credentials determine what is *available*; a setting only overrides.
 * - With neither credential, the Local API is used read-only (its reads need
 *   no key; the Web API cannot be used keyless at all).
 * - With both credentials, the Local API wins: a Web API key never expires, so
 *   "stored once, months ago" is the steady state — the deliberately-earned
 *   local credential should not be shadowed by it.
 * - A settings key provides the explicit override for the ambiguous
 *   both-credentials case: `"zotero": { "mode": "auto" | "web" | "local" }`.
 *
 * Settings key convention (same as pi-compaction-model): a section named after
 * the package, read via SettingsManager (global + trusted project settings,
 * shallow-merged, project wins); invalid values warn and fall back to "auto".
 * Extensions only read settings; they never write them.
 */

export type ZoteroModeSetting = "auto" | "web" | "local";
export type ZoteroMode = "web" | "local";

/** Credential material for one provider, extracted from auth.json. */
export interface ZoteroModeCredential {
	/** API key (Web) or local API key (Local). */
	key: string;
	/** Optional group-library override (ZOTERO_GROUP_ID in the credential env). */
	groupId?: string;
}

export interface ResolvedZoteroMode {
	mode: ZoteroMode;
	source: "setting" | "credential:zotero" | "credential:zotero-local" | "no-credentials";
	apiKey?: string;
	groupId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MODES: readonly ZoteroModeSetting[] = ["auto", "web", "local"];

/**
 * Extract the mode setting from the global and (trusted) project settings.
 * `zotero.mode` — project wins over global when both are present.
 * Returns "auto" when unset or invalid (warn via `warn`).
 */
export function zoteroModeFromSettings(
	globalSettings: unknown,
	projectSettings: unknown,
	warn: (message: string) => void = (message) => console.warn(`[pi-zotero-web] ${message}`),
): ZoteroModeSetting {
	const sections: Array<{ settings: unknown; scope: string }> = [
		{ settings: globalSettings, scope: "global" },
		{ settings: projectSettings, scope: "project" },
	];
	let result: ZoteroModeSetting = "auto";
	for (const { settings, scope } of sections) {
		if (settings === undefined || !isRecord(settings)) continue;
		const section = settings.zotero;
		if (section === undefined) continue;
		if (!isRecord(section)) {
			warn(`'${scope} settings: "zotero" must be an object (e.g. "zotero": { "mode": "local" }); ignoring it.`);
			continue;
		}
		const raw = section.mode;
		if (raw === undefined) continue;
		if (typeof raw === "string" && (MODES as readonly string[]).includes(raw)) {
			result = raw as ZoteroModeSetting;
		} else {
			warn(`'${scope} settings: "zotero.mode" must be one of ${MODES.join(", ")} (got '${String(raw)}'); using "${result}".`);
		}
	}
	return result;
}

/**
 * Pure mode resolution. Precedence: explicit setting ("web"/"local") > stored
 * credentials (local wins when both) > keyless local read-only.
 */
export function resolveZoteroMode(
	web: ZoteroModeCredential | undefined,
	local: ZoteroModeCredential | undefined,
	setting: ZoteroModeSetting,
): ResolvedZoteroMode {
	if (setting === "web") {
		return { mode: "web", source: "setting", apiKey: web?.key, groupId: web?.groupId };
	}
	if (setting === "local") {
		return { mode: "local", source: "setting", apiKey: local?.key, groupId: local?.groupId };
	}
	if (local) {
		return { mode: "local", source: "credential:zotero-local", apiKey: local.key, groupId: local.groupId };
	}
	if (web) {
		return { mode: "web", source: "credential:zotero", apiKey: web.key, groupId: web.groupId };
	}
	return { mode: "local", source: "no-credentials" };
}

/** Extract a ZoteroModeCredential from whatever ModelRegistry.getProviderAuth() returned. */
export function credentialOfAuth(auth: unknown): ZoteroModeCredential | undefined {
	const a = auth as { auth?: { apiKey?: string }; env?: Record<string, string | undefined> } | undefined | null;
	const key = a?.auth?.apiKey;
	if (!key) return undefined;
	const groupId = a?.env?.ZOTERO_GROUP_ID;
	return groupId ? { key, groupId } : { key };
}

/**
 * Read `zotero.mode` from settings (global + trusted project). Reads only —
 * extensions never write settings. Falls back to "auto" when settings cannot
 * be read at all.
 */
export function readZoteroModeSetting(ctx: ExtensionContext): ZoteroModeSetting {
	const warn = (message: string) => console.warn(`[pi-zotero-web] ${message}`);
	try {
		const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
			projectTrusted: ctx.isProjectTrusted(),
		});
		return zoteroModeFromSettings(
			settings.getGlobalSettings(),
			ctx.isProjectTrusted() ? settings.getProjectSettings() : undefined,
			warn,
		);
	} catch (err) {
		warn(`could not read settings (${(err as Error).message}); using "auto".`);
		return "auto";
	}
}
