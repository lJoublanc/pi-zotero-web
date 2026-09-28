# Client-side ranking (unranked `everything` results)

`zotero_search` returns `dateModified` order — position 30 == position 3.
When a query returns more candidates than fit the answer, rank them
client-side before dumping passages:

## STOP list

Drop these before matching (case-insensitive): `the and for from with that
this into onto using how why what when does are was were about over under
between new paper papers have has had not its their there then they which
these those also more most some such only other than`. Also drop tokens of
length ≤ 2 and pure numbers unless the user quoted them.

## Title/abstract weighting

For each remaining term, score each candidate:

- term in title: **+3.0**
- term in abstract: **+1.5**
- term anywhere (matched at all): **+1.0**
- item matches ≥ 2 distinct terms: **+2.0**

Sort descending by score. This is a coarse relevance proxy, not a model —
use it to pick which ≤ 3 attachments deserve a `get` + grep, nothing more.

## N-gram anchoring (inside one paper)

Once a paper's fulltext file is downloaded, anchor the snippet on the
longest contiguous word-n-gram of the query found in the text (n-gram
descent: try the full phrase, then n-1, ... down to the rarest single word).
Center the ≤ 1200-char window on that anchor, then extend up to the nearest
preceding heading-like line for section context. Never claim a page number.
