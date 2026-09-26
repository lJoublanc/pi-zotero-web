# API quirks worth remembering

## Search

- `q` matches tokens/phrases, not substrings. Single-char terms are
  unreliable (1-2 char tokens are skipped unless quoted); use distinctive
  words. Very common words are weak/noisy. Quote phrases.
- NO relevance sort exists. Default order is `dateModified`-ish. Score and
  order client-side instead (see `ranking.md`).
- `since` = "objects whose version > since" (the library's version counter).
  Works alone as a change-feed and combined with `q`+`qmode=everything`.
  `totalResults` tells you when a page is a subset — page with `start`.
- `everything` searches indexed fulltext AND note bodies — but only for
  attachments whose fulltext was `set`/extracted. The desktop app
  auto-extracts what it ingests itself; API-created items are NOT
  auto-indexed (hence SKILL.md §4 step 5). `unindexedKeys` on every
  `everything` response names the blind spot for that scope.
- `everything` returns the *attachment* item; resolve to the publication via
  its `parentItem`.

## Versions & writes

- ONE shared version counter per library; every write bumps it; the written
  object's `version` = counter at its last modification. Stale
  `If-Unmodified-Since-Version` → 412.
- Read-only-LOOKING operations can still bump an object's version. Never
  cache versions across calls; serialize writes.

## Upload flow

- Full 4-step flow (create attachment item → upload authorization → S3 bytes
  → register upload) is inside `zotero_attachment action=upload`. If it
  reports success but a download 404s, the binary is still landing — retry
  later.
- Fulltext does NOT need the bytes: a bare stored (`imported_file`)
  attachment record + `set` is searchable (SKILL.md §4 quota fallback).

## Libraries & sync

- Personal library: sync state varies per setup — NEVER assume the Web-API
  copy mirrors the local one. `mode`+`library` on every tool response says
  which target you hit. The Local API is the source of truth when both exist.
- Group libraries: readable/writable via both APIs; shared storage quota
  (typically 300MB, the owner's) — only *files* count, metadata/notes/
  fulltext are unmetered. `linked_file` attachments are rejected for groups;
  use `imported_file` only. Group listing itself is Web-API-only
  (`zotero_group_list`); targeting a group needs `ZOTERO_GROUP_ID` in the
  credential env.
- Local reads are keyless; the first write pops ONE consent dialog in Zotero
  — tell the user to pick **Always Allow**.

## Collection semantics

- `/collections/KEY/items` = DIRECT members only; NO recursive/descendants
  option anywhere. `q`+`qmode=everything` scoped to a collection also sees
  only direct members.
- Membership = the ITEM's `collections` array (not the collection's): adding
  an item = PATCH the item preserving its existing `collections`. An item's
  own version bumps when its collections change; the COLLECTION's version
  does NOT — but renaming/deleting still needs the collection's fresh
  version: re-GET it.

## Identity regexes (DOI / arXiv)

- DOI: `10\.\d{4,9}/[^\s"'<>]+` (strip trailing `.,;:` and unwrap parens).
  Zotero stores DOIs bare (no `https://doi.org/` prefix) — normalize before
  comparing.
- arXiv: `arxiv[:\s]*([0-9]{4}\.[0-9]{4,5})(v[0-9]+)?` (case-insensitive).
