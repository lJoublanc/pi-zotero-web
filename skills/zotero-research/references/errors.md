# Errors → actions

| Symptom | Cause | Action |
|---|---|---|
| `exit 6` / "no response from 127.0.0.1:23119" | Zotero closed or Local API off | Tell the user: start Zotero, Settings → Advanced → "Allow other applications…". Then retry. |
| 401 on a write (local) | No/invalid local key | The extension re-runs the `/api/local/authorize` handshake automatically → ONE consent dialog pops in Zotero (Allow/Always Allow/Deny). Tell the user, wait, it retries. Prefer **Always Allow** (`/login zotero-local` stores it) or every new key costs a dialog. |
| 401 on a write (web) | Missing/rejected Web key | Run `/login zotero` to store a fresh key (needs Allow library + file access). |
| 404 on `fulltext get` | No fulltext stored for that attachment | The paper was never `set` (API ingests are NOT auto-indexed). Run the ingest chain (SKILL.md §4 step 5) or check `unindexedKeys` on the last search. |
| 404 right after a create | Write+read raced | Never write and immediately read in the same breath; serialize, re-GET. |
| 412 on update/delete | Version moved underneath (versions bump silently) | Re-GET the object, take its fresh `version`, retry once. Always refetch versions for `zotero_item update/delete` and `zotero_collection add`. |
| 428 on a write (local) | Missing `Zotero-Server-ID` | Shouldn't happen (the extension attaches it from prior responses). If it does: report as a bug. |
| 429 + Retry-After | Rate limit | Back off and retry after the header's delay. |
| 400/413 on `fulltext set` | Content over the ~500k-char / ~100-page cap, or non-indexable MIME | Truncate (keep `\f` page joins) and retry; check the attachment is PDF/text/EPUB (the tool's MIME precheck normally catches this first). |
| Tool upload says OK but a later download 404s | Known: register commits metadata, binary lands later | Do nothing immediately; retry the download when the bytes are actually needed. |
| `everything` search returns 0 expected hits | (a) scope filter, (b) phrase/term issue, (c) unindexed | (a) retry unscoped; (b) use 2-4 distinctive words, avoid single letters and stopwords; (c) check `unindexedKeys` — ingest missing texts, then re-run. |
| Wrong counts after deletes | Casually-parallel reads | Serialize; recount after a beat. |
| Group operations fail oddly | Group libraries differ (no `linked_file`, shared quota) | Stored (`imported_file`) attachments ONLY in groups. See SKILL.md §4 quota fallback. |
