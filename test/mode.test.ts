import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveZoteroMode, zoteroModeFromSettings, type ZoteroModeCredential } from "../mode.ts";

const WEB: ZoteroModeCredential = { key: "WEBKEY" };
const WEB_GROUP: ZoteroModeCredential = { key: "WEBKEY", groupId: "7" };
const LOCAL: ZoteroModeCredential = { key: "LOK" };


describe("mode.zoteroModeFromSettings", () => {
	it("defaults to auto when no zotero section is present", () => {
		assert.equal(zoteroModeFromSettings({}, {}), "auto");
		assert.equal(zoteroModeFromSettings(undefined, undefined), "auto");
		assert.equal(zoteroModeFromSettings({ other: 1 }, { other: 2 }), "auto");
	});

	it("reads zotero.mode from global settings", () => {
		assert.equal(zoteroModeFromSettings({ zotero: { mode: "local" } }, undefined), "local");
		assert.equal(zoteroModeFromSettings({ zotero: { mode: "web" } }, undefined), "web");
	});

	it("project settings override global settings", () => {
		assert.equal(zoteroModeFromSettings({ zotero: { mode: "web" } }, { zotero: { mode: "local" } }), "local");
		assert.equal(zoteroModeFromSettings({ zotero: { mode: "local" } }, { zotero: { mode: "web" } }), "web");
	});

	it("warns and keeps the previous value on invalid modes", () => {
		const warnings: string[] = [];
		const warn = (m: string) => warnings.push(m);
		assert.equal(zoteroModeFromSettings({ zotero: { mode: "sometimes" } }, undefined, warn), "auto");
		assert.equal(warnings.length, 1);
		// A valid global + invalid project: the warning fires, the global value wins.
		assert.equal(zoteroModeFromSettings({ zotero: { mode: "web" } }, { zotero: { mode: 42 } }, warn), "web");
	});

	it("ignores a non-object zotero section", () => {
		const warnings: string[] = [];
		assert.equal(zoteroModeFromSettings({ zotero: "local" }, undefined, (m) => warnings.push(m)), "auto");
		assert.equal(warnings.length, 1);
	});
});

describe("mode.resolveZoteroMode", () => {
	it("uses keyless local reads when no credentials are stored", () => {
		const r = resolveZoteroMode(undefined, undefined, "auto");
		assert.equal(r.mode, "local");
		assert.equal(r.source, "no-credentials");
		assert.equal(r.apiKey, undefined);
	});

	it("uses the Web API when only the web credential is stored", () => {
		const r = resolveZoteroMode(WEB, undefined, "auto");
		assert.equal(r.mode, "web");
		assert.equal(r.source, "credential:zotero");
		assert.equal(r.apiKey, "WEBKEY");
	});

	it("uses the Local API when only the local credential is stored", () => {
		const r = resolveZoteroMode(undefined, LOCAL, "auto");
		assert.equal(r.mode, "local");
		assert.equal(r.source, "credential:zotero-local");
		assert.equal(r.apiKey, "LOK");
	});

	it("prefers the Local API when both credentials are stored", () => {
		const r = resolveZoteroMode(WEB, LOCAL, "auto");
		assert.equal(r.mode, "local");
		assert.equal(r.apiKey, "LOK");
	});

	it("an explicit setting overrides stored credentials", () => {
		assert.equal(resolveZoteroMode(WEB, LOCAL, "web").mode, "web");
		assert.equal(resolveZoteroMode(WEB, LOCAL, "local").mode, "local");
		// Even with no credential at all, the setting pins the mode.
		assert.equal(resolveZoteroMode(undefined, undefined, "web").mode, "web");
	});

	it("propagates the groupId of the winning credential", () => {
		assert.equal(resolveZoteroMode(WEB_GROUP, undefined, "auto").groupId, "7");
		// Both stored: local wins, so the *web* credential's groupId does not leak.
		assert.equal(resolveZoteroMode(WEB_GROUP, LOCAL, "auto").groupId, undefined);
		// Forcing "local" picks the local credential's group; forcing "web" picks the web one.
		assert.equal(resolveZoteroMode(WEB, { key: "L", groupId: "9" }, "local").groupId, "9");
		assert.equal(resolveZoteroMode(WEB, { key: "L", groupId: "9" }, "web").groupId, undefined);
	});
});

