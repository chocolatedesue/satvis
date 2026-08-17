// Pure URL <-> state codec. The contract it implements is
// docs/adr/0001-url-parameter-specification.md; read that before changing
// anything here, especially the legacy read shims.
//
// This module must stay free of Cesium, pinia, vue-router and the DOM: query
// strings and plain values are the only things that cross its interface, which
// is what makes it exhaustively testable in the node-env vitest.

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";

import { formatLayer, parseLayer } from "../../config/layers";
import type { SerializedGroundStation } from "../../stores/sat";

dayjs.extend(utc);

// A parse or format attempt. `ok: false` means "this cannot be represented" —
// the caller decides whether that costs an element or the whole parameter.
export type Result<T> = { ok: true; value: T } | { ok: false };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const FAIL: Result<never> = { ok: false };

export interface FieldKind<T> {
  // Raw is already percent-decoded and "+"-expanded by the caller's query
  // reader, so a space arrives as a space.
  parse(raw: string): Result<T>;
  format(value: T): Result<string>;
}

export interface FieldSpec {
  // Key in the store.
  name: string;
  // Query parameter name; defaults to `name`.
  url?: string;
  // Method-syntax members are bivariant, so any FieldKind<T> lands here.
  kind: FieldKind<unknown>;
}

/** Any string, unvalidated. For open vocabularies with no delimiter (`track`). */
export function plainString(): FieldKind<string> {
  return {
    parse: (raw) => ok(raw),
    format: (value) => (typeof value === "string" ? ok(value) : FAIL),
  };
}

/** A closed set of literals. Rejecting on parse is what stops `?terrain=Garbage` diverging. */
export function enumString(values: readonly string[]): FieldKind<string> {
  const member = (v: unknown): v is string => typeof v === "string" && values.includes(v);
  return {
    parse: (raw) => (member(raw) ? ok(raw) : FAIL),
    format: (value) => (member(value) ? ok(value) : FAIL),
  };
}

/** `true` | `false`. The kind whose absence made `?fps=false` switch the counter on. */
export function boolean(): FieldKind<boolean> {
  return {
    parse: (raw) => (raw === "true" ? ok(true) : raw === "false" ? ok(false) : FAIL),
    format: (value) => (typeof value === "boolean" ? ok(String(value)) : FAIL),
  };
}

const LIST_SEPARATOR = ",";

function splitList(raw: string): string[] {
  return raw.split(LIST_SEPARATOR).filter((entry) => entry !== "");
}

function formatList(value: unknown): Result<string> {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return FAIL;
  }
  // The separator is in-band and cannot be escaped: URLSearchParams decodes
  // %2C before we split, so a member containing a comma is unrepresentable.
  // Refuse it rather than silently emitting a URL that reads back as two.
  if ((value as string[]).some((entry) => entry.includes(LIST_SEPARATOR))) {
    return FAIL;
  }
  return ok((value as string[]).join(LIST_SEPARATOR));
}

/**
 * The one string-list kind: join and split on ",". Spaces need no escaping —
 * both URLSearchParams and vue-router encode a space as "+" and decode it back.
 */
export function stringList(): FieldKind<string[]> {
  return { parse: (raw) => ok(splitList(raw)), format: formatList };
}

/**
 * `sats` / `xsats`. Legacy read shim: these used to escape spaces as "~".
 * Applied unconditionally because satellite names are an open vocabulary, so
 * there is nothing to resolve an ambiguity against — which is why a literal
 * "~" in a satellite name stays unrepresentable.
 */
export function tildeEscapedStringList(): FieldKind<string[]> {
  return {
    parse: (raw) => ok(splitList(raw).map((entry) => entry.replaceAll("~", " "))),
    format: (value) => {
      if (Array.isArray(value) && value.some((entry) => typeof entry === "string" && entry.includes("~"))) {
        return FAIL;
      }
      return formatList(value);
    },
  };
}

/**
 * The parse shared by the closed-vocabulary lists. An unusable member costs that
 * element, not the whole parameter: a link written against another build should
 * not wipe the selection. Where *every* member is unusable there is no rest to
 * keep. The empty list it would otherwise parse to is a state of its own — no
 * components, no imagery — and the url hands that back as deliberate, so this
 * case costs the whole parameter and the caller's default stands. An empty value
 * names no member and still means the empty list.
 */
function resolveList(raw: string, resolve: (entry: string) => string | undefined): Result<string[]> {
  const entries = splitList(raw);
  const resolved = entries.flatMap((entry) => {
    const member = resolve(entry);
    return member === undefined ? [] : [member];
  });
  return entries.length > 0 && resolved.length === 0 ? FAIL : ok(resolved);
}

/**
 * `elements`. A closed vocabulary, so the legacy "-" space escape can be
 * resolved by membership rather than applied blindly: try the literal first,
 * fall back to "-" → space, and drop the element only if neither names a known
 * component. That ordering is what lets a component name contain a hyphen.
 */
export function closedStringList(members: () => readonly string[]): FieldKind<string[]> {
  const resolve = (entry: string, known: readonly string[]): string | undefined => {
    if (known.includes(entry)) {
      return entry;
    }
    const unescaped = entry.replaceAll("-", " ");
    return known.includes(unescaped) ? unescaped : undefined;
  };
  return {
    parse: (raw) => {
      const known = members();
      return resolveList(raw, (entry) => resolve(entry, known));
    },
    format: (value) => {
      const known = members();
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !known.includes(entry))) {
        return FAIL;
      }
      return formatList(value);
    },
  };
}

/**
 * `layers`. Each item is a provider name with an optional "_<alpha>" opacity
 * suffix, so the accepted set is checked against the leading segment. The
 * "at most one base layer" rule is a state invariant and lives in the store,
 * not here.
 */
export function layerList(providers: () => readonly string[]): FieldKind<string[]> {
  // Both the provider and the opacity have to be usable: an out-of-range or
  // non-numeric alpha would reach Cesium as NaN and render nothing at all.
  const usable = (entry: string, names: readonly string[]): string | undefined => {
    const selection = parseLayer(entry);
    return selection !== undefined && names.includes(selection.provider) ? formatLayer(selection) : undefined;
  };
  return {
    parse: (raw) => {
      const names = providers();
      return resolveList(raw, (entry) => usable(entry, names));
    },
    format: (value) => {
      const names = providers();
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || usable(entry, names) === undefined)) {
        return FAIL;
      }
      return formatList(value);
    },
  };
}

const STATION_SEPARATOR = "_";
const COORDINATE_PRECISION = 4;

/**
 * `gs`. "_"-joined stations, each "lat,lon" or "lat,lon,name". A malformed
 * station costs itself, not the whole parameter. Nothing invalid is stored, so
 * downstream callers never have to filter NaN coordinates.
 */
export function groundStationList(): FieldKind<SerializedGroundStation[]> {
  return {
    parse: (raw) =>
      ok(
        raw
          .split(STATION_SEPARATOR)
          .filter((entry) => entry !== "")
          .flatMap((entry) => {
            const parts = entry.split(LIST_SEPARATOR);
            if (parts.length < 2 || parts.length > 3) {
              return [];
            }
            const lat = Number.parseFloat(parts[0] ?? "");
            const lon = Number.parseFloat(parts[1] ?? "");
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
              return [];
            }
            const name = parts[2];
            return [name === undefined || name === "" ? { lat, lon } : { lat, lon, name }];
          }),
      ),
    format: (value) => {
      if (!Array.isArray(value)) {
        return FAIL;
      }
      const parts: string[] = [];
      for (const station of value as SerializedGroundStation[]) {
        if (!Number.isFinite(station?.lat) || !Number.isFinite(station?.lon)) {
          return FAIL;
        }
        const name = station.name;
        // Both separators are in-band, so a name carrying either is
        // unrepresentable. Refuse rather than corrupt.
        if (name !== undefined && (name.includes(LIST_SEPARATOR) || name.includes(STATION_SEPARATOR))) {
          return FAIL;
        }
        const coordinates = `${station.lat.toFixed(COORDINATE_PRECISION)},${station.lon.toFixed(COORDINATE_PRECISION)}`;
        parts.push(name ? `${coordinates},${name}` : coordinates);
      }
      return ok(parts.join(STATION_SEPARATOR));
    },
  };
}

const MINUTE_ISO = "YYYY-MM-DDTHH:mm[Z]";

/**
 * Round to the minute, or undefined if this is not a time at all. The one place
 * the minute wire form is spelled out; callers holding a Date pass it straight
 * in rather than formatting it themselves.
 */
export function toMinuteIso(value: string | Date): string | undefined {
  // dayjs is lenient enough to accept things like "Point", so gate on Date
  // first and let dayjs do the formatting.
  if (typeof value === "string" && Number.isNaN(Date.parse(value))) {
    return undefined;
  }
  const parsed = dayjs.utc(value);
  return parsed.isValid() ? parsed.format(MINUTE_ISO) : undefined;
}

/**
 * `time`. Minute precision on the way out, anything parseable on the way in —
 * unlike the other parameters there is no historic emitted form to stay
 * compatible with, because `time` was never written to the url before.
 *
 * `null` means the clock is live and the parameter is absent; formatting it
 * fails, which is how the codec drops a parameter.
 */
export function timestamp(): FieldKind<string | null> {
  const round = (value: unknown) => (typeof value === "string" ? toMinuteIso(value) : undefined);
  return {
    parse: (raw) => {
      const rounded = toMinuteIso(raw);
      return rounded === undefined ? FAIL : ok(rounded);
    },
    format: (value) => {
      const rounded = round(value);
      return rounded === undefined ? FAIL : ok(rounded);
    },
  };
}

export type Query = Readonly<Record<string, string | undefined>>;

export interface DecodeResult {
  // Every schema key, so an absent parameter resets its state to the default.
  patch: Record<string, unknown>;
  // Parameters that were present but unusable; the caller drops them from the url.
  invalid: string[];
}

/** The query parameter a field is carried in. */
export const paramOf = (spec: FieldSpec): string => spec.url ?? spec.name;

/**
 * Query -> state. Defaults are supplied by the caller because they are the
 * preset-merged store values, which this module has no way to know.
 */
export function decode(query: Query, schema: readonly FieldSpec[], defaults: Readonly<Record<string, unknown>>): DecodeResult {
  const patch: Record<string, unknown> = {};
  const invalid: string[] = [];

  for (const spec of schema) {
    const param = paramOf(spec);
    const raw = query[param];
    if (raw === undefined) {
      patch[spec.name] = defaults[spec.name];
      continue;
    }
    const parsed = (spec.kind as FieldKind<unknown>).parse(raw);
    if (!parsed.ok) {
      patch[spec.name] = defaults[spec.name];
      invalid.push(param);
      continue;
    }
    patch[spec.name] = parsed.value;
  }

  return { patch, invalid };
}

/**
 * State -> the parameters this codec owns. Returns a map rather than a string:
 * turning that into a url is the router's job, and its serializer already
 * matches the wire format this codec targets.
 *
 * Parameters belonging to anyone else are deliberately not handled here — only
 * the adapter has a query type able to express a valueless or repeated
 * parameter, and flattening one through this map would destroy it.
 */
export function encode(state: Readonly<Record<string, unknown>>, defaults: Readonly<Record<string, unknown>>, schema: readonly FieldSpec[]): Record<string, string> {
  const params: Record<string, string> = {};

  for (const spec of schema) {
    const param = paramOf(spec);
    const kind = spec.kind as FieldKind<unknown>;
    const formatted = kind.format(state[spec.name]);
    if (!formatted.ok) {
      // Unrepresentable: leave the parameter out rather than emit something
      // that reads back as a different value.
      delete params[param];
      continue;
    }
    const fallback = kind.format(defaults[spec.name]);
    if (fallback.ok && fallback.value === formatted.value) {
      delete params[param];
      continue;
    }
    params[param] = formatted.value;
  }

  return params;
}
