// CelesTrak SATCAT — the upstream half of the satellite table, covering every
// satellite we serve rather than the two dozen worth hand-writing. The curated
// rows win field by field where both speak; mergeSatelliteTables in refresh.ts
// owns that rule.
//
// SATCAT is NOT a group source. It selects nothing and serves no records; it
// only says what is true of a satellite some group already carries. That is why
// it is fetched here rather than through collectSources/fetchSources, and why a
// SATCAT failure degrades enrichment without failing a single group.
//
// IMPORTANT: this file must stay node-type-strippable (erasable syntax only) —
// see the note at the top of types.ts.

import type { FetchImpl } from "./evaluate.ts";
import { normalizeSatnumKey } from "./evaluate.ts";
import type { SatcatSnapshot } from "./types.ts";

// The full catalog (~70k objects, ~6.7 MB). Deliberately not
// satcat/records.php?GROUP=active, which is 4.5x smaller but drops rocket
// bodies, debris and just-decayed objects — and last-30-days carries exactly
// those. Served with an ETag, so the steady state costs a 304 (see fetchSatcat).
export const SATCAT_URL = "https://celestrak.org/pub/satcat.csv";

const USER_AGENT = "satvis.space (https://github.com/Flowm/satvis)";
const REQUEST_TIMEOUT_MS = 60_000;

// SATCAT column -> metadata key. The bag is the frontend's vocabulary
// (src/config/satelliteMetadata.ts), so the rename happens here, once.
//
// Deliberately absent:
//   PERIOD/INCLINATION/APOGEE/PERIGEE  derived from the element set already, and
//                                      SATCAT rounds them to whole km/minutes
//   RCS                                2.9% coverage on the satellites we serve
//   DATA_STATUS_CODE                   empty for every one of them
//   OBJECT_TYPE                        12,583 of 12,594 are PAY; revisit if a
//                                      debris group is ever served
//   OBJECT_NAME/OBJECT_ID              the GP record already carries both
const FIELDS: [string, string][] = [
  ["OWNER", "owner"],
  ["LAUNCH_DATE", "launchDate"],
  ["LAUNCH_SITE", "launchSite"],
  ["OPS_STATUS_CODE", "opsStatus"],
  ["ORBIT_TYPE", "orbitType"],
  ["ORBIT_CENTER", "orbitCenter"],
  ["DECAY_DATE", "decayDate"],
];

const SATNUM_COLUMN = "NORAD_CAT_ID";

// Split one CSV line into fields, honouring RFC 4180 quoting ("" is a literal
// quote inside a quoted field). Most SATCAT rows carry no quote at all, so the
// scanner is skipped entirely for them — worth it over 70k rows.
//
// Quoted fields spanning a newline are not supported: rows are split on newlines
// before this runs. SATCAT has no such field, and parseSatcatCsv's column-count
// check would reject the row loudly rather than mis-assign it silently.
function splitCsvLine(line: string): string[] {
  if (!line.includes('"')) {
    return line.split(",");
  }
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (quoted) {
      if (char !== '"') {
        field += char;
      } else if (line[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = false;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      fields.push(field);
      field = "";
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

/**
 * Parse a SATCAT CSV body into the per-satellite bags the satellite table holds,
 * keyed by normalized satnum.
 *
 * Columns are resolved by header name, never by position: CelesTrak has added
 * columns before (ORBIT_CENTER and ORBIT_TYPE arrived with the 2021 format
 * change) and a positional reader would have silently shifted.
 *
 * Empty values are dropped rather than stored as "", so an absent key keeps
 * meaning "nothing to say" for the frontend and costs no bytes.
 *
 * Throws on a body that is not SATCAT at all (an HTML error page, an empty
 * file, a missing NORAD_CAT_ID column), so a mangled payload fails closed here
 * and the caller keeps the last-known-good snapshot.
 */
export function parseSatcatCsv(body: string): SatcatSnapshot["rows"] {
  // CelesTrak serves CRLF. Splitting on \n alone leaves a trailing \r on the
  // last field of every row, which silently blanks ORBIT_TYPE.
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const header = lines[0];
  if (header === undefined || header.trim() === "") {
    throw new Error("empty body");
  }
  const columns = splitCsvLine(header).map((name) => name.trim());
  const satnumIndex = columns.indexOf(SATNUM_COLUMN);
  if (satnumIndex === -1) {
    throw new Error(`no ${SATNUM_COLUMN} column (header: ${JSON.stringify(header.slice(0, 120))})`);
  }
  const wanted = FIELDS.map(([column, key]) => [columns.indexOf(column), key] as const).filter(([index]) => index !== -1);

  const rows: SatcatSnapshot["rows"] = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "") {
      continue;
    }
    const fields = splitCsvLine(line);
    if (fields.length !== columns.length) {
      throw new Error(`row ${i} has ${fields.length} fields, expected ${columns.length}`);
    }
    const satnum = normalizeSatnumKey(fields[satnumIndex]!);
    if (satnum === "") {
      continue;
    }
    const bag: Record<string, string> = {};
    for (const [index, key] of wanted) {
      const value = fields[index]!.trim();
      if (value !== "") {
        bag[key] = value;
      }
    }
    rows[satnum] = bag;
  }

  if (Object.keys(rows).length === 0) {
    throw new Error("no records");
  }
  return rows;
}

// Outcome of one SATCAT fetch. `rows` is set only when the catalog was actually
// downloaded and parsed; `notModified` says the stored snapshot is still current;
// `error` says the caller should keep the stored snapshot anyway. Exactly one of
// the three is meaningful.
export interface SatcatFetch {
  status?: number;
  ms: number;
  bytes?: number;
  rows?: SatcatSnapshot["rows"];
  validator?: string;
  notModified?: boolean;
  error?: string;
}

/**
 * Fetch the catalog, conditionally.
 *
 * CelesTrak asks for one download per update and SATCAT updates once or twice a
 * day, while our refresh runs every 6 h — so an unconditional fetch would pull
 * 6.7 MB two to four times for nothing. `validator` is the ETag from the last
 * successful fetch (stored on the snapshot); passing it turns the usual case
 * into a 304 with no body.
 *
 * Never throws: every failure mode comes back on the result, because a SATCAT
 * outage must cost enrichment freshness and nothing else. The GP groups are
 * fetched, evaluated and stored entirely independently of this.
 */
export async function fetchSatcat(fetchImpl: FetchImpl, validator?: string): Promise<SatcatFetch> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${REQUEST_TIMEOUT_MS}ms`)), REQUEST_TIMEOUT_MS);
  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (validator !== undefined) {
    headers["If-None-Match"] = validator;
  }
  try {
    const res = await fetchImpl(SATCAT_URL, { headers, signal: controller.signal });
    const ms = Date.now() - started;
    if (res.status === 304) {
      return { status: 304, ms, notModified: true };
    }
    if (res.status !== 200) {
      return { status: res.status, ms, error: `HTTP ${res.status}` };
    }
    const body = await res.text();
    try {
      return { status: 200, ms, bytes: body.length, rows: parseSatcatCsv(body), validator: res.headers?.get("ETag") ?? undefined };
    } catch (parseErr) {
      return { status: 200, ms, bytes: body.length, error: parseErr instanceof Error ? parseErr.message : String(parseErr) };
    }
  } catch (err) {
    return { ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
