---
name: zotero-research
description: Research over the user's Zotero library via the pi-zotero-web tools: search papers (keyword or full-text), answer from passages, ingest new papers with searchable fulltext. Use for any Zotero search/answer/ingest task.
---

# Zotero research

Answer from the user's Zotero library (personal, plus group libraries when
configured) using the `zotero_*` tools. The library is the store of record;
never invent items, keys, or citations.

## 1. Budget rules

- Never echo tool JSON back into the conversation. Consume results silently;
  your reply cites or answers, it does not re-print records.
- `titleCreatorYear` searches may use `limit: 5-10`. `everything` searches are
  unranked (position 30 == position 3): default `limit: 25-50`, page with
  `start` while `totalResults` exceeds returned. Absence claims require
  exhausting pages or narrowing to zero with distinctive terms.
- Answer from at most 3 passages. Cite as `Author Year (doi)` from the passage
  metadata, not from memory.
- Fetch fulltext to a file, never into context (step 6). Never paste a whole
  document into context.
- Writes go one at a time, never in parallel. Re-fetch the item's current
  `version` immediately before every `update`/`delete` (versions move
  silently). Collection adds preserve existing memberships (pass each item's
  current `collections` array plus the new key).

## 2. Search strategy

- Query verbatim first: quicksearch splits your query into words and quoted
  phrases itself and matches each over title/fields/tags/notes/fulltext.
- Fallback: 2-4 distinctive terms. Quote phrases. Avoid single letters and
  stopwords (`the`, `of`, `and`, ...) — 1-2 char tokens are skipped unless
  quoted, and very common words are noisy. See `references/quirks.md`.
- `qmode=everything` only matches attachments with indexed fulltext. Every
  `everything` response carries `unindexedKeys` for its scope: an empty hit
  list alongside non-empty `unindexedKeys` means "blind", not "absent" —
  ingest the missing texts (step 5) and re-run before claiming absence.
- Absence claims additionally require a dump check (step 6) on the most
  promising candidate.
- On unexpected HTTP errors, read `references/errors.md` before retrying.

## 3. Answer from passages

1. `zotero_search` with `qmode=everything` (limit 25-50).
2. For each candidate attachment, `zotero_fulltext action=download`, then
   `grep -i -C 5 -m 3` on the file and read around the best hit (step 6).
3. Answer ONLY from the returned passages. If they don't cover the question,
   say what's missing and either dump the most promising paper or say so —
   do not pad.

## 4. Ingest chain

1. Metadata first: resolve DOI/arXiv (regexes in `references/quirks.md`) via
   Crossref/arXiv, or ask the user for title/venue/year/authors.
2. Create the record with `zotero_item action=create` (it dedups by DOI, then
   by title + first author; `forceCreate:true` bypasses).
3. Attach the PDF when you have one: `zotero_attachment action=upload` with
   `parentKey=<itemKey>`, `filePath=<the pdf>`.
4. Fulltext is NOT automatic for API-created items: ALWAYS follow an upload
   with step 5, or the paper stays invisible to `everything` search.
5. Convert and `set` (agent-side, skill-guided):
   - Download the bytes via `zotero_attachment action=download` (never
     re-fetch the PDF from the web).
   - Detect converters: `pdftotext` on PATH (`command -v pdftotext`);
     importable python modules `pymupdf4llm`, `pymupdf`, `pypdf`
     (`python3 -c "import pymupdf4llm"` etc.). `pdftotext` preserves
     `\f` page breaks by default; `pymupdf4llm` is layout-aware (better for
     multi-column PDFs); plain `pymupdf`/`pypdf` give stream order.
   - If the user named a converter, use it. Else if exactly one is
     available, use it and say so. Else ask the user to pick. If none is
     available, report the item as unindexed with the right-click Reindex
     hint (below) and stop.
   - Convert to a tmp text file — never load the whole converted plaintext
     into context. Multi-page text: join pages with `\f` (mirrors Zotero's
     own extractor: pages joined with `\n\n\f`, no trailing `\f`).
   - `zotero_fulltext action=set` with the file's content plus one stats
     pair: `indexedPages`/`totalPages` for PDFs, `indexedChars`/`totalChars`
     for text. Reads over ~500k chars / ~100 pages are capped server-side;
     truncate and note it.
6. File into collections: `zotero_collection action=add` preserving
   memberships.

### Fulltext without the file (quota fallback)

`set` needs only an attachment *record*, not uploaded bytes: fulltext can be
attached without uploading the PDF at all. The record is a stored
(`imported_file`) attachment created bare via `zotero_item action=create`
with `{"itemType":"attachment","parentItem":"<itemKey>",`
`"linkMode":"imported_file","title":"<title> - PDF",`
`"contentType":"application/pdf","tags":[]}`, then `set` with extracted text
as in step 5. Fulltext does not count against storage quota — only binary
files do — so this keeps papers searchable when quota is low or an upload
fails. No policy or default: just know the option exists, and tell the user
when you use it. (Note: `linked_file` attachments are rejected for group
libraries; use `imported_file` only.)

Native Reindex (right-click an attachment → Reindex Item) re-extracts text
from the PDF bytes and overwrites `set` text. No Web or Local API endpoint
triggers it — it is manual-only, in the desktop app.

## 5. Locate pattern (answer from a paper, cheaply)

1. `qmode=everything` to find candidate attachment(s).
2. Fetch fulltext **to a file, not into context** via
   `zotero_fulltext action=download` (accepts a parent item key, resolving to
   its PDF child). Never `zotero_fulltext action=get` for answering (it
   returns the WHOLE content inline), never curl, never re-fetch PDFs from
   the web.
3. `grep -i -C 5 -m 3` (or ripgrep) on that file for the distinctive terms;
   `head -c 1200` pipe optional. Return **at most ~800-1200 chars**
   surrounding the best hit **plus the nearest preceding heading-like line
   as section context** (heuristic, not a page claim).
4. Never claim a page number — stored fulltext is one flat string; page
   breaks survive only as `\f` delimiters when the producer emits them, and
   counting them means reading the whole file into context. Section titles
   are best-effort from visible context.
5. Cite from the passage metadata, not memory.

## 6. Troubleshooting

- `references/errors.md` — HTTP status table (401/404/412/428/429/413).
- `references/quirks.md` — search/matching quirks, version semantics,
  collection semantics, sync notes (Local is truth; group notes).
- `references/ranking.md` — client-side re-ranking: STOP list,
  title/abstract weighting, n-gram anchoring.
