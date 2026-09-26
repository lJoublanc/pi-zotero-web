import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";

import { ZOTERO_LOCAL_PROVIDER_ID, ZOTERO_PROVIDER_ID } from "./provider.ts";
import { credentialOfAuth, readZoteroModeSetting, resolveZoteroMode } from "./mode.ts";
import {
	type ZoteroConfig,
	type ZoteroItem,
	ZoteroError,
	addItemsToCollection,
	createCollections,
	deleteCollection,
	deleteItem,
	downloadAttachmentFile,
	exportItems,
	getChildren,
	getCollection,
	getFullText,
	getFullTextIndexMap,
	getItem,
	itemTemplate,
	listCollectionItems,
	listCollections,
	listGroups,
	listCreatorFields,
	listCreatorTypes,
	listItemFields,
	listItemTypeFields,
	listItemTypes,
	listTags,
	removeItemsFromCollection,
	searchItems,
	searchItemsWithVersion,
	setFullText,
	setItemTags,
	updateCollection,
	updateItem,
	uploadAttachmentFile,
	createItems,
} from "./client.ts";

/**
 * Resolve the configured Zotero target into a config: the `zotero.mode` setting
 * (see mode.ts) picks between the stored Web (`/login zotero`) and Local
 * (`/login zotero-local`) credentials; with no credentials at all, the Local
 * API is used read-only.
 */
async function resolveConfig(ctx: ExtensionContext): Promise<ZoteroConfig> {
	const [webAuth, localAuth] = await Promise.all([
		ctx.modelRegistry.getProviderAuth(ZOTERO_PROVIDER_ID),
		ctx.modelRegistry.getProviderAuth(ZOTERO_LOCAL_PROVIDER_ID),
	]);
	const resolved = resolveZoteroMode(credentialOfAuth(webAuth), credentialOfAuth(localAuth), readZoteroModeSetting(ctx));
	if (resolved.mode === "web") {
		const apiKey = credentialOfAuth(webAuth)?.key;
		if (!apiKey) {
			throw new Error(
				'No Zotero credentials configured for Web API mode. Run `/login zotero` (Web) or `/login zotero-local` (Local), ' +
					'or set `"zotero": { "mode": "local" }` in ~/.pi/agent/settings.json.',
				);
		}
		const userId = (webAuth as { env?: Record<string, string | undefined> } | null | undefined)?.env?.ZOTERO_USER_ID;
		if (!userId) {
			throw new Error("Zotero API key is stored but no user id was found. Re-run `/login zotero` to refresh it.");
		}
		return { mode: "web", apiKey, userId, groupId: resolved.groupId };
	}
	// Local mode: reads are keyless; writes obtain a local key lazily (401 → /api/local/authorize).
	// Group listing (Web-API-only) still uses the stored Web credential, if any.
	const webKey = credentialOfAuth(webAuth)?.key;
	const webUserId = (webAuth as { env?: Record<string, string | undefined> } | null | undefined)?.env?.ZOTERO_USER_ID;
	return {
		mode: "local",
		apiKey: resolved.apiKey,
		userId: "0",
		groupId: resolved.groupId,
		...(webKey && webUserId ? { webCredentials: { apiKey: webKey, userId: webUserId } } : {}),
	};
}

function summarize(items: ZoteroItem[]): unknown[] {
	// Keep tool output small: only metadata fields the LLM usually needs.
	return items.map((item) => ({
		key: item.key,
		version: item.version,
		itemType: item.data.itemType,
		title: item.data.title,
		creators: item.data.creators,
		abstractNote: item.data.abstractNote,
		date: item.data.date,
		DOI: item.data.DOI,
		url: item.data.url,
		tags: item.data.tags,
		collections: item.data.collections,
	}));
}

/**
 * Server-side fulltext cap mirrored client-side: Zotero's
 * `fulltext.textMaxLength` default (500000 chars; PDFs additionally cap at
 * `fulltext.pdfMaxPages` = 100 pages server-side). Larger `set` payloads are
 * refused before the PUT — the server answers 400/413 for them.
 */
const MAX_FULLTEXT_CHARS = 500_000;

/** MIME families the fulltext PUT accepts: PDF, any text/*, EPUB. */
function isIndexableMime(mime: unknown): boolean {
	if (typeof mime !== "string") return false;
	const base = mime.split(";")[0]!.trim().toLowerCase();
	return base === "application/pdf" || base === "application/epub+zip" || base.startsWith("text/");
}

function libraryOf(cfg: ZoteroConfig): string {
	if (cfg.groupId) return `groups/${cfg.groupId}`;
	// resolveConfig() always sets userId ("0" for the local personal library).
	return `users/${cfg.userId ?? "0"}`;
}

function textResult(cfg: ZoteroConfig | undefined, obj: unknown) {
	// Envelope (PLAN 3.3): every JSON result gains {mode, library}. JSON arrays
	// (schema reads, group listing) pass through bare — the envelope would break
	// their shape, and the caller already knows the target from context.
	let body: unknown = obj;
	if (cfg && obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
		// Envelope wins on collision: Zotero items/collections already carry a
		// `library` object, which the routing string replaces.
		body = { ...(obj as Record<string, unknown>), mode: cfg.mode ?? "web", library: libraryOf(cfg) };
	}
	return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], details: {} };
}

/**
 * Normalize the `item` argument for create/update.
 *
 * Some providers serialize an untyped (`Type.Any()`) object parameter as a
 * JSON string rather than a parsed object, and pi's TypeBox `Value.Convert`
 * leaves `Type.Any()` values untouched, so the string reaches `execute()` as-is.
 * Parse it back into an object here so the tool is robust to both shapes.
 */
function coerceItem(value: unknown): unknown {
	if (typeof value === "string") {
		try {
			return JSON.parse(value);
		} catch {
			throw new Error(
				"item was passed as a string but is not valid JSON. Pass an object (or array of objects) for create/update.",
			);
		}
	}
	return value;
}

function normalizeDoi(doi: unknown): string | undefined {
	if (typeof doi !== "string") return undefined;
	const trimmed = doi.trim();
	if (!trimmed) return undefined;
	// Zotero stores DOIs without the "https://doi.org/" prefix; normalize for comparison.
	return trimmed.replace(/^https?:\/\/doi\.org\//i, "").replace(/^doi:/i, "").trim().toLowerCase();
}

/** Normalize a title for loose comparison (lowercase, collapse whitespace/punctuation). */
function normalizeTitle(title: unknown): string | undefined {
	if (typeof title !== "string") return undefined;
	const cleaned = title.trim().toLowerCase();
	if (!cleaned) return undefined;
	return cleaned.replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

/** Extract a comparable first-author surname from a Zotero creators array. */
function firstAuthorSurname(creators: unknown): string | undefined {
	if (!Array.isArray(creators)) return undefined;
	const first = creators.find((c) => c && typeof c === "object" && (c as { creatorType?: string }).creatorType === "author") ??
		creators.find((c) => c && typeof c === "object");
	if (!first || typeof first !== "object") return undefined;
	const c = first as { lastName?: string; name?: string; firstName?: string };
	return (c.lastName ?? c.name ?? c.firstName ?? "").trim().toLowerCase() || undefined;
}

/**
 * Search the library for an existing item matching the candidate, to avoid creating a duplicate.
 * Match priority: DOI (exact), then title + first-author surname.
 * Returns the existing ZoteroItem or undefined.
 */
async function findExistingItem(
	cfg: ZoteroConfig,
	candidate: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<ZoteroItem | undefined> {
	const data = (candidate.data ?? candidate) as Record<string, unknown>;
	const doi = normalizeDoi(data.DOI);
	const title = normalizeTitle(data.title);
	const author = firstAuthorSurname(data.creators);

	// Skip dedup for items that have no usable identity (e.g. notes, attachments, standalone).
	if (!doi && !title) return undefined;

	const matchItem = (item: ZoteroItem): boolean => {
		const d = item.data;
		const itemDoi = normalizeDoi(d.DOI);
		if (doi && itemDoi === doi) return true;
		const itemTitle = normalizeTitle(d.title);
		if (title && itemTitle === title) {
			// Require author agreement when both sides have one, to avoid false positives
			// on generic titles. If either side lacks an author, title alone is accepted.
			const itemAuthor = firstAuthorSurname(d.creators);
			if (!author || !itemAuthor || author === itemAuthor) return true;
		}
		return false;
	};

	// DOI search: Zotero's q parameter matches DOI tokens, but we search broadly and filter.
	const queries: Array<{ q: string; qmode: "titleCreatorYear" }> = [];
	if (doi) queries.push({ q: doi, qmode: "titleCreatorYear" });
	if (title) queries.push({ q: data.title as string, qmode: "titleCreatorYear" });

	for (const q of queries) {
		const results = await searchItems(cfg, { ...q, top: true, limit: 25 }, signal);
		const hit = results.find(matchItem);
		if (hit) return hit;
	}
	return undefined;
}

/**
 * Resolve an item key to the attachment key whose fulltext `get`/`set`/`download`
 * act on. Attachments pass through; a parent (regular) item resolves to its
 * first PDF child (then any first child). Throws when there is no attachment
 * to address — the caller, not Zotero, then explains what to do.
 */
async function resolveAttachmentKey(
	cfg: ZoteroConfig,
	itemKey: string,
	signal?: AbortSignal,
): Promise<string> {
	const item = await getItem(cfg, itemKey, signal);
	if (item.data.itemType === "attachment") return item.key;
	const children = await getChildren(cfg, itemKey, signal);
	const pdf = children.find(
		(c) => c.data.itemType === "attachment" && (c.data as Record<string, unknown>).contentType === "application/pdf",
	);
	const anyAttachment = children.find((c) => c.data.itemType === "attachment");
	const hit = pdf ?? anyAttachment;
	if (!hit) throw new Error(`Item ${itemKey} is not an attachment and has no attachment children — pass an attachment key.`);
	return hit.key;
}

/** Normalize the add/remove item-membership params into the shape the client expects. */
function normalizeMembershipItems(
	params: { items?: Array<{ key: string; version: number; collections: string[] }>; itemKeys?: string[] },
): Array<{ key: string; version: number; collections: string[] }> {
	if (params.items?.length) return params.items;
	throw new Error(
		"items (array of { key, version, collections }) is required. Fetch each item's current version and collections via zotero_search or zotero_item get first.",
	);
}

/**
 * Attachment keys defining the coverage scope of an `everything` search, diffed
 * against the fulltext index map to produce `unindexedKeys`.
 *
 * - `itemKey` scope: the search returns exactly the requested items, so the
 *   returned `items` already are the scope (parents expanded to PDF children).
 * - `collectionKey` scope: direct members refetched (the search page may be a
 *   subset), top-level items expanded to their attachment children — collections
 *   hold direct members only.
 * - Unscoped: attachment hits on this result page. The library-wide blind spot
 *   can't be enumerated in one call, so page through `start` — each page
 *   reports its own unindexed attachments.
 *
 * Children expansion is capped at 50 parents; the caller treats the whole check
 * as best-effort (warning only, never fail-hard).
 */
async function attachmentKeysInScope(
	cfg: ZoteroConfig,
	scope: { collectionKey?: string; items: ZoteroItem[] },
	signal?: AbortSignal,
): Promise<string[]> {
	const members =
		scope.collectionKey
			? await listCollectionItems(cfg, scope.collectionKey, { limit: 100 }, signal)
			: scope.items;
	const keys: string[] = [];
	const parents: ZoteroItem[] = [];
	for (const m of members) {
		if (m.data.itemType === "attachment") keys.push(m.key);
		else if (parents.length < 50) parents.push(m);
	}
	const children = await Promise.all(
		parents.map((p) => getChildren(cfg, p.key, signal).catch(() => [] as ZoteroItem[])),
	);
	for (const kids of children) {
		for (const k of kids) {
			if (k.data.itemType === "attachment") keys.push(k.key);
		}
	}
	return [...new Set(keys)];
}

export function registerZoteroTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "zotero_search",
		label: "Zotero Search",
		description:
			"Search the user's Zotero library for papers/items by keyword, title/author/year, or full text. Returns metadata (key, version, title, creators, abstract, DOI, tags, collections). Use qmode='everything' to also search inside PDFs/full text. " +
				"Phrase/token matching, NOT relevance-ranked: position 30 == position 3, so do NOT limit:5 everything searches — default limit 25-50, page via start, watch totalResults. titleCreatorYear may keep 5-10. " +
				"everything needs indexed fulltext (unindexed attachments never match — the response lists them as unindexedKeys when qmode=everything); quote short tokens and single letters. " +
				"Pass itemKey='A,B,C' (up to 50) to fetch exactly those items, ignoring q. " +
				"Each result includes libraryVersion — pass it as since on a later search to get only items changed meanwhile.",
		promptSnippet: "Search the Zotero library by keyword or full text.",
		parameters: Type.Object({
			q: Type.String({ description: "Search query." }),
			qmode: StringEnum(["titleCreatorYear", "everything"] as const, {
				description: "Search mode. 'everything' includes full-text content.",
			}),
			itemType: Type.Optional(Type.String({ description: "Restrict to an item type, e.g. journalArticle." })),
			collectionKey: Type.Optional(Type.String({ description: "Restrict to a collection key." })),
			tag: Type.Optional(Type.String({ description: "Restrict to a tag." })),
			limit: Type.Optional(Type.Number({ description: "Max items to return (default 25; 50 when itemKey is given)." })),
			start: Type.Optional(Type.Number({ description: "0-based index of the first result. Combine with sort and limit for pagination." })),
			sort: Type.Optional(
				Type.String({
					description:
						"Sort field. There is NO relevance sort: default is dateModified. Valid: dateAdded, dateModified, title, creator, itemType, date, publisher, publicationTitle, journalAbbreviation, language, accessDate, libraryCatalog, callNumber, rights, addedBy, numItems.",
				}),
			),
			direction: Type.Optional(StringEnum(["asc", "desc"] as const, { description: "Sort direction." })),
			since: Type.Optional(
				Type.Number({
					description:
						"Library version — return only items modified since this version. Use the libraryVersion returned by a previous search; for incremental sync. 0 = everything.",
				}),
			),
			itemKey: Type.Optional(
				Type.String({
					description: "Comma-separated item keys (up to 50) — returns exactly these items, ignoring q. Without an explicit limit, up to 50 are returned.",
				}),
			),
			top: Type.Optional(Type.Boolean({ description: "Return only top-level items (excludes notes/attachments)." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const cfg = await resolveConfig(ctx);
			const { items, libraryVersion, totalResults } = await searchItemsWithVersion(
				cfg,
				{
					q: params.q,
					qmode: params.qmode,
					itemType: params.itemType,
					collectionKey: params.collectionKey,
					tag: params.tag,
					limit: params.limit ?? (params.itemKey ? 50 : 25),
					start: params.start,
					sort: params.sort,
					direction: params.direction,
					since: params.since,
					itemKey: params.itemKey,
					top: params.top,
				},
				signal,
			);
			// Coverage (warning only, never fail-hard): on `everything` searches, diff the
			// requested scope against the fulltext index map so the answer is
			// self-describing about completeness. A single unindexed item must not
			// fail the whole query — search still returns what is indexed.
			let unindexedKeys: string[] | undefined;
			if (params.qmode === "everything") {
				try {
					const indexMap = await getFullTextIndexMap(cfg, signal);
					const scopeKeys = await attachmentKeysInScope(
						cfg,
						{ collectionKey: params.collectionKey, items },
						signal,
					);
					const missing = scopeKeys.filter((k) => !(k in indexMap));
					if (missing.length) unindexedKeys = missing;
				} catch {
					// Best-effort: a failed map fetch must not fail the search itself.
				}
			}
			return textResult(cfg, {
				count: items.length,
				...(libraryVersion !== undefined ? { libraryVersion } : {}),
				...(totalResults !== undefined ? { totalResults } : {}),
				...(unindexedKeys ? { unindexedKeys } : {}),
				items: summarize(items),
			});
		},
	});

	pi.registerTool({
		name: "zotero_item",
		label: "Zotero Item CRUD",
		description:
			"Create, read, update, or delete a Zotero item (paper/note/etc.). " +
			"Actions: 'get' (fetch by key), 'create' (pass a full item object), 'update' (patch fields by key+version), 'delete' (by key+version). " +
			"On create, the library is first searched for an existing item with the same DOI (or title + first author); if a match is found it is returned (with duplicate:true) instead of creating a new entry. Pass forceCreate:true to skip this check. " +
			"Use zotero_template first to build a valid create/update payload.",
		promptSnippet: "Read, create, update, or delete a Zotero item (dedup on create).",
		parameters: Type.Object({
			action: StringEnum(["get", "create", "update", "delete"] as const, {
				description: "CRUD action to perform.",
			}),
			itemKey: Type.Optional(Type.String({ description: "Item key (required for get/update/delete)." })),
			version: Type.Optional(
				Type.Number({ description: "Current item version (required for update/delete; use the version returned by zotero_search/zotero_item get)." }),
			),
			item: Type.Optional(
				Type.Any({ description: "Full item object for create, or patch fields for update (e.g. {title, creators, abstractNote, tags})." }),
			),
			forceCreate: Type.Optional(
				Type.Boolean({
					description:
						"For create: skip the built-in duplicate check and always create a new item. Defaults to false, which searches the library for an existing item with the same DOI (or title + first author) and returns it instead of creating a duplicate.",
				}),
			),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const cfg = await resolveConfig(ctx);
			switch (params.action) {
				case "get": {
					if (!params.itemKey) throw new Error("itemKey is required for get.");
					const item = await getItem(cfg, params.itemKey, signal);
					return textResult(cfg, item);
				}
				case "create": {
					const item = coerceItem(params.item);
					if (!item || typeof item !== "object") {
						throw new Error("item (object or array of objects) is required for create.");
					}
					const items = Array.isArray(item) ? item : [item];
					// Dedup unless explicitly forced. For a single item, check the library for an
					// existing match (by DOI, then by title + first author) and return it instead of
					// creating a duplicate. Batches are created as-is to avoid ambiguous matches.
					if (!params.forceCreate && items.length === 1) {
						const existing = await findExistingItem(cfg, items[0] as Record<string, unknown>, signal);
						if (existing) {
							return textResult(cfg, { duplicate: true, existing: summarize([existing])[0], created: [] });
						}
					}
					const created = await createItems(cfg, items as Record<string, unknown>[], signal);
					return textResult(cfg, { created: summarize(created) });
				}
				case "update": {
					if (!params.itemKey) throw new Error("itemKey is required for update.");
					if (params.version === undefined) throw new Error("version is required for update.");
					const item = coerceItem(params.item);
					if (!item || typeof item !== "object") {
						throw new Error("item (patch object) is required for update.");
					}
					await updateItem(cfg, params.itemKey, params.version, item as Record<string, unknown>, signal);
					return textResult(cfg, { updated: params.itemKey, ok: true });
				}
				case "delete": {
					if (!params.itemKey) throw new Error("itemKey is required for delete.");
					if (params.version === undefined) throw new Error("version is required for delete.");
					await deleteItem(cfg, params.itemKey, params.version, signal);
					return textResult(cfg, { deleted: params.itemKey, ok: true });
				}
				default:
					throw new Error(`Unknown action: ${params.action}`);
			}
		},
	});

	pi.registerTool({
		name: "zotero_template",
		label: "Zotero Item Template",
		description:
			"Fetch a Zotero item template for a given itemType, to use as a base for zotero_item create/update payloads. Pass linkMode for attachment templates.",
		promptSnippet: "Get a Zotero item template to build create payloads.",
		parameters: Type.Object({
			itemType: Type.String({ description: "e.g. journalArticle, book, bookSection, attachment, note." }),
			linkMode: Type.Optional(
				Type.String({ description: "For itemType=attachment: imported_file, imported_url, linked_file, linked_url." }),
			),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const cfg = await resolveConfig(ctx);
			const template = await itemTemplate(params.itemType, params.linkMode, signal, cfg);
			return textResult(cfg, template);
		},
	});

	pi.registerTool({
		name: "zotero_attachment",
		label: "Zotero PDF / Attachment",
		description:
			"Manage attachment files (PDFs) in the Zotero library. " +
			"Actions: 'list' (children of a parent item), 'upload' (upload a local file as a stored attachment under a parent item), " +
			"'download' (download an attachment's file to a local path), 'delete' (delete an attachment item; requires its version).",
		promptSnippet: "List, upload, download, or delete Zotero attachment files.",
		parameters: Type.Object({
			action: StringEnum(["list", "upload", "download", "delete"] as const, {
				description: "Attachment action to perform.",
			}),
			itemKey: Type.Optional(
				Type.String({ description: "Attachment key (download/delete) or parent item key (list/upload)." }),
			),
			parentKey: Type.Optional(Type.String({ description: "Parent item key for upload. (Alias for itemKey.)" })),
			version: Type.Optional(Type.Number({ description: "Current attachment version (required for delete)." })),
			filePath: Type.Optional(
				Type.String({ description: "Local file path to upload (upload) or write to (download)." }),
			),
			title: Type.Optional(Type.String({ description: "Optional attachment title for upload (defaults to filename)." })),
			contentType: Type.Optional(Type.String({ description: "Optional MIME type for upload (default application/pdf)." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const cfg = await resolveConfig(ctx);
			switch (params.action) {
				case "list": {
					const key = params.itemKey ?? params.parentKey;
					if (!key) throw new Error("itemKey (parent item key) is required for list.");
					const children = await getChildren(cfg, key, signal);
					const attachments = children.filter((c) => c.data.itemType === "attachment");
					return textResult(cfg, { count: attachments.length, attachments: summarize(attachments) });
				}
				case "upload": {
					const parentKey = params.parentKey ?? params.itemKey;
					if (!parentKey) throw new Error("parentKey (or itemKey) is required for upload.");
					if (!params.filePath) throw new Error("filePath is required for upload.");
					const created = await uploadAttachmentFile(
						cfg,
						{
							parentKey,
							filePath: params.filePath,
							title: params.title,
							contentType: params.contentType,
						},
						signal,
					);
					return textResult(cfg, { uploaded: created.key, attachment: summarize([created])[0] });
				}
				case "download": {
					if (!params.itemKey) throw new Error("itemKey (attachment key) is required for download.");
					if (!params.filePath) throw new Error("filePath (output path) is required for download.");
					const result = await downloadAttachmentFile(
						cfg,
						{ itemKey: params.itemKey, outputPath: params.filePath },
						signal,
					);
					return textResult(cfg, result);
				}
				case "delete": {
					if (!params.itemKey) throw new Error("itemKey (attachment key) is required for delete.");
					if (params.version === undefined) throw new Error("version is required for delete.");
					await deleteItem(cfg, params.itemKey, params.version, signal);
				return textResult(cfg, { deleted: params.itemKey, ok: true });
				}
				default:
					throw new Error(`Unknown action: ${params.action}`);
			}
		},
	});

	pi.registerTool({
		name: "zotero_tags",
		label: "Zotero Tags",
		description:
			"Manage Zotero tags. Actions: 'list' (all tags in the library, or tags on one item when itemKey is given), " +
			"'get' (tags on a single item via its key), 'set' (replace an item's full tags array, requires the item version). " +
			"Each tag is { tag: string, type: 0|1 } where type 0=manual and 1=automatic. Use zotero_search with a tag param to filter by tag.",
		promptSnippet: "List or set Zotero tags on items.",
		parameters: Type.Object({
			action: StringEnum(["list", "get", "set"] as const, {
				description: "Tag action to perform.",
			}),
			itemKey: Type.Optional(
				Type.String({ description: "Item key. Required for 'get' and 'set'; for 'list' restricts to this item's tags (otherwise lists library tags)." }),
			),
			version: Type.Optional(
				Type.Number({ description: "Current item version (required for 'set'). Use the version returned by zotero_search/get." }),
			),
			tags: Type.Optional(
				Type.Array(
					Type.Object({
						tag: Type.String({ description: "Tag text." }),
						type: Type.Optional(Type.Number({ description: "0=manual (default), 1=automatic." })),
					}),
					{ description: "Full replacement tags array for 'set'. Replaces all existing tags on the item." },
				),
			),
			limit: Type.Optional(Type.Number({ description: "Max tags for 'list' (default 50)." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const cfg = await resolveConfig(ctx);
			switch (params.action) {
				case "list": {
					const tags = await listTags(cfg, { itemKey: params.itemKey, limit: params.limit ?? 50 }, signal);
					return textResult(cfg, { count: tags.length, tags });
				}
				case "get": {
					if (!params.itemKey) throw new Error("itemKey is required for get.");
					const tags = await listTags(cfg, { itemKey: params.itemKey }, signal);
					return textResult(cfg, { itemKey: params.itemKey, count: tags.length, tags });
				}
				case "set": {
					if (!params.itemKey) throw new Error("itemKey is required for set.");
					if (params.version === undefined) throw new Error("version is required for set.");
					if (!params.tags) throw new Error("tags array is required for set.");
					const normalized = params.tags.map((t) => ({
						tag: t.tag,
						type: t.type ?? 0,
					}));
					await setItemTags(cfg, params.itemKey, params.version, normalized, signal);
					return textResult(cfg, { itemKey: params.itemKey, set: normalized, ok: true });
				}
				default:
					throw new Error(`Unknown action: ${params.action}`);
			}
		},
	});

	pi.registerTool({
		name: "zotero_collection",
		label: "Zotero Collections",
		description:
			"Manage Zotero collections (folders). Actions: " +
			"'list' (top-level collections, or subcollections of a parent via parentKey), " +
			"'get' (one collection by key), 'items' (items in a collection; top=true for top-level only), " +
			"'create' (one or more collections: { name, parentCollection? }), 'rename' (patch name via key+version), " +
			"'delete' (by key+version), 'add' (add items to a collection via itemKeys+items [{key,version,collections}]), " +
			"'remove' (remove items from a collection).",
		promptSnippet: "List, create, rename, delete Zotero collections and move items in/out.",
		parameters: Type.Object({
			action: StringEnum(["list", "get", "items", "create", "rename", "delete", "add", "remove"] as const, {
				description: "Collection action to perform.",
			}),
			collectionKey: Type.Optional(
				Type.String({ description: "Collection key. Required for get/items/rename/delete/add/remove; subcollections parent for list." }),
			),
			parentKey: Type.Optional(
				Type.String({ description: "For list: list subcollections of this parent collection." }),
			),
			top: Type.Optional(Type.Boolean({ description: "For list: only top-level collections. For items: only top-level items." })),
			name: Type.Optional(Type.String({ description: "For create/rename: the collection name." })),
			parentCollection: Type.Optional(
				Type.String({ description: "For create: parent collection key (omit/false for top-level)." }),
			),
			version: Type.Optional(
				Type.Number({ description: "Current collection version (required for rename/delete)." }),
			),
			itemKeys: Type.Optional(Type.Array(Type.String(), { description: "For add/remove: item keys to add/remove." })),
			items: Type.Optional(
				Type.Array(
					Type.Object({
						key: Type.String(),
						version: Type.Number(),
						collections: Type.Array(Type.String()),
					}),
					{ description: "For add/remove: full item objects with current collections arrays (required so the patch preserves existing memberships)." },
				),
			),
			limit: Type.Optional(Type.Number({ description: "Max results (default 50)." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const cfg = await resolveConfig(ctx);
			switch (params.action) {
				case "list": {
					const cols = await listCollections(
						cfg,
						{ parentKey: params.parentKey, top: params.top, limit: params.limit ?? 50 },
						signal,
					);
					return textResult(cfg, {
						count: cols.length,
						collections: cols.map((c) => ({
							key: c.key,
							version: c.version,
							name: c.data.name,
							parentCollection: c.data.parentCollection,
						})),
					});
				}
				case "get": {
					if (!params.collectionKey) throw new Error("collectionKey is required for get.");
					return textResult(cfg, await getCollection(cfg, params.collectionKey, signal));
				}
				case "items": {
					if (!params.collectionKey) throw new Error("collectionKey is required for items.");
					const items = await listCollectionItems(
						cfg,
						params.collectionKey,
						{ top: params.top, limit: params.limit ?? 50 },
						signal,
					);
					return textResult(cfg, { count: items.length, items: summarize(items) });
				}
				case "create": {
					if (!params.name) throw new Error("name is required for create.");
					const toCreate = [{ name: params.name, parentCollection: params.parentCollection ?? false }];
					const created = await createCollections(cfg, toCreate, signal);
					return textResult(cfg, { created: created.map((c) => ({ key: c.key, version: c.version, name: c.data.name })) });
				}
				case "rename": {
					if (!params.collectionKey) throw new Error("collectionKey is required for rename.");
					if (params.version === undefined) throw new Error("version is required for rename.");
					if (!params.name) throw new Error("name is required for rename.");
					await updateCollection(cfg, params.collectionKey, params.version, { name: params.name }, signal);
					return textResult(cfg, { renamed: params.collectionKey, name: params.name, ok: true });
				}
				case "delete": {
					if (!params.collectionKey) throw new Error("collectionKey is required for delete.");
					if (params.version === undefined) throw new Error("version is required for delete.");
					await deleteCollection(cfg, params.collectionKey, params.version, signal);
					return textResult(cfg, { deleted: params.collectionKey, ok: true });
				}
				case "add": {
					if (!params.collectionKey) throw new Error("collectionKey is required for add.");
					const items = normalizeMembershipItems(params);
					await addItemsToCollection(cfg, params.collectionKey, items, signal);
					return textResult(cfg, { addedTo: params.collectionKey, count: items.length, ok: true });
				}
				case "remove": {
					if (!params.collectionKey) throw new Error("collectionKey is required for remove.");
					const items = normalizeMembershipItems(params);
					await removeItemsFromCollection(cfg, params.collectionKey, items, signal);
					return textResult(cfg, { removedFrom: params.collectionKey, count: items.length, ok: true });
				}
				default:
					throw new Error(`Unknown action: ${params.action}`);
			}
		},
	});

	pi.registerTool({
		name: "zotero_export",
		label: "Zotero Export",
		description:
			"Export Zotero items as a bibliography string (BibTeX, BibLaTeX, CSL JSON, RIS, CSV, MODS, COinS, Netscape bookmarks, or a formatted bibliography). " +
			"Select items by itemKeys, or export an entire collection via collectionKey. With no itemKeys and no collectionKey, exports the whole library.",
		promptSnippet: "Export Zotero items as BibTeX/CSL-JSON/etc.",
		parameters: Type.Object({
			format: StringEnum(
				["bib", "bibtex", "biblatex", "csljson", "ris", "csv", "mods", "coins", "bookmarks"] as const,
				{ description: "Export format. 'bib' returns a formatted bibliography; the rest return structured data." },
			),
			itemKeys: Type.Optional(
				Type.Array(Type.String(), { description: "Specific item keys to export (recommended after a search)." }),
			),
			collectionKey: Type.Optional(
				Type.String({ description: "Export all items in this collection. Ignored when itemKeys is given." }),
			),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const cfg = await resolveConfig(ctx);
			if (!params.itemKeys?.length && !params.collectionKey) {
				throw new Error(
					"Provide itemKeys (recommended) or collectionKey. Exporting the entire library can be very large and is discouraged.",
				);
			}
			const exported = await exportItems(
				cfg,
				{
					format: params.format,
					itemKeys: params.itemKeys,
					collectionKey: params.collectionKey,
					signal,
				},
				signal,
			);
			return textResult(undefined, { format: params.format, chars: exported.length, content: exported });
			},
	});

	pi.registerTool({
		name: "zotero_schema",
		label: "Zotero Schema",
		description:
			"Read-only access to Zotero's item-type schema so the agent can construct valid create/update payloads. " +
			"Actions: 'itemTypes' (all item types), 'itemFields' (all fields), 'itemTypeFields' (valid fields for one itemType — requires itemType), " +
			"'creatorTypes' (valid creator types for one itemType — requires itemType), 'creatorFields' (localized firstName/lastName/name). " +
			"No key needed (public Web-API endpoints; served locally by the Local API when in local mode). Use zotero_template for a ready-to-fill item, and this for discovering valid fields/creators for exotic types.",
		promptSnippet: "Look up valid Zotero item types, fields, and creator types.",
		parameters: Type.Object({
			action: StringEnum(["itemTypes", "itemFields", "itemTypeFields", "creatorTypes", "creatorFields"] as const, {
				description: "Schema query to perform.",
			}),
			itemType: Type.Optional(
				Type.String({ description: "Required for itemTypeFields and creatorTypes (e.g. journalArticle, book)." }),
			),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const cfg = await resolveConfig(ctx);
			switch (params.action) {
				case "itemTypes":
					return textResult(cfg, await listItemTypes(cfg, signal));
				case "itemFields":
					return textResult(cfg, await listItemFields(cfg, signal));
				case "itemTypeFields": {
					if (!params.itemType) throw new Error("itemType is required for itemTypeFields.");
					return textResult(cfg, await listItemTypeFields(params.itemType, cfg, signal));
				}
				case "creatorTypes": {
					if (!params.itemType) throw new Error("itemType is required for creatorTypes.");
					return textResult(cfg, await listCreatorTypes(params.itemType, cfg, signal));
				}
				case "creatorFields":
					return textResult(cfg, await listCreatorFields(cfg, signal));
				default:
					throw new Error(`Unknown action: ${params.action}`);
			}
		},
	});

	pi.registerTool({
		name: "zotero_fulltext",
		label: "Zotero Full Text",
		description:
			"Extracted full-text content for Zotero attachments (what qmode='everything' searches). " +
			"Actions: 'set' (store caller-supplied extracted text — multi-page text must be joined with \f like Zotero's own extractor; indexedChars/totalChars for text docs or indexedPages/totalPages for PDFs; enables everything-search without the desktop client. An explicit native Reindex later overwrites set text with PDF-extracted text), " +
			"'download' (write an attachment's fulltext to a tmp file for grep/read — accepts a parent item key, resolving to its PDF child; keeps text out of context), " +
			"'get' (returns the WHOLE content inline — debugging only; use download for answering).",
		promptSnippet: "Read or write Zotero attachment full-text content.",
		parameters: Type.Object({
			action: StringEnum(["get", "set", "download"] as const, { description: "Full-text action to perform." }),
			itemKey: Type.String({ description: "Attachment item key (set/download also accept a parent item key, resolving to its PDF child)." }),
			content: Type.Optional(Type.String({ description: "Extracted text to store (required for 'set'). Multi-page text: join pages with \f." })),
			indexedChars: Type.Optional(Type.Number({ description: "Indexed character count (text docs)." })),
			totalChars: Type.Optional(Type.Number({ description: "Total character count (text docs)." })),
			indexedPages: Type.Optional(Type.Number({ description: "Indexed page count (PDFs)." })),
			totalPages: Type.Optional(Type.Number({ description: "Total page count (PDFs)." })),
			filePath: Type.Optional(Type.String({ description: "Output path for 'download' (default: tmpdir/zotero-fulltext-<KEY>.txt)." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const cfg = await resolveConfig(ctx);
			switch (params.action) {
				case "get": {
					// Thin pass-through (debugging only): no parent-key resolution,
					// no MIME precheck — the skill path is `download`, not `get`.
					const ft = await getFullText(cfg, params.itemKey, signal);
					return textResult(cfg, { itemKey: params.itemKey, ...ft });
				}
				case "set": {
					// Hardening (PLAN 3.1): content is ALWAYS caller-supplied --
					// the tool never extracts, probes converters, or shells out.
					// Validate locally so failures precede the PUT, not server 400s.
					if (typeof params.content !== "string" || !params.content.length) {
						throw new Error("content (non-empty string) is required for set -- extract the PDF yourself, then pass its text.");
					}
					const hasCharsPair = params.indexedChars !== undefined || params.totalChars !== undefined;
					const hasPagesPair = params.indexedPages !== undefined || params.totalPages !== undefined;
					if (!hasCharsPair && !hasPagesPair) {
						throw new Error(
							"One stats pair is required for set: indexedChars/totalChars (text docs) or indexedPages/totalPages (PDFs).",
						);
					}
					for (const [name, v] of [
						["indexedChars", params.indexedChars],
						["totalChars", params.totalChars],
						["indexedPages", params.indexedPages],
						["totalPages", params.totalPages],
					] as const) {
						if (v !== undefined && (!Number.isInteger(v) || v < 0)) {
							throw new Error(`'${name}' must be a non-negative integer.`);
						}
					}
					if (params.content.length > MAX_FULLTEXT_CHARS) {
						throw new Error(
							`content is ${params.content.length} chars -- over Zotero’s ~${MAX_FULLTEXT_CHARS}-char fulltext cap. Truncate (multi-page: keep \\f joins) and retry.`,
						);
					}
					// MIME precheck (always runs): friendlier than the server's
					// after-the-fact 400 for non-indexable types.
					const attachmentKey = await resolveAttachmentKey(cfg, params.itemKey, signal);
					const target = await getItem(cfg, attachmentKey, signal);
					const mime = (target.data as Record<string, unknown>).contentType;
					if (!isIndexableMime(mime)) {
						throw new Error(
							`Item ${attachmentKey} has contentType ${JSON.stringify(mime ?? "(none)")} -- fulltext is only stored for PDF / text / EPUB attachments.`,
						);
					}
					// Idempotency: mirrors setItemContent's fast path (same text
					// --> version bump only). Skip the PUT, report unchanged:true.
					try {
						const existing = await getFullText(cfg, attachmentKey, signal);
						if (existing.content === params.content) {
							return textResult(cfg, { itemKey: attachmentKey, unchanged: true, ok: true });
						}
					} catch (err) {
						if (!(err instanceof ZoteroError) || err.status !== 404) throw err;
						// No fulltext yet -- fall through to the PUT.
					}
					const payload = {
						content: params.content,
						...(params.indexedChars !== undefined ? { indexedChars: params.indexedChars } : {}),
						...(params.totalChars !== undefined ? { totalChars: params.totalChars } : {}),
						...(params.indexedPages !== undefined ? { indexedPages: params.indexedPages } : {}),
						...(params.totalPages !== undefined ? { totalPages: params.totalPages } : {}),
					};
					await setFullText(cfg, attachmentKey, payload, signal);
					return textResult(cfg, { itemKey: attachmentKey, set: true, ok: true });
				}
				case "download": {
					// Keeps text out of context by construction (PLAN 6 Q3): the
					// extension owns base URL / prefix / auth; the skill greps the file.
					const key = await resolveAttachmentKey(cfg, params.itemKey, signal);
					const ft = await getFullText(cfg, key, signal);
					const outPath = params.filePath ?? join(tmpdir(), `zotero-fulltext-${key}.txt`);
					await writeFile(outPath, ft.content, "utf-8");
					return textResult(cfg, {
						itemKey: key,
						path: outPath,
						chars: ft.content.length,
						...(ft.indexedPages !== undefined ? { indexedPages: ft.indexedPages } : {}),
						...(ft.totalPages !== undefined ? { totalPages: ft.totalPages } : {}),
						...(ft.indexedChars !== undefined ? { indexedChars: ft.indexedChars } : {}),
						...(ft.totalChars !== undefined ? { totalChars: ft.totalChars } : {}),
					});
				}
				default:
					throw new Error(`Unknown action: ${params.action}`);
			}
		},
	});

	pi.registerTool({
		name: "zotero_group_list",
		label: "Zotero Groups",
		description:
			"List the Zotero group libraries (shared libraries) the account belongs to: group id, name, visibility, the account's role, and item count. " +
			"Group listing is Web-API-only — the Local API mirrors /groups/:id/... but cannot enumerate memberships. " +
			"To target a group library, add its id as ZOTERO_GROUP_ID under the credential's env in ~/.pi/agent/auth.json (set manually; /login does not prompt for it).",
		promptSnippet: "List the Zotero group libraries (shared libraries) the account belongs to.",
		parameters: Type.Object({}),
		async execute(_id, _params, signal, _onUpdate, ctx) {
			const cfg = await resolveConfig(ctx);
			return textResult(cfg, await listGroups(cfg, signal));
		},
	});
}
