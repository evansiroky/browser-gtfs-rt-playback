# Behavior: GTFS Schedule Summary

## Rule
A GTFS Schedule zip is reduced to a summary of: agencies, route count, stop count, and the
date range of service.

## Applies To
[Schedule Loader](../screens/schedule-loader.md).

## Details

**Parsing.** Each `.txt` file in the archive is CSV with a header row. Match files by name
at the archive root; ignore other files. Tolerate a UTF-8 BOM, CRLF or LF line endings,
quoted fields containing commas, newlines, and doubled quotes, and blank trailing lines.

**Agencies.** One entry per data row of `agency.txt`, using `agency_name`, `agency_url`,
`agency_timezone`.

**Counts.** Routes = number of data rows in `routes.txt`. Stops = number of data rows in
`stops.txt` (all `location_type` values included; no filtering).

**Service date range.** The earliest and latest dates on which service is defined, taken from
the union of:
- `start_date` and `end_date` of every row in `calendar.txt` (if present), and
- every `date` in `calendar_dates.txt` (if present) with `exception_type` = `1` (service
  added).

The range is the minimum and maximum of that set. Dates are `YYYYMMDD` in the feed and are
compared and shown without time-zone conversion. If neither file contributes a date, the range
is unknown. `feed_info.txt` validity dates are not used.

**Missing files.** `agency.txt`, `routes.txt`, and `stops.txt` are required; their absence is
an error. `calendar.txt` and `calendar_dates.txt` are each optional (a feed must have at least
one to define service).
