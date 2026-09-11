/**
 * Zotero Local API authentication.
 *
 * The local API (Zotero 10+; http://127.0.0.1:23119/api) needs no key for
 * reads. Writes require a *local* API key, obtained through a Zotero-10-only
 * handshake that has no Web API analog:
 *
 *   POST /api/local/authorize  { "appName": "<display name>" }
 *     -> the Zotero desktop app shows an Allow / Always Allow / Deny dialog
 *     -> 200 { "key": "<32-char key>", "remember": <bool> }
 *     -> 403 { "denied": true } when the user picks Deny
 *     -> 429 (+ Retry-After) when the authorize endpoint is rate-limited
 *
 * Keys are unrelated to zotero.org API keys. When the user picks "Allow"
 * (not "Always Allow") the key is single-use: the first successful write
 * consumes it, and the next write 401s. Clients must therefore always be
 * ready to reauthenticate (see the 401 retry in client.ts).
 *
 * This module owns the handshake and the process-level cache of the most
 * recent key, so the 401 retry and the /login flow share one handshake.
 */

/** Base URL of the local API. (Port 23119 spells "ZO" in ASCII.) */
export const ZOTERO_LOCAL_API_BASE = "http://127.0.0.1:23119/api";
export const ZOTERO_LOCAL_HOST = "http://127.0.0.1:23119";

/** Raised when the /api/local/authorize handshake fails. */
export class LocalAuthError extends Error {
	constructor(
		message: string,
		readonly status: number | undefined,
		readonly body: string,
	) {
		super(message);
		this.name = "LocalAuthError";
	}
}

const APP_NAME = "pi";

let cachedLocalKey: string | undefined;
let inFlightAuthorize: Promise<string> | undefined;

/** The most recent local API key obtained by this process (may be single-use). */
export function getCachedLocalKey(): string | undefined {
	return cachedLocalKey;
}

export function setCachedLocalKey(key: string): void {
	cachedLocalKey = key;
}

/** Forget the process-cached key (used by the 401/428/412 retry logic in tests). */
export function resetLocalAuthCache(): void {
	cachedLocalKey = undefined;
	inFlightAuthorize = undefined;
}

function connErrorMessage(cause: unknown): Error {
	return new Error(
		`Zotero does not appear to be running (no response from ${ZOTERO_LOCAL_HOST}). ` +
			`Start the Zotero desktop app and enable its local API ` +
			`(Settings → Advanced → "Allow other applications on this computer to communicate with Zotero"). ` +
			`(${(cause as Error)?.message ?? String(cause)})`,
	);
}

/** True when the failure looks like "nothing listening / connection reset", i.e. Zotero not running. */
export function isConnectionError(err: unknown): boolean {
	const msg = (err as Error)?.message ?? "";
	return /ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|Unexpected fetch|fetch failed/i.test(msg);
}

/**
 * Obtain a local API key: runs the authorize handshake (single-flight; a
 * concurrent burst of 401 retries shares one dialog). Returns the key and
 * caches it for subsequent writes in this process.
 */
export async function authorizeLocal(signal?: AbortSignal): Promise<string> {
	if (cachedLocalKey) return cachedLocalKey;
	if (!inFlightAuthorize) {
		inFlightAuthorize = (async () => {
			let res: Response;
			try {
				res = await fetch(`${ZOTERO_LOCAL_API_BASE}/local/authorize`, {
					method: "POST",
					headers: { "Content-Type": "application/json", "Zotero-API-Version": "3" },
					body: JSON.stringify({ appName: APP_NAME }),
					signal,
				});
			} catch (err) {
				throw connErrorMessage(err);
			}
			if (res.status === 429) {
				const retryAfter = res.headers.get("Retry-After");
				throw new LocalAuthError(
					`Zotero rate-limited the authorization request; wait ${retryAfter ?? "a few"} second(s) and try again.`,
					429,
					"",
				);
			}
			if (res.status === 404) {
				throw new LocalAuthError(
					`This Zotero version's local API does not support authorization (Zotero 10+ required for local writes). ` +
						`Reads still work; for write support use the Web API instead (/login zotero).`,
					404,
					"not found",
				);
			}
			const body = await res.text().catch(() => "");
			let json: { key?: string; remember?: boolean; denied?: boolean } | undefined;
			try {
				json = body ? (JSON.parse(body) as typeof json) : undefined;
			} catch {
				// not JSON
			}
			if (json?.denied) {
				throw new LocalAuthError(
					`Access was denied in Zotero. Run /login zotero-local (or retry the write) and choose "Allow" or "Always Allow" in the Zotero window.`,
					res.status,
					body,
				);
			}
			if (!res.ok) {
				throw new LocalAuthError(`Zotero local authorization failed (HTTP ${res.status}). ${body.trim()}`, res.status, body);
			}
			if (!json?.key) {
				throw new LocalAuthError("Zotero returned an unexpected authorization response.", res.status, body);
			}
			cachedLocalKey = json.key;
			return json.key;
		})();
	}
	try {
		return await inFlightAuthorize;
	} finally {
		if (inFlightAuthorize) {
			// Clear the shared promise; the resolved key stays in cachedLocalKey.
			inFlightAuthorize = undefined;
		}
	}
}
