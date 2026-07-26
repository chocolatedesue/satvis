import { describe, expect, test } from "vitest";

import { SATELLITE_COMPONENTS } from "../../config/components";
import {
  boolean,
  closedStringList,
  decode,
  encode,
  enumString,
  groundStationList,
  layerList,
  plainString,
  queryString,
  stringList,
  tildeEscapedStringList,
  timestamp,
  type FieldSpec,
} from "./urlCodec";

const components = () => SATELLITE_COMPONENTS as readonly string[];
const providers = () => ["Offline", "OfflineHighres", "ArcGis", "OSM", "Topo", "BlackMarble", "Tiles", "GOES-IR", "Nextrad"];

describe("boolean", () => {
  const kind = boolean();

  test("parses both literals", () => {
    expect(kind.parse("true")).toEqual({ ok: true, value: true });
    expect(kind.parse("false")).toEqual({ ok: true, value: false });
  });

  // The defect this kind exists to fix: with no deserializer, "false" reached
  // the store as a truthy string and switched the fps counter on.
  test("false is false, not a truthy string", () => {
    const parsed = kind.parse("false");
    expect(parsed.ok && parsed.value).toBe(false);
    expect(parsed.ok && typeof parsed.value).toBe("boolean");
  });

  test("rejects anything else", () => {
    expect(kind.parse("1").ok).toBe(false);
    expect(kind.parse("").ok).toBe(false);
    expect(kind.parse("TRUE").ok).toBe(false);
  });
});

describe("enumString", () => {
  const kind = enumString(["None", "Maptiler"]);

  test("accepts members and rejects non-members", () => {
    expect(kind.parse("Maptiler")).toEqual({ ok: true, value: "Maptiler" });
    expect(kind.parse("Garbage").ok).toBe(false);
  });

  test("refuses to format a non-member", () => {
    expect(kind.format("Garbage").ok).toBe(false);
  });
});

describe("stringList", () => {
  const kind = stringList();

  test("splits and joins on commas, dropping empties", () => {
    expect(kind.parse("Weather,Stations")).toEqual({ ok: true, value: ["Weather", "Stations"] });
    expect(kind.parse("Weather,,Stations")).toEqual({ ok: true, value: ["Weather", "Stations"] });
    expect(kind.parse("")).toEqual({ ok: true, value: [] });
    expect(kind.format(["Weather", "Stations"])).toEqual({ ok: true, value: "Weather,Stations" });
  });

  test("spaces need no escaping — the caller's query reader handles them", () => {
    expect(kind.parse("Deep Space")).toEqual({ ok: true, value: ["Deep Space"] });
    expect(kind.format(["Deep Space"])).toEqual({ ok: true, value: "Deep Space" });
  });

  // The whole point of dropping the "-" escape from tags.
  test("a hyphen in a member survives a round trip", () => {
    const formatted = kind.format(["X-Ray"]);
    expect(formatted).toEqual({ ok: true, value: "X-Ray" });
    expect(kind.parse("X-Ray")).toEqual({ ok: true, value: ["X-Ray"] });
  });

  test("refuses a member containing the separator instead of corrupting it", () => {
    expect(kind.format(["a,b"]).ok).toBe(false);
  });
});

describe("tildeEscapedStringList (sats / xsats legacy shim)", () => {
  const kind = tildeEscapedStringList();

  test("reads the legacy escaped form", () => {
    expect(kind.parse("NOAA~19,METOP-C")).toEqual({ ok: true, value: ["NOAA 19", "METOP-C"] });
  });

  test("reads the new unescaped form", () => {
    expect(kind.parse("NOAA 19,METOP-C")).toEqual({ ok: true, value: ["NOAA 19", "METOP-C"] });
  });

  test("emits unescaped", () => {
    expect(kind.format(["NOAA 19"])).toEqual({ ok: true, value: "NOAA 19" });
  });

  test("hyphens are untouched in both directions", () => {
    expect(kind.parse("STARLINK-1007")).toEqual({ ok: true, value: ["STARLINK-1007"] });
    expect(kind.format(["STARLINK-1007"])).toEqual({ ok: true, value: "STARLINK-1007" });
  });

  test("refuses a literal tilde, which the shim would read back as a space", () => {
    expect(kind.format(["FOO~BAR"]).ok).toBe(false);
  });
});

describe("closedStringList (elements)", () => {
  const kind = closedStringList(components);

  test("reads the legacy hyphen-escaped form", () => {
    expect(kind.parse("Point,Label,Sensor-cone,Ground-track")).toEqual({
      ok: true,
      value: ["Point", "Label", "Sensor cone", "Ground track"],
    });
  });

  test("reads the new form", () => {
    expect(kind.parse("Point,Label,Sensor cone")).toEqual({ ok: true, value: ["Point", "Label", "Sensor cone"] });
  });

  test("emits unescaped", () => {
    expect(kind.format(["Point", "Label", "Sensor cone"])).toEqual({ ok: true, value: "Point,Label,Sensor cone" });
  });

  test("drops an unknown member and keeps the rest", () => {
    expect(kind.parse("Point,Retired thing,Label")).toEqual({ ok: true, value: ["Point", "Label"] });
  });

  // The literal is tried before the shim, which is what makes a hyphenated
  // component name possible rather than a breaking change.
  test("prefers a literal match over the legacy shim", () => {
    const withHyphen = () => [...components(), "X-Ray"];
    const hyphenAware = closedStringList(withHyphen);
    expect(hyphenAware.parse("X-Ray")).toEqual({ ok: true, value: ["X-Ray"] });
    // and the escaped form of a real component still resolves
    expect(hyphenAware.parse("Sensor-cone")).toEqual({ ok: true, value: ["Sensor cone"] });
  });

  test("refuses to format an unknown component", () => {
    expect(kind.format(["Nope"]).ok).toBe(false);
  });
});

describe("layerList", () => {
  const kind = layerList(providers);

  test("keeps the alpha suffix", () => {
    expect(kind.parse("ArcGis_0.5,Nextrad")).toEqual({ ok: true, value: ["ArcGis_0.5", "Nextrad"] });
    expect(kind.format(["ArcGis_0.5", "Nextrad"])).toEqual({ ok: true, value: "ArcGis_0.5,Nextrad" });
  });

  test("a hyphenated provider name is fine", () => {
    expect(kind.parse("GOES-IR")).toEqual({ ok: true, value: ["GOES-IR"] });
  });

  test("drops an unknown provider and keeps the rest", () => {
    expect(kind.parse("ArcGis,Bogus,Nextrad")).toEqual({ ok: true, value: ["ArcGis", "Nextrad"] });
  });
});

describe("groundStationList", () => {
  const kind = groundStationList();

  test("round-trips a named and an unnamed station", () => {
    const raw = "48.1377,11.5754,Munich_-33.8688,151.2093";
    expect(kind.parse(raw)).toEqual({
      ok: true,
      value: [
        { lat: 48.1377, lon: 11.5754, name: "Munich" },
        { lat: -33.8688, lon: 151.2093 },
      ],
    });
    const formatted = kind.format([
      { lat: 48.1377, lon: 11.5754, name: "Munich" },
      { lat: -33.8688, lon: 151.2093 },
    ]);
    expect(formatted).toEqual({ ok: true, value: raw });
  });

  // Zero is a real coordinate. The filter this replaces tested `lat && lon`.
  test("keeps a station on the equator and the prime meridian", () => {
    expect(kind.parse("0,11.5")).toEqual({ ok: true, value: [{ lat: 0, lon: 11.5 }] });
    expect(kind.parse("48.1,0")).toEqual({ ok: true, value: [{ lat: 48.1, lon: 0 }] });
    expect(kind.format([{ lat: 0, lon: 0 }])).toEqual({ ok: true, value: "0.0000,0.0000" });
  });

  test("drops a malformed station and keeps the valid ones", () => {
    expect(kind.parse("48.1,11.5_garbage_52.5,13.4")).toEqual({
      ok: true,
      value: [
        { lat: 48.1, lon: 11.5 },
        { lat: 52.5, lon: 13.4 },
      ],
    });
  });

  test("never yields NaN coordinates", () => {
    const parsed = kind.parse("48.1,");
    expect(parsed).toEqual({ ok: true, value: [] });
  });

  test("refuses a name carrying either separator", () => {
    expect(kind.format([{ lat: 1, lon: 2, name: "Munich, DE" }]).ok).toBe(false);
    expect(kind.format([{ lat: 1, lon: 2, name: "Site_A" }]).ok).toBe(false);
  });
});

describe("timestamp", () => {
  const kind = timestamp();

  test("rounds to the minute on the way out", () => {
    expect(kind.format("2026-07-26T20:46:37.512Z")).toEqual({ ok: true, value: "2026-07-26T20:46Z" });
  });

  test("accepts anything parseable on the way in", () => {
    expect(kind.parse("2026-07-26T20:46Z")).toEqual({ ok: true, value: "2026-07-26T20:46Z" });
    expect(kind.parse("2026-07-26T20:46:37Z")).toEqual({ ok: true, value: "2026-07-26T20:46Z" });
    expect(kind.parse("2026-07-26")).toEqual({ ok: true, value: "2026-07-26T00:00Z" });
  });

  test("rejects a non-time", () => {
    expect(kind.parse("Point").ok).toBe(false);
    expect(kind.parse("").ok).toBe(false);
  });

  // null is the live clock: not a value the url carries.
  test("refuses to format null, which is how the parameter is omitted", () => {
    expect(kind.format(null).ok).toBe(false);
  });

  test("round-trips", () => {
    const formatted = kind.format("2026-07-26T20:46:37Z");
    expect(formatted.ok && kind.parse(formatted.value)).toEqual({ ok: true, value: "2026-07-26T20:46Z" });
  });
});

// ---------------------------------------------------------------------------

const SCHEMA: FieldSpec[] = [
  { name: "enabledComponents", url: "elements", kind: closedStringList(components) },
  { name: "enabledTags", url: "tags", kind: stringList() },
  { name: "enabledSatellites", url: "sats", kind: tildeEscapedStringList() },
  { name: "trackedSatellite", url: "track", kind: plainString() },
  { name: "showFps", url: "fps", kind: boolean() },
  { name: "layers", url: "layers", kind: layerList(providers) },
  { name: "time", url: "time", kind: timestamp() },
];

const DEFAULTS = {
  enabledComponents: ["Point", "Label"],
  enabledTags: [] as string[],
  enabledSatellites: [] as string[],
  trackedSatellite: "",
  showFps: false,
  layers: ["OfflineHighres"],
  time: null as string | null,
};

describe("decode", () => {
  test("an absent parameter resets its state to the default", () => {
    const { patch, invalid } = decode({}, SCHEMA, DEFAULTS);
    expect(patch).toEqual(DEFAULTS);
    expect(invalid).toEqual([]);
  });

  test("an invalid parameter falls back to the default and is reported", () => {
    const { patch, invalid } = decode({ fps: "yes" }, SCHEMA, DEFAULTS);
    expect(patch.showFps).toBe(false);
    expect(invalid).toEqual(["fps"]);
  });

  test("one invalid parameter does not disturb the others", () => {
    const { patch, invalid } = decode({ fps: "yes", tags: "Weather" }, SCHEMA, DEFAULTS);
    expect(patch.enabledTags).toEqual(["Weather"]);
    expect(invalid).toEqual(["fps"]);
  });
});

describe("encode", () => {
  test("omits everything that matches the default", () => {
    expect(encode(DEFAULTS, DEFAULTS, SCHEMA)).toEqual({});
  });

  test("emits only what deviates", () => {
    expect(encode({ ...DEFAULTS, enabledTags: ["Weather", "Stations"] }, DEFAULTS, SCHEMA)).toEqual({ tags: "Weather,Stations" });
  });

  test("preserves parameters it does not own", () => {
    const params = encode({ ...DEFAULTS, showFps: true }, DEFAULTS, SCHEMA, { utm_source: "x", fbclid: "y" });
    expect(params).toEqual({ utm_source: "x", fbclid: "y", fps: "true" });
  });

  test("a live clock leaves no time parameter", () => {
    expect(encode(DEFAULTS, DEFAULTS, SCHEMA)).toEqual({});
  });

  test("a pinned clock emits one", () => {
    expect(encode({ ...DEFAULTS, time: "2026-07-26T20:46Z" }, DEFAULTS, SCHEMA)).toEqual({ time: "2026-07-26T20:46Z" });
  });

  test("omits a value it cannot represent rather than corrupting it", () => {
    expect(encode({ ...DEFAULTS, enabledSatellites: ["FOO~BAR"] }, DEFAULTS, SCHEMA)).toEqual({});
  });

  test("leaves commas unescaped in the wire form", () => {
    expect(queryString(encode({ ...DEFAULTS, enabledTags: ["a", "b"] }, DEFAULTS, SCHEMA))).toBe("?tags=a,b");
  });

  test("the wire form is empty when nothing deviates", () => {
    expect(queryString(encode(DEFAULTS, DEFAULTS, SCHEMA))).toBe("");
  });
});

describe("round trip", () => {
  test("decode(encode(state)) === state for every field", () => {
    const state = {
      enabledComponents: ["Point", "Label", "Sensor cone", "Ground track"],
      enabledTags: ["Weather", "Stations"],
      enabledSatellites: ["NOAA 19", "STARLINK-1007"],
      trackedSatellite: "ISS (ZARYA)",
      showFps: true,
      layers: ["ArcGis_0.5", "Nextrad"],
      time: "2026-07-26T20:46Z",
    };
    const params = encode(state, DEFAULTS, SCHEMA);
    // through the wire form and back, so the round trip covers encoding too
    const parsed = Object.fromEntries(new URLSearchParams(queryString(params)));
    expect(decode(parsed, SCHEMA, DEFAULTS).patch).toEqual(state);
  });
});

// Every URL that worked before this codec must still mean the same thing.
describe("read compatibility with the pre-codec format", () => {
  test("a legacy url decodes to the values it always meant", () => {
    const legacy = "elements=Point,Label,Orbit,Sensor-cone,Ground-track&sats=IRIDIUM-NEXT%7E106&tags=Weather,Stations&track=ISS+%28ZARYA%29&fps=true";
    const query = Object.fromEntries(new URLSearchParams(legacy));
    expect(decode(query, SCHEMA, DEFAULTS).patch).toEqual({
      enabledComponents: ["Point", "Label", "Orbit", "Sensor cone", "Ground track"],
      enabledTags: ["Weather", "Stations"],
      enabledSatellites: ["IRIDIUM-NEXT 106"],
      trackedSatellite: "ISS (ZARYA)",
      showFps: true,
      layers: ["OfflineHighres"],
      time: null,
    });
  });

  test("the one intentional break: ?fps=false now means false", () => {
    const query = Object.fromEntries(new URLSearchParams("fps=false"));
    expect(decode(query, SCHEMA, DEFAULTS).patch.showFps).toBe(false);
  });
});
