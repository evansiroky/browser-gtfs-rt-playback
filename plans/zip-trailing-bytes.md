---
status: done
depends: [schedule-loader]
specs:
  - specs/behaviors/feed-ingest.md
  - specs/architecture.md
issues: []
pr: 7
---

# Plan: Tolerate bytes after the schedule zip

## Scope
In: reading a schedule zip that has bytes after its end-of-central-directory record, as the
Monterey-Salinas Transit feed (`mst.org/google/google_transit.zip`) does (16 stray bytes, a leftover
of an older end record), instead of failing it as `bad_zip`.

Out: logging the underlying zip error (the `bad_zip` log line still carries no reason); tolerating
any other malformed archive; restricting feed URLs.

## Implements
- `behaviors/feed-ingest.md` "Bytes after the archive are ignored": the archive ends at the last
  end-of-central-directory record found in the final 65,557 bytes, preferring one that ends exactly
  at the end of the body; no record means the body is read as is.
- `architecture.md` "Security posture": the caveat that this relies on operator-chosen feed URLs.

## Approach
- `schedule/zip.ts`: before opening, scan the tail of the chunked body for end records and open
  `yauzl` with the archive's size rather than the body's. `ChunkedReader` already reads by range,
  so nothing is copied beyond the 64 KiB tail being scanned.
- `server/README.md`: say in the schedule bullet that bytes after the archive are ignored.
- Tests in `schedule/zip.test.ts`: stray bytes after a plain end record and after one with a
  comment are ignored; a body with the end record beyond the scanned window, and a truncated
  archive, still fail as `bad_zip`.

## Validation
- [x] `npm run lint`, `typecheck`, `test`, `build` and `format:check` pass.
- [x] A zip with 16 stray bytes after its end record (the MST shape) loads; the same zip without
      the bytes loads identically.
- [x] A zip whose comment is followed by stray bytes loads.
- [x] A truncated zip and a non-zip body still fail as `bad_zip`.
- [x] The MST archive from 2026-10-28 loads through `parseSchedule`.

## Risks / unknowns
- **Hostile archives** — tolerance lets a file present different contents to this server than to a
  reader that picks another end record. Accepted while only the operator chooses feed URLs; recorded
  in the architecture's security posture for when that changes.

## Notes
- The cause was `yauzl` checking the end record's comment length against the bytes after it, which
  is why the log showed `bad_zip` after 1 ms: the failure came before any entry was read. Without
  the change the MST archive fails as `bad_zip`; with it, it loads (3,087 trips, 38 routes, 83
  shapes).
- "Loads identically" for a zip without the stray bytes is covered by the existing tests, which all
  use clean archives.
- A valid archive whose comment contains the end record signature is still rejected by `yauzl`,
  which takes the signature nearest the end. That predates this change and is not handled.

## Follow-ups
None.
