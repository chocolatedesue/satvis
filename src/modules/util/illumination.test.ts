import { propagate } from "satellite.js";
import { describe, expect, it } from "vitest";

import { ILLUMINATION_COLOR, ILLUMINATION_DESCRIPTION, ILLUMINATION_STATES } from "../../config/illumination";
import { createSatrec } from "./gp";
import { IlluminationCache, illuminationAt, illuminationOf, illuminationState, illuminationTimeline, panelNormal, sunGeometry, type SunGeometry } from "./illumination";
import { walkerDeltaRecords } from "./walkerDelta";

const EPOCH = new Date("2026-01-01T00:00:00.000Z");

/** A 550 km / 53° satellite, from the generator this analysis is paired with. */
function shellSatrec() {
  const [record] = walkerDeltaRecords({ total: 6, planes: 3, phasing: 1, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 }, EPOCH);
  return createSatrec(record!);
}

/** A sun straight down +X at 1 AU, so the geometry is checkable by hand. */
const sunAlongX: SunGeometry = { au: { x: 1, y: 0, z: 0 }, unit: { x: 1, y: 0, z: 0 } };

describe("illuminationState", () => {
  it("calls a fully covered disc umbra", () => {
    expect(illuminationState(0, 1)).toBe("umbra");
    expect(illuminationState(0.0005, 1)).toBe("umbra");
  });

  it("calls a partly covered disc penumbra, whatever the panel is doing", () => {
    expect(illuminationState(0.5, 1)).toBe("penumbra");
    expect(illuminationState(0.5, -1)).toBe("penumbra");
  });

  it("separates the three ways a fully lit satellite can stand", () => {
    expect(illuminationState(1, 0.9)).toBe("sunlit_on");
    expect(illuminationState(1, -0.9)).toBe("sunlit_back");
    expect(illuminationState(1, 0.02)).toBe("sunlit_edge");
    expect(illuminationState(1, -0.02)).toBe("sunlit_edge");
  });

  it("puts the edge band on both sides of zero", () => {
    expect(illuminationState(1, 0.1)).toBe("sunlit_edge");
    expect(illuminationState(1, 0.11)).toBe("sunlit_on");
    expect(illuminationState(1, -0.11)).toBe("sunlit_back");
  });
});

describe("panelNormal", () => {
  const position = { x: 7000, y: 0, z: 0 };
  const velocity = { x: 0, y: 7.5, z: 0 };

  it("points a zenith panel straight out along the radius", () => {
    expect(panelNormal(position, velocity, "zenith")).toEqual({ x: 1, y: 0, z: 0 });
  });

  it("points a velocity panel along the flight direction", () => {
    expect(panelNormal(position, velocity, "velocity")).toEqual({ x: 0, y: 1, z: 0 });
  });

  it("points a normal panel along r × v", () => {
    expect(panelNormal(position, velocity, "normal")).toEqual({ x: 0, y: 0, z: 1 });
  });

  it("declines a degenerate state rather than returning a NaN direction", () => {
    expect(panelNormal({ x: 0, y: 0, z: 0 }, velocity, "zenith")).toBeUndefined();
    expect(panelNormal(position, { x: 7.5, y: 0, z: 0 }, "normal")).toBeUndefined();
  });
});

describe("illuminationOf", () => {
  it("reads κ = +1 for a zenith panel at the subsolar point", () => {
    const result = illuminationOf({ x: 7000, y: 0, z: 0 }, { x: 0, y: 7.5, z: 0 }, sunAlongX, "zenith");
    expect(result!.kappa).toBeCloseTo(1, 6);
    expect(result!.nu).toBeCloseTo(1, 6);
    expect(result!.state).toBe("sunlit_on");
  });

  it("reads κ = −1 on the far side, and calls it umbra because the Earth is in the way", () => {
    const result = illuminationOf({ x: -7000, y: 0, z: 0 }, { x: 0, y: 7.5, z: 0 }, sunAlongX, "zenith");
    expect(result!.kappa).toBeCloseTo(-1, 6);
    expect(result!.nu).toBeCloseTo(0, 6);
    expect(result!.state).toBe("umbra");
  });

  it("finds the state this vocabulary exists for: lit, but the panel faces away", () => {
    // Well off to the side of the Earth's shadow (y = 20000 km) and behind the
    // terminator in x, so nothing occults the sun and the zenith panel still
    // points away from it.
    const result = illuminationOf({ x: -3000, y: 20000, z: 0 }, { x: 0, y: 0, z: 7.5 }, sunAlongX, "zenith");
    expect(result!.nu).toBeCloseTo(1, 6);
    expect(result!.kappa).toBeLessThan(0);
    expect(result!.state).toBe("sunlit_back");
  });

  it("reports β = 0 for a sun lying in the orbital plane", () => {
    const result = illuminationOf({ x: 7000, y: 0, z: 0 }, { x: 0, y: 7.5, z: 0 }, sunAlongX, "zenith");
    expect(result!.betaDeg).toBeCloseTo(0, 6);
  });

  it("reports β = ±90° for a sun along the orbit normal, where a normal panel is fully lit", () => {
    // Orbit in the x-y plane, normal along +z; sun along +z.
    const sunAlongZ: SunGeometry = { au: { x: 0, y: 0, z: 1 }, unit: { x: 0, y: 0, z: 1 } };
    const result = illuminationOf({ x: 7000, y: 0, z: 0 }, { x: 0, y: 7.5, z: 0 }, sunAlongZ, "normal");
    expect(result!.betaDeg).toBeCloseTo(90, 6);
    expect(result!.kappa).toBeCloseTo(1, 6);
  });

  it("leaves a zenith panel edge-on for the whole of a β = 90° orbit", () => {
    const sunAlongZ: SunGeometry = { au: { x: 0, y: 0, z: 1 }, unit: { x: 0, y: 0, z: 1 } };
    for (const angle of [0, 45, 90, 180, 270]) {
      const radians = (angle * Math.PI) / 180;
      const position = { x: 7000 * Math.cos(radians), y: 7000 * Math.sin(radians), z: 0 };
      const velocity = { x: -7.5 * Math.sin(radians), y: 7.5 * Math.cos(radians), z: 0 };
      const result = illuminationOf(position, velocity, sunAlongZ, "zenith");
      expect(result!.kappa).toBeCloseTo(0, 6);
      expect(result!.state).toBe("sunlit_edge");
    }
  });

  it("declines a degenerate state", () => {
    expect(illuminationOf({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, sunAlongX, "zenith")).toBeUndefined();
  });
});

describe("sunGeometry", () => {
  it("puts the sun about 1 AU away", () => {
    const sun = sunGeometry(EPOCH)!;
    const distance = Math.sqrt(sun.au.x ** 2 + sun.au.y ** 2 + sun.au.z ** 2);
    expect(distance).toBeGreaterThan(0.98);
    expect(distance).toBeLessThan(1.02);
  });

  it("puts it below the equator at the January solstice epoch", () => {
    // Declination ~ −23° in early January, so the z component of the unit vector
    // is negative and about sin(−23°).
    const sun = sunGeometry(EPOCH)!;
    expect(sun.unit.z).toBeLessThan(0);
    expect(sun.unit.z).toBeCloseTo(-0.39, 1);
  });

  it("moves about a degree a day", () => {
    const a = sunGeometry(EPOCH)!.unit;
    const b = sunGeometry(new Date(EPOCH.getTime() + 86400_000))!.unit;
    const cosine = a.x * b.x + a.y * b.y + a.z * b.z;
    const degrees = (Math.acos(cosine) * 180) / Math.PI;
    expect(degrees).toBeGreaterThan(0.8);
    expect(degrees).toBeLessThan(1.2);
  });
});

describe("illuminationAt", () => {
  it("answers for a real satrec", () => {
    const result = illuminationAt(shellSatrec(), EPOCH, "zenith");
    expect(result).toBeDefined();
    expect(result!.nu).toBeGreaterThanOrEqual(0);
    expect(result!.nu).toBeLessThanOrEqual(1);
    expect(ILLUMINATION_STATES).toContain(result!.state);
  });

  it("agrees with the position the app would draw at the same instant", () => {
    const satrec = shellSatrec();
    const sun = sunGeometry(EPOCH)!;
    const state = propagate(satrec, EPOCH)!;
    expect(illuminationAt(satrec, EPOCH, "zenith")).toEqual(illuminationOf(state.position, state.velocity, sun, "zenith"));
  });
});

describe("IlluminationCache", () => {
  it("reuses one answer inside a second and recomputes across the boundary", () => {
    const cache = new IlluminationCache(shellSatrec(), "zenith");
    const first = cache.at(new Date("2026-01-01T00:00:00.000Z"));
    const sameSecond = cache.at(new Date("2026-01-01T00:00:00.900Z"));
    const nextSecond = cache.at(new Date("2026-01-01T00:00:01.000Z"));
    expect(sameSecond).toBe(first);
    expect(nextSecond).not.toBe(first);
    expect(nextSecond!.kappa).not.toBe(first!.kappa);
  });

  it("drops the memo when the panel model changes", () => {
    const cache = new IlluminationCache(shellSatrec(), "zenith");
    const zenith = cache.at(EPOCH)!;
    cache.axis = "normal";
    const normal = cache.at(EPOCH)!;
    expect(cache.axis).toBe("normal");
    expect(normal.kappa).not.toBeCloseTo(zenith.kappa, 6);
    // ν does not depend on the panel, so it must not have moved.
    expect(normal.nu).toBeCloseTo(zenith.nu, 12);
  });

  it("keeps the memo when the axis is reassigned to what it already was", () => {
    const cache = new IlluminationCache(shellSatrec(), "zenith");
    const first = cache.at(EPOCH);
    cache.axis = "zenith";
    expect(cache.at(EPOCH)).toBe(first);
  });
});

describe("illuminationTimeline", () => {
  it("covers one orbit and splits it into states that sum to 1", () => {
    const timeline = illuminationTimeline(shellSatrec(), EPOCH, 5700, 10, "zenith");
    expect(timeline.samples.length).toBeGreaterThan(500);
    const total = Object.values(timeline.fractions).reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it("finds an eclipse in a 53° / 550 km orbit and puts it near the textbook share", () => {
    const timeline = illuminationTimeline(shellSatrec(), EPOCH, 5700, 10, "zenith");
    const eclipsed = (timeline.fractions.umbra ?? 0) + (timeline.fractions.penumbra ?? 0);
    // A LEO orbit at a low beta angle spends roughly a third of it in the Earth's
    // shadow; the band is wide because the exact share depends on beta.
    expect(eclipsed).toBeGreaterThan(0.2);
    expect(eclipsed).toBeLessThan(0.45);
  });

  it("counts a back-facing panel as dark even though the satellite is lit", () => {
    const timeline = illuminationTimeline(shellSatrec(), EPOCH, 5700, 10, "zenith");
    const eclipsed = (timeline.fractions.umbra ?? 0) + (timeline.fractions.penumbra ?? 0);
    expect(timeline.fractions.sunlit_back ?? 0).toBeGreaterThan(0);
    expect(timeline.darkFraction).toBeCloseTo(eclipsed + (timeline.fractions.sunlit_back ?? 0), 12);
    expect(timeline.darkFraction).toBeGreaterThan(eclipsed);
  });

  it("reports every sample in time order with its own timestamp", () => {
    const timeline = illuminationTimeline(shellSatrec(), EPOCH, 600, 60, "zenith");
    expect(timeline.samples.map((sample) => sample.timeMs)).toEqual(Array.from({ length: 11 }, (_unused, index) => EPOCH.getTime() + index * 60_000));
  });

  it("floors the step at one second rather than looping forever on zero", () => {
    const timeline = illuminationTimeline(shellSatrec(), EPOCH, 5, 0, "zenith");
    expect(timeline.samples).toHaveLength(6);
  });

  it("returns an empty split for a span with no usable samples", () => {
    const timeline = illuminationTimeline(shellSatrec(), EPOCH, -1, 10, "zenith");
    expect(timeline.samples).toEqual([]);
    expect(timeline.fractions).toEqual({});
    expect(timeline.darkFraction).toBe(0);
  });
});

describe("the vocabulary tables", () => {
  it("gives every state a colour and a description", () => {
    for (const state of ILLUMINATION_STATES) {
      expect(ILLUMINATION_COLOR[state]).toMatch(/^#[0-9a-f]{6}$/);
      expect(ILLUMINATION_DESCRIPTION[state]).toBeTruthy();
    }
  });

  it("gives each state its own colour", () => {
    const colours = new Set(ILLUMINATION_STATES.map((state) => ILLUMINATION_COLOR[state]));
    expect(colours.size).toBe(ILLUMINATION_STATES.length);
  });
});
