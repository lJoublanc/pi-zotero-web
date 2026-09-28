import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerZoteroTools } from "../tools.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mockFetch } from "./_mock.ts";

/** A minimal harness capturing the last registered tool so we can call execute(). */
function harness() {
	const tools = new Map<string, ReturnType<NonNullable<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>>>();
	const api = {
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	registerZoteroTools(api);

	function ctx(auth: unknown, localAuth?: unknown): ExtensionContext {
		return {
			cwd: process.cwd(),
			isProjectTrusted: () => true,
			modelRegistry: {
				getProviderAuth: async (providerId: string) =>
					providerId === "zotero" ? auth : providerId === "zotero-local" ? localAuth : undefined,
			},
		} as unknown as ExtensionContext;
	}
	return { tools, ctx };
}

const AUTH = { auth: { apiKey: "KEY" }, env: { ZOTERO_USER_ID: "42" } };
const NO_AUTH = undefined;

describe("tools.zotero_search", () => {
	it("resolves config and returns summarized items", async () => {
		const { tools, ctx } = harness();
		const handle = mockFetch((c) =>
			c.url.includes("/users/42/items?")
				? { status: 200, body: [{ key: "K1", version: 1, data: { itemType: "journalArticle", title: "Paper", abstractNote: "abs" } }] }
				: undefined,
		);
		const res = await tools.get("zotero_search")!.execute("id", { q: "x" }, undefined, undefined, ctx(AUTH));
		const text = (res.content[0] as { text: string }).text;
		const parsed = JSON.parse(text);
		assert.equal(parsed.count, 1);
		assert.equal(parsed.items[0].title, "Paper");
		assert.equal(parsed.items[0].key, "K1");
		handle.restore();
	});

	it("passes start/sort/direction/since/itemKey through to the query", async () => {
		const { tools, ctx } = harness();
		const handle = mockFetch((c) =>
			c.url.includes("/users/42/items?")
				? { status: 200, headers: { "Last-Modified-Version": "77" }, body: [] }
				: undefined,
		);
		const res = await tools
			.get("zotero_search")!
			.execute(
				"id",
				{ q: "x", start: 5, sort: "title", direction: "asc", since: 70, itemKey: "K1,K2", limit: 3 },
				undefined,
				undefined,
				ctx(AUTH),
			);
		const call = handle.calls[0]!;
		assert.match(call.url, /start=5/);
		assert.match(call.url, /sort=title/);
		assert.match(call.url, /direction=asc/);
		assert.match(call.url, /since=70/);
		assert.match(call.url, /limit=3/);
		assert.match(call.url, /itemKey=K1%2CK2/);
		const parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal(parsed.count, 0);
		assert.equal(parsed.libraryVersion, 77);
		handle.restore();
	});

	it("defaults limit to 50 for itemKey lookups", async () => {
		const { tools, ctx } = harness();
		const handle = mockFetch((c) => (c.url.includes("/users/42/items?") ? { status: 200, body: [] } : undefined));
		await tools.get("zotero_search")!.execute("id", { itemKey: "K1" }, undefined, undefined, ctx(AUTH));
		assert.match(handle.calls[0]!.url, /limit=50/);
		handle.restore();
	});

	it("everything search lists unindexedKeys iff the index map lacks a key", async () => {
		const items = [
			{ key: "ATT1", version: 3, data: { itemType: "attachment", title: "paper pdf" } },
			{ key: "P1", version: 4, data: { itemType: "journalArticle", title: "some paper" } },
		];
		const searchMock = (indexMap: Record<string, number>) =>
			mockFetch((c) => {
				if (c.url.includes("/users/42/items?"))
					return { status: 200, headers: { "Total-Results": "2" }, body: items };
				if (c.url.endsWith("/users/42/fulltext?since=0")) return { status: 200, body: indexMap };
				if (c.url.includes("/users/42/items/P1/children?")) return { status: 200, body: [] };
				return undefined;
			});
		const { tools, ctx } = harness();
		// Index map lacks ATT1 -> warned inline; search still returns what is indexed.
		let handle = searchMock({});
		let res = await tools.get("zotero_search")!.execute("id", { q: "elu", qmode: "everything" }, undefined, undefined, ctx(AUTH));
		let parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.deepEqual(parsed.unindexedKeys, ["ATT1"]);
		assert.equal(parsed.totalResults, 2);
		handle.restore();
		// Index map covers ATT1 -> no warning key at all.
		handle = searchMock({ ATT1: 9 });
		res = await tools.get("zotero_search")!.execute("id", { q: "elu", qmode: "everything" }, undefined, undefined, ctx(AUTH));
		parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal("unindexedKeys" in parsed, false);
		handle.restore();
	});

	it("JSON results carry the {mode, library} envelope", async () => {
		const { tools, ctx } = harness();
		const handle = mockFetch((c) =>
			c.url.includes("/users/42/items?") ? { status: 200, body: [] } : undefined,
		);
		const res = await tools.get("zotero_search")!.execute("id", { q: "x" }, undefined, undefined, ctx(AUTH));
		const parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal(parsed.mode, "web");
		assert.equal(parsed.library, "users/42");
		handle.restore();
	});

	it("falls back to the Local API read-only when no credentials are stored", async () => {
		const { tools, ctx } = harness();
		const handle = mockFetch((c) =>
			c.url.startsWith("http://127.0.0.1:23119/api/users/0/items?") ? { status: 200, body: [] } : undefined,
		);
		const res = await tools.get("zotero_search")!.execute("id", { q: "x" }, undefined, undefined, ctx(NO_AUTH));
		const parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal(parsed.count, 0);
		assert.match(handle.calls[0]!.url, /127\.0\.0\.1:23119\/api\/users\/0\/items/);
		handle.restore();
	});
});

describe("tools.zotero_item", () => {
	it("get returns the item", async () => {
		const { tools, ctx } = harness();
		const handle = mockFetch((c) =>
			c.url.endsWith("/users/42/items/AB?format=json") ? { status: 200, body: { key: "AB", version: 3, data: {} } } : undefined,
		);
		const res = await tools.get("zotero_item")!.execute("id", { action: "get", itemKey: "AB" }, undefined, undefined, ctx(AUTH));
		const parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal(parsed.key, "AB");
		handle.restore();
	});

	it("create posts the item object (no duplicate found)", async () => {
		const { tools, ctx } = harness();
		const handle = mockFetch((c) => {
			// dedup search returns no matches, then the POST creates.
			if (c.method === "GET" && c.url.includes("/users/42/items/top?")) return { status: 200, body: [] };
			if (c.method === "POST" && c.url.endsWith("/users/42/items"))
				return { status: 200, body: { successful: { "0": { key: "NEW", version: 1, data: {} } }, success: { "0": "NEW" }, unchanged: {}, failed: {} } };
			return undefined;
		});
		const res = await tools
			.get("zotero_item")!
			.execute("id", { action: "create", item: { itemType: "journalArticle", title: "T" } }, undefined, undefined, ctx(AUTH));
		const parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal(parsed.created[0].key, "NEW");
		handle.restore();
	});

	it("create accepts a JSON-stringified item (provider serialization fallback)", async () => {
		const { tools, ctx } = harness();
		let posted: unknown;
		const handle = mockFetch((c) => {
			if (c.method === "GET" && c.url.includes("/users/42/items/top?")) return { status: 200, body: [] };
			if (c.method === "POST" && c.url.endsWith("/users/42/items")) {
				posted = JSON.parse(c.body as string);
				return { status: 200, body: { successful: { "0": { key: "NEW2", version: 1, data: {} } }, success: { "0": "NEW2" }, unchanged: {}, failed: {} } };
			}
			return undefined;
		});
		const res = await tools
			.get("zotero_item")!
			.execute(
				"id",
				{ action: "create", item: JSON.stringify({ itemType: "preprint", title: "Str" }) },
				undefined,
				undefined,
				ctx(AUTH),
			);
		const parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal(parsed.created[0].key, "NEW2");
		assert.equal(Array.isArray(posted), true);
		assert.equal((posted as Array<{ title: string }>)[0]!.title, "Str");
		handle.restore();
	});

	it("create rejects an invalid JSON string item with a helpful error", async () => {
		const { tools, ctx } = harness();
		await assert.rejects(
			() =>
				tools
					.get("zotero_item")!
					.execute("id", { action: "create", item: "{not json" }, undefined, undefined, ctx(AUTH)),
			/not valid JSON/,
		);
	});

	it("create returns existing item when a DOI match is found (no POST)", async () => {
		const { tools, ctx } = harness();
		let posted = false;
		const handle = mockFetch((c) => {
			if (c.method === "POST") {
				posted = true;
				return { status: 200, body: [] };
			}
			// DOI search returns an existing match.
			if (c.method === "GET" && c.url.includes("/users/42/items/top?"))
				return {
					status: 200,
					body: [{ key: "EXIST", version: 7, data: { itemType: "journalArticle", DOI: "10.1000/xyz", title: "Same" } }],
				};
			return undefined;
		});
		const res = await tools
			.get("zotero_item")!
			.execute(
				"id",
				{ action: "create", item: { itemType: "journalArticle", DOI: "10.1000/xyz", title: "Same" } },
				undefined,
				undefined,
				ctx(AUTH),
			);
		const parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal(parsed.duplicate, true);
		assert.equal(parsed.existing.key, "EXIST");
		assert.equal(parsed.created.length, 0);
		assert.equal(posted, false);
		handle.restore();
	});

	it("create returns existing item when title + author match", async () => {
		const { tools, ctx } = harness();
		let posted = false;
		const handle = mockFetch((c) => {
			if (c.method === "POST") {
				posted = true;
				return { status: 200, body: [] };
			}
			if (c.method === "GET" && c.url.includes("/users/42/items/top?"))
				return {
					status: 200,
					body: [
						{
							key: "OLD",
							version: 2,
							data: {
								itemType: "journalArticle",
								title: "A Great Paper",
								creators: [{ creatorType: "author", lastName: "Smith" }],
							},
						},
					],
				};
			return undefined;
		});
		const res = await tools
			.get("zotero_item")!
			.execute(
				"id",
				{
					action: "create",
					item: {
						itemType: "journalArticle",
						title: "a   great   paper!",
						creators: [{ creatorType: "author", lastName: "smith" }],
					},
				},
				undefined,
				undefined,
				ctx(AUTH),
			);
		const parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal(parsed.duplicate, true);
		assert.equal(parsed.existing.key, "OLD");
		assert.equal(posted, false);
		handle.restore();
	});

	it("create with forceCreate:true skips the dedup search", async () => {
		const { tools, ctx } = harness();
		let getSearched = false;
		const handle = mockFetch((c) => {
			if (c.method === "GET") {
				getSearched = true;
				return { status: 200, body: [] };
			}
			if (c.method === "POST" && c.url.endsWith("/users/42/items"))
				return { status: 200, body: { successful: { "0": { key: "FORCED", version: 1, data: {} } }, success: { "0": "FORCED" }, unchanged: {}, failed: {} } };
			return undefined;
		});
		const res = await tools
			.get("zotero_item")!
			.execute(
				"id",
				{ action: "create", item: { itemType: "journalArticle", DOI: "10.1/abc", title: "X" }, forceCreate: true },
				undefined,
				undefined,
				ctx(AUTH),
			);
		const parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal(parsed.created[0].key, "FORCED");
		assert.equal(getSearched, false);
		handle.restore();
	});

	it("create with an item array skips dedup and creates all", async () => {
		const { tools, ctx } = harness();
		const handle = mockFetch((c) => {
			if (c.method === "POST" && c.url.endsWith("/users/42/items"))
				return { status: 200, body: { successful: { "0": { key: "A", version: 1, data: {} }, "1": { key: "B", version: 1, data: {} } }, success: { "0": "A", "1": "B" }, unchanged: {}, failed: {} } };
			return undefined;
		});
		const res = await tools
			.get("zotero_item")!
			.execute("id", { action: "create", item: [{ itemType: "journalArticle", title: "T1" }, { itemType: "journalArticle", title: "T2" }] }, undefined, undefined, ctx(AUTH));
		const parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal(parsed.created.length, 2);
		handle.restore();
	});

	it("update requires version", async () => {
		const { tools, ctx } = harness();
		await assert.rejects(
			() => tools.get("zotero_item")!.execute("id", { action: "update", itemKey: "K", item: { title: "n" } }, undefined, undefined, ctx(AUTH)),
			/version is required/,
		);
	});

	it("update patches with the given version", async () => {
		const { tools, ctx } = harness();
		const handle = mockFetch((c) =>
			c.method === "PATCH" && c.url.endsWith("/users/42/items/K") ? { status: 200, body: "" } : undefined,
		);
		const res = await tools
			.get("zotero_item")!
			.execute("id", { action: "update", itemKey: "K", version: 7, item: { title: "n" } }, undefined, undefined, ctx(AUTH));
		assert.equal(handle.calls[0]!.headers["if-unmodified-since-version"], "7");
		const parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal(parsed.ok, true);
		handle.restore();
	});

	it("delete requires version", async () => {
		const { tools, ctx } = harness();
		await assert.rejects(
			() => tools.get("zotero_item")!.execute("id", { action: "delete", itemKey: "K" }, undefined, undefined, ctx(AUTH)),
			/version is required/,
		);
	});
});

describe("tools.zotero_template", () => {
	it("returns the template (no auth; local /items/new 404s -> Web API)", async () => {
		const { tools, ctx } = harness();
		const handle = mockFetch((c) => {
			if (c.url === "http://127.0.0.1:23119/api/items/new?itemType=note") return { status: 404, body: "Not found" };
			if (c.url.startsWith("https://api.zotero.org/items/new?")) return { status: 200, body: { itemType: "note" } };
			return undefined;
		});
		const res = await tools.get("zotero_template")!.execute("id", { itemType: "note" }, undefined, undefined, ctx(NO_AUTH));
		const parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal(parsed.itemType, "note");
		handle.restore();
	});
});

describe("tools.zotero_attachment", () => {
	it("list filters children to attachments", async () => {
		const { tools, ctx } = harness();
		const handle = mockFetch((c) =>
			c.url.includes("/users/42/items/P/children?")
				? {
						status: 200,
						body: [
							{ key: "N1", data: { itemType: "note" } },
							{ key: "A1", data: { itemType: "attachment", title: "pdf" } },
						],
					}
				: undefined,
		);
		const res = await tools.get("zotero_attachment")!.execute("id", { action: "list", itemKey: "P" }, undefined, undefined, ctx(AUTH));
		const parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal(parsed.count, 1);
		assert.equal(parsed.attachments[0].key, "A1");
		handle.restore();
	});

	it("download requires filePath", async () => {
		const { tools, ctx } = harness();
		await assert.rejects(
			() => tools.get("zotero_attachment")!.execute("id", { action: "download", itemKey: "A" }, undefined, undefined, ctx(AUTH)),
			/filePath/,
		);
	});

	it("delete requires version", async () => {
		const { tools, ctx } = harness();
		await assert.rejects(
			() => tools.get("zotero_attachment")!.execute("id", { action: "delete", itemKey: "A" }, undefined, undefined, ctx(AUTH)),
			/version is required/,
		);
	});
});

describe("tools.zotero_tags", () => {
	it("list returns library tags", async () => {
		const { tools, ctx } = harness();
		const handle = mockFetch((c) =>
			c.url.includes("/users/42/tags?") ? { status: 200, body: [{ tag: "to-read", type: 0, items: 2 }] } : undefined,
		);
		const res = await tools.get("zotero_tags")!.execute("id", { action: "list" }, undefined, undefined, ctx(AUTH));
		const parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal(parsed.count, 1);
		assert.equal(parsed.tags[0].tag, "to-read");
		handle.restore();
	});

	it("list scoped to an item uses the item-tags path", async () => {
		const { tools, ctx } = harness();
		const handle = mockFetch((c) =>
			c.url.includes("/users/42/items/K1/tags?") ? { status: 200, body: [{ tag: "ML", type: 1 }] } : undefined,
		);
		await tools.get("zotero_tags")!.execute("id", { action: "list", itemKey: "K1" }, undefined, undefined, ctx(AUTH));
		assert.match(handle.calls[0]!.url, /\/items\/K1\/tags\?/);
		handle.restore();
	});

	it("get requires itemKey", async () => {
		const { tools, ctx } = harness();
		await assert.rejects(
			() => tools.get("zotero_tags")!.execute("id", { action: "get" }, undefined, undefined, ctx(AUTH)),
			/itemKey is required/,
		);
	});

	it("set requires version and tags", async () => {
		const { tools, ctx } = harness();
		await assert.rejects(
			() => tools.get("zotero_tags")!.execute("id", { action: "set", itemKey: "K" }, undefined, undefined, ctx(AUTH)),
			/version is required/,
		);
		await assert.rejects(
			() => tools.get("zotero_tags")!.execute("id", { action: "set", itemKey: "K", version: 1 }, undefined, undefined, ctx(AUTH)),
			/tags array is required/,
		);
	});

	it("set patches with normalized tags (defaults type to 0)", async () => {
		const { tools, ctx } = harness();
		const handle = mockFetch((c) =>
			c.method === "PATCH" && c.url.endsWith("/users/42/items/K") ? { status: 200, body: "" } : undefined,
		);
		const res = await tools
			.get("zotero_tags")!
			.execute("id", { action: "set", itemKey: "K", version: 5, tags: [{ tag: "a" }, { tag: "b", type: 1 }] }, undefined, undefined, ctx(AUTH));
		const call = handle.calls[0];
		assert.equal(call!.headers["if-unmodified-since-version"], "5");
		const body = JSON.parse(call!.body as string);
		assert.deepEqual(body.tags, [{ tag: "a", type: 0 }, { tag: "b", type: 1 }]);
		const parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal(parsed.ok, true);
		handle.restore();
	});
});

describe("tools.zotero_collection", () => {
	it("list returns summarized collections", async () => {
		const { tools, ctx } = harness();
		const handle = mockFetch((c) =>
			c.url.includes("/users/42/collections?") && !c.url.includes("/collections/")
				? { status: 200, body: [{ key: "C1", version: 1, data: { name: "Read", parentCollection: false } }] }
				: undefined,
		);
		const res = await tools.get("zotero_collection")!.execute("id", { action: "list" }, undefined, undefined, ctx(AUTH));
		const parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal(parsed.count, 1);
		assert.equal(parsed.collections[0].name, "Read");
		handle.restore();
	});

	it("create requires name", async () => {
		const { tools, ctx } = harness();
		await assert.rejects(
			() => tools.get("zotero_collection")!.execute("id", { action: "create" }, undefined, undefined, ctx(AUTH)),
			/name is required/,
		);
	});

	it("rename requires version", async () => {
		const { tools, ctx } = harness();
		await assert.rejects(
			() => tools.get("zotero_collection")!.execute("id", { action: "rename", collectionKey: "C", name: "n" }, undefined, undefined, ctx(AUTH)),
			/version is required/,
		);
	});

	it("rename patches the name with the version", async () => {
		const { tools, ctx } = harness();
		const handle = mockFetch((c) =>
			c.method === "PATCH" && c.url.endsWith("/users/42/collections/C") ? { status: 200, body: "" } : undefined,
		);
		const res = await tools
			.get("zotero_collection")!
			.execute("id", { action: "rename", collectionKey: "C", version: 8, name: "Renamed" }, undefined, undefined, ctx(AUTH));
		assert.equal(handle.calls[0]!.headers["if-unmodified-since-version"], "8");
		const parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal(parsed.ok, true);
		handle.restore();
	});

	it("delete requires version", async () => {
		const { tools, ctx } = harness();
		await assert.rejects(
			() => tools.get("zotero_collection")!.execute("id", { action: "delete", collectionKey: "C" }, undefined, undefined, ctx(AUTH)),
			/version is required/,
		);
	});

	it("items requires collectionKey", async () => {
		const { tools, ctx } = harness();
		await assert.rejects(
			() => tools.get("zotero_collection")!.execute("id", { action: "items" }, undefined, undefined, ctx(AUTH)),
			/collectionKey is required/,
		);
	});

	it("add requires items array", async () => {
		const { tools, ctx } = harness();
		await assert.rejects(
			() => tools.get("zotero_collection")!.execute("id", { action: "add", collectionKey: "C" }, undefined, undefined, ctx(AUTH)),
			/items .* is required/,
		);
	});

	it("add merges memberships via item patches", async () => {
		const { tools, ctx } = harness();
		const handle = mockFetch((c) =>
			c.method === "PATCH" && c.url.endsWith("/users/42/items/I1") ? { status: 200, body: "" } : undefined,
		);
		await tools
			.get("zotero_collection")!
			.execute("id", { action: "add", collectionKey: "COL", items: [{ key: "I1", version: 3, collections: ["OTHER"] }] }, undefined, undefined, ctx(AUTH));
		const body = JSON.parse(handle.calls[0]!.body as string);
		assert.deepEqual(body.collections, ["OTHER", "COL"]);
		handle.restore();
	});
});

describe("tools.zotero_export", () => {
	it("requires itemKeys or collectionKey", async () => {
		const { tools, ctx } = harness();
		await assert.rejects(
			() => tools.get("zotero_export")!.execute("id", { format: "bibtex" }, undefined, undefined, ctx(AUTH)),
			/Provide itemKeys .* or collectionKey/,
		);
	});

	it("returns the exported string with metadata", async () => {
		const { tools, ctx } = harness();
		const handle = mockFetch((c) =>
			c.url.includes("format=bibtex") && c.url.includes("itemKey=A")
				? { status: 200, body: "@misc{A,}" }
				: undefined,
		);
		const res = await tools
			.get("zotero_export")!
			.execute("id", { format: "bibtex", itemKeys: ["A"] }, undefined, undefined, ctx(AUTH));
		const parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal(parsed.format, "bibtex");
		assert.equal(parsed.content, "@misc{A,}");
		assert.equal(parsed.chars, 9);
		handle.restore();
	});
});

describe("tools.zotero_schema", () => {
	it("itemTypes reads from the Local API without auth in read-only mode", async () => {
		const { tools, ctx } = harness();
		const handle = mockFetch((c) =>
			c.url === "http://127.0.0.1:23119/api/itemTypes" ? { status: 200, body: [{ itemType: "book", localized: "Book" }] } : undefined,
		);
		const res = await tools.get("zotero_schema")!.execute("id", { action: "itemTypes" }, undefined, undefined, ctx(NO_AUTH));
		const parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal(parsed[0].itemType, "book");
		handle.restore();
	});

	it("itemTypeFields requires itemType", async () => {
		const { tools, ctx } = harness();
		await assert.rejects(
			() => tools.get("zotero_schema")!.execute("id", { action: "itemTypeFields" }, undefined, undefined, ctx(AUTH)),
			/itemType is required/,
		);
	});

	it("creatorTypes requires itemType", async () => {
		const { tools, ctx } = harness();
		await assert.rejects(
			() => tools.get("zotero_schema")!.execute("id", { action: "creatorTypes" }, undefined, undefined, ctx(AUTH)),
			/itemType is required/,
		);
	});

	it("creatorTypes passes itemType through", async () => {
		const { tools, ctx } = harness();
		const handle = mockFetch((c) =>
			c.url.includes("itemTypeCreatorTypes?") && c.url.includes("itemType=book")
				? { status: 200, body: [{ creatorType: "author", localized: "Author" }] }
				: undefined,
		);
		const res = await tools.get("zotero_schema")!.execute("id", { action: "creatorTypes", itemType: "book" }, undefined, undefined, ctx(AUTH));
		const parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal(parsed[0].creatorType, "author");
		handle.restore();
	});
});

describe("tools.zotero_fulltext", () => {
	it("get writes fulltext to a file and returns its path (never inline)", async () => {
		const { tools, ctx } = harness();
		const dir = await mkdtemp(join(tmpdir(), "zotero-ft-"));
		const out = join(dir, "out.txt");
		const handle = mockFetch((c) => {
			if (c.url.endsWith("/users/42/items/ATT?format=json"))
				return { status: 200, body: { key: "ATT", version: 9, data: { itemType: "attachment", contentType: "application/pdf" } } };
			if (c.url.endsWith("/users/42/items/ATT/fulltext"))
				return { status: 200, body: { content: "hello", indexedPages: 2, totalPages: 2 } };
			return undefined;
		});
		const res = await tools.get("zotero_fulltext")!.execute("id", { action: "get", itemKey: "ATT", filePath: out }, undefined, undefined, ctx(AUTH));
		const parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal(parsed.path, out);
		assert.equal(parsed.chars, 5);
		assert.equal(parsed.indexedPages, 2);
		assert.equal("content" in parsed, false);
		assert.equal(await readFile(out, "utf-8"), "hello");
		handle.restore();
		await rm(dir, { recursive: true, force: true });
	});

	it("get resolves a parent item key to its PDF child", async () => {
		const { tools, ctx } = harness();
		const dir = await mkdtemp(join(tmpdir(), "zotero-ft-"));
		const out = join(dir, "out.txt");
		const handle = mockFetch((c) => {
			if (c.url.endsWith("/users/42/items/P1?format=json"))
				return { status: 200, body: { key: "P1", version: 1, data: { itemType: "journalArticle" } } };
			if (c.url.includes("/users/42/items/P1/children?"))
				return { status: 200, body: [{ key: "A1", version: 2, data: { itemType: "attachment", contentType: "application/pdf" } }] };
			if (c.url.endsWith("/users/42/items/A1/fulltext"))
				return { status: 200, body: { content: "hi", indexedChars: 2, totalChars: 2 } };
			return undefined;
		});
		const res = await tools.get("zotero_fulltext")!.execute("id", { action: "get", itemKey: "P1", filePath: out }, undefined, undefined, ctx(AUTH));
		const parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal(parsed.itemKey, "A1");
		assert.equal(await readFile(out, "utf-8"), "hi");
		handle.restore();
		await rm(dir, { recursive: true, force: true });
	});

	it("set requires filePath (text is never passed inline)", async () => {
		const { tools, ctx } = harness();
		await assert.rejects(
			() =>
				tools
					.get("zotero_fulltext")!
					.execute("id", { action: "set", itemKey: "ATT", indexedChars: 3, totalChars: 3 }, undefined, undefined, ctx(AUTH)),
			/filePath is required for set/,
		);
	});

	it("set rejects a missing stats pair with no PUT", async () => {
		const { tools, ctx } = harness();
		const dir = await mkdtemp(join(tmpdir(), "zotero-ft-"));
		const fp = join(dir, "t.txt");
		await writeFile(fp, "txt");
		const handle = mockFetch(() => undefined);
		await assert.rejects(
			() =>
				tools
					.get("zotero_fulltext")!
					.execute("id", { action: "set", itemKey: "ATT", filePath: fp }, undefined, undefined, ctx(AUTH)),
			/One stats pair is required/,
		);
		assert.equal(handle.calls.length, 0);
		handle.restore();
		await rm(dir, { recursive: true, force: true });
	});

	it("set reports unchanged:true with zero PUTs when the file matches stored content", async () => {
		const { tools, ctx } = harness();
		const dir = await mkdtemp(join(tmpdir(), "zotero-ft-"));
		const fp = join(dir, "t.txt");
		await writeFile(fp, "same");
		const handle = mockFetch((c) => {
			if (c.url.endsWith("/users/42/items/ATT?format=json"))
				return { status: 200, body: { key: "ATT", version: 9, data: { itemType: "attachment", contentType: "application/pdf" } } };
			if (c.url.endsWith("/users/42/items/ATT/fulltext") && c.method === "GET")
				return { status: 200, body: { content: "same", indexedChars: 4, totalChars: 4 } };
			return undefined;
		});
		const res = await tools
			.get("zotero_fulltext")!
			.execute("id", { action: "set", itemKey: "ATT", filePath: fp, indexedChars: 4, totalChars: 4 }, undefined, undefined, ctx(AUTH));
		const parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal(parsed.unchanged, true);
		assert.equal(
			handle.calls.filter((c) => c.method === "PUT").length,
			0,
		);
		handle.restore();
		await rm(dir, { recursive: true, force: true });
	});

	it("set MIME precheck refuses non-PDF attachments before PUT", async () => {
		const { tools, ctx } = harness();
		const dir = await mkdtemp(join(tmpdir(), "zotero-ft-"));
		const fp = join(dir, "t.txt");
		await writeFile(fp, "txt");
		const handle = mockFetch((c) =>
			c.url.endsWith("/users/42/items/IMG?format=json")
				? { status: 200, body: { key: "IMG", version: 2, data: { itemType: "attachment", contentType: "image/png" } } }
				: undefined,
		);
		await assert.rejects(
			() =>
				tools
					.get("zotero_fulltext")!
					.execute(
						"id",
						{ action: "set", itemKey: "IMG", filePath: fp, indexedChars: 3, totalChars: 3 },
						undefined,
						undefined,
						ctx(AUTH),
					),
			/only stored for PDF \/ text \/ EPUB/,
		);
		assert.equal(
			handle.calls.filter((c) => c.method === "PUT").length,
			0,
		);
		handle.restore();
		await rm(dir, { recursive: true, force: true });
	});

	it("set reads the file and PUTs the normalized payload (omits undefined optional fields)", async () => {
		const { tools, ctx } = harness();
		const dir = await mkdtemp(join(tmpdir(), "zotero-ft-"));
		const fp = join(dir, "t.txt");
		await writeFile(fp, "txt");
		const handle = mockFetch((c) => {
			if (c.url.endsWith("/users/42/items/ATT?format=json"))
				return { status: 200, body: { key: "ATT", version: 9, data: { itemType: "attachment", contentType: "application/pdf" } } };
			if (c.url.endsWith("/users/42/items/ATT/fulltext"))
				return c.method === "PUT" ? { status: 204, body: "" } : { status: 404, body: "Not found" };
			return undefined;
		});
		const res = await tools
			.get("zotero_fulltext")!
			.execute("id", { action: "set", itemKey: "ATT", filePath: fp, indexedChars: 3, totalChars: 3 }, undefined, undefined, ctx(AUTH));
		const put = handle.calls.find((c) => c.method === "PUT");
		assert(put, "expected a PUT to the fulltext endpoint");
		const body = JSON.parse(put!.body as string);
		assert.deepEqual(body, { content: "txt", indexedChars: 3, totalChars: 3 });
		const parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal(parsed.ok, true);
		handle.restore();
		await rm(dir, { recursive: true, force: true });
	});
});
describe("tools.zotero_group_list", () => {
	it("web mode: lists group memberships from the stored credential", async () => {
		const { tools, ctx } = harness();
		const handle = mockFetch((c) =>
			c.url === "https://api.zotero.org/users/42/groups?limit=100&start=0"
				? {
						status: 200,
						body: [
							{ id: 6664215, data: { id: 6664215, name: "Luciano's share", type: "Private" }, meta: { numItems: 15, isAdmin: true } },
						],
					}
				: undefined,
		);
		const res = await tools.get("zotero_group_list")!.execute("id", {}, undefined, undefined, ctx(AUTH));
		const parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal(parsed[0].id, "6664215");
		assert.equal(parsed[0].name, "Luciano's share");
		assert.equal(parsed[0].role, "admin");
		handle.restore();
	});

	it("local mode: falls back to the stored Web credential (Local API cannot list memberships)", async () => {
		const { tools, ctx } = harness();
		const handle = mockFetch((c) =>
			c.url === "https://api.zotero.org/users/42/groups?limit=100&start=0"
				? { status: 200, body: [{ id: 5, data: { name: "G2", type: "Private" }, meta: { numItems: 2, isAdmin: false } }] }
				: undefined,
		);
		const res = await tools.get("zotero_group_list")!.execute(
			"id",
			{},
			undefined,
			undefined,
			ctx({ auth: { apiKey: "WEBKEY" }, env: { ZOTERO_USER_ID: "42" } }, { auth: { apiKey: "LOCALKEY" }, env: {} }),
		);
		const parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal(parsed[0].id, "5");
		// The Web credential's key is used, not the active (local) credential's.
		assert.equal(handle.calls[0]!.headers["zotero-api-key"], "WEBKEY");
		handle.restore();
	});
});
