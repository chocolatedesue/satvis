import { describe, expect, test } from "vitest";

import { laneIndexFor } from "./sampleSource";

// The pool hands each satellite to one worker for the life of the session. Three
// things in WorkerSampleSource depend on that being a pure function of the satnum —
// the per-worker satrec cache, the single `#recordSent` set, and the eviction
// budget — so it is pinned here rather than left to the shape of the hash.

describe("laneIndexFor", () => {
  test("sends a satnum to the same lane every time", () => {
    for (const satnum of ["25544", "00900", "62841", "1", "999999"]) {
      const first = laneIndexFor(satnum, 4);
      for (let repeat = 0; repeat < 100; repeat += 1) {
        expect(laneIndexFor(satnum, 4)).toBe(first);
      }
    }
  });

  test("stays inside the pool", () => {
    for (let laneCount = 1; laneCount <= 8; laneCount += 1) {
      for (let satnum = 0; satnum < 500; satnum += 1) {
        const lane = laneIndexFor(String(satnum), laneCount);
        expect(lane).toBeGreaterThanOrEqual(0);
        expect(lane).toBeLessThan(laneCount);
        expect(Number.isInteger(lane)).toBe(true);
      }
    }
  });

  test("collapses to the single lane", () => {
    // The no-pool case has to stay exactly the old behaviour, including for a
    // degenerate lane count.
    expect(laneIndexFor("25544", 1)).toBe(0);
    expect(laneIndexFor("25544", 0)).toBe(0);
  });

  test("spreads consecutive catalog numbers across the pool", () => {
    // Satellites arrive as a slice of the sorted catalog, so consecutive satnums are
    // the realistic input. A hash that grouped them would leave one worker with the
    // whole activation and the rest idle.
    const laneCount = 4;
    const counts: number[] = Array.from({ length: laneCount }, () => 0);
    const population = 5000;
    for (let satnum = 20_000; satnum < 20_000 + population; satnum += 1) {
      const lane = laneIndexFor(String(satnum), laneCount);
      counts[lane] = (counts[lane] ?? 0) + 1;
    }
    const expected = population / laneCount;
    for (const count of counts) {
      // Within 20% of even. Wide, because this asserts "not degenerate" rather than
      // a property of this particular hash.
      expect(count).toBeGreaterThan(expected * 0.8);
      expect(count).toBeLessThan(expected * 1.2);
    }
  });

  test("spreads non-numeric satnums too", () => {
    // The reason this is not `Number(satnum) % laneCount`: those all parse to NaN,
    // and NaN % n is NaN, so every one of them would land on the same worker.
    const laneCount = 4;
    const seen = new Set<number>();
    for (const satnum of ["ISS", "STARLINK-1007", "2019-074A", "COSMOS 2251 DEB", "T-1", "unknown"]) {
      seen.add(laneIndexFor(satnum, laneCount));
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});
