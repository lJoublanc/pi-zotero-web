import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { ZOTERO_LOCAL_API_BASE } from "./localAuth.ts";
import { credentialOfAuth, readZoteroModeSetting, resolveZoteroMode } from "./mode.ts";
import { ZOTERO_LOCAL_PROVIDER_ID, ZOTERO_PROVIDER_ID, createZoteroLocalProvider, createZoteroProvider } from "./provider.ts";
import { registerZoteroTools } from "./tools.ts";

/**
 * Zotero integration for pi.
 *
 * Talks to either the Zotero Web API (api.zotero.org, `/login zotero`) or the
 * Local API of the running desktop app (http://127.0.0.1:23119/api, `/login
 * zotero-local`), depending on which credentials are stored and the
 * `zotero.mode` setting (see mode.ts). With no credentials, the Local API is
 * used read-only.
 *
 * - Registers two auth-only pi-ai Providers (`zotero`, `zotero-local`) so
 *   `/login`/`/logout` manage each credential in ~/.pi/agent/auth.json. They
 *   declare no LLM models, so they never show up in /model.
 * - Registers tools for library search, item CRUD, item templates, and
 *   PDF/attachment upload/download/delete.
 */
export default function zoteroExtension(pi: ExtensionAPI): void {
	pi.registerProvider(createZoteroProvider());
	pi.registerProvider(createZoteroLocalProvider());

	pi.on("session_start", async (_event, ctx) => {
		const resolved = resolveZoteroMode(
			credentialOfAuth(await ctx.modelRegistry.getProviderAuth(ZOTERO_PROVIDER_ID)),
			credentialOfAuth(await ctx.modelRegistry.getProviderAuth(ZOTERO_LOCAL_PROVIDER_ID)),
			readZoteroModeSetting(ctx),
		);
		if (resolved.mode === "web") {
			if (resolved.apiKey) {
				ctx.ui.notify(`Zotero: Web API mode (api.zotero.org${resolved.groupId ? `, group ${resolved.groupId}` : ""}).`, "info");
			} else {
				ctx.ui.notify("Zotero: Web API mode forced, but no key found — run `/login zotero`.", "warning");
			}
			return;
		}
		if (resolved.source === "no-credentials") {
			ctx.ui.notify(
				"Zotero: no credentials — Local API, read-only (writes will ask via Zotero). Run `/login zotero` (Web) or `/login zotero-local` (Local) for full access.",
				"info",
			);
			return;
		}
		// Local mode: check the desktop app is actually there before promising anything.
		try {
			await fetch(`${ZOTERO_LOCAL_API_BASE}/`, { headers: { "Zotero-API-Version": "3" }, signal: AbortSignal.timeout(2000) });
			ctx.ui.notify(
				resolved.apiKey
					? `Zotero: Local API mode (authorized; ${ZOTERO_LOCAL_API_BASE}${resolved.groupId ? `, group ${resolved.groupId}` : ""}).`
					: `Zotero: Local API mode, read-only (no key yet — writes will prompt in Zotero).`,
				"info",
			);
		} catch {
			ctx.ui.notify(
				`Zotero: Local API mode, but Zotero did not respond on ${ZOTERO_LOCAL_API_BASE} — start the desktop app, or run \`/login zotero\` for the Web API.`,
				"warning",
			);
		}
	});

	registerZoteroTools(pi);
}
