import { describe, expect, test } from "vitest";

import { buildPlan, CUMULATIVE_COMPONENT_SETS, formatSeries, ISOLATED_COMPONENT_SETS, type BenchmarkStep } from "./benchmarkPlan";
import type { BenchmarkResult, BenchmarkRun, SceneApplied } from "./benchmarkRunner";
import { FrameSampler, JANK_MS, seriesStats } from "./frameSampler";
import { gpuTimerTrustworthy, marginalCosts, propagationCosts, repeatChecks, reportRows, scalingFits, thinRows, toCsv } from "./report";

// A result carrying only what the report reads. `cpuMs` is the figure every
// derived table differences, so it is the one the fixtures set deliberately.
function result(options: {
  sats: number;
  components: string[];
  clock?: number;
  cpuMs: number;
  gpuMs?: number;
  wallMs?: number;
  repeat?: boolean;
  buildMs?: number;
  visible?: number;
  frames?: number;
}): BenchmarkResult {
  const clock = options.clock ?? 1;
  const components = options.components;
  const step: BenchmarkStep = {
    index: 0,
    satelliteCount: options.sats,
    components,
    clockMultiplier: clock,
    repeat: options.repeat ?? false,
    series: formatSeries(components, clock),
    label: "",
  };
  const applied: SceneApplied = {
    satellitesRequested: options.sats,
    satellitesVisible: options.visible ?? options.sats,
    componentsRequested: components,
    componentsDrawn: components,
    componentInstances: {},
    clockMultiplier: clock,
    entities: 0,
    primitives: 0,
    clearMs: 0,
    buildMs: options.buildMs ?? 0,
  };
  const frames = options.frames ?? 100;
  return {
    step,
    applied,
    frames: {
      frames,
      elapsedMs: frames * 10,
      fps: 100,
      wall: seriesStats([options.wallMs ?? 10]),
      cpu: seriesStats([options.cpuMs]),
      gpu: options.gpuMs === undefined ? undefined : seriesStats([options.gpuMs]),
      jankFrames: 0,
      jankRatio: 0,
    },
    heapMb: undefined,
  };
}

const run = (results: BenchmarkResult[]): BenchmarkRun => ({
  startedAtIso: "2026-01-01T00:00:00.000Z",
  environment: {},
  options: { warmupMs: 0, sampleMs: 0 },
  catalogSize: 0,
  results,
  cancelled: false,
});

describe("seriesStats", () => {
  test("no values means no stats, rather than a row of zeroes", () => {
    expect(seriesStats([])).toBeUndefined();
  });

  test("percentiles come off the sorted values, whatever order they arrived in", () => {
    const stats = seriesStats([50, 10, 30, 20, 40]);
    expect(stats).toMatchObject({ count: 5, min: 10, max: 50, mean: 30, p50: 30 });
  });

  test("the input array is left in its arrival order", () => {
    const values = [3, 1, 2];
    seriesStats(values);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe("FrameSampler", () => {
  test("the first push only sets the origin, so one timestamp is no frame", () => {
    const sampler = new FrameSampler();
    sampler.push(1000);
    expect(sampler.frames).toBe(0);
    expect(sampler.snapshot().wall).toBeUndefined();
  });

  test("deltas between timestamps become the wall series", () => {
    const sampler = new FrameSampler();
    for (const [index, time] of [0, 10, 20, 30].entries()) {
      sampler.push(1000 + time, index);
    }
    const snapshot = sampler.snapshot();
    expect(snapshot.frames).toBe(3);
    expect(snapshot.elapsedMs).toBe(30);
    expect(snapshot.fps).toBeCloseTo(100);
    expect(snapshot.wall?.mean).toBe(10);
  });

  test("frames slower than 30 fps count as jank", () => {
    const sampler = new FrameSampler();
    sampler.push(0);
    sampler.push(10);
    sampler.push(10 + JANK_MS + 1);
    const snapshot = sampler.snapshot();
    expect(snapshot.jankFrames).toBe(1);
    expect(snapshot.jankRatio).toBeCloseTo(0.5);
  });

  test("reset drops the samples but keeps the origin, so no frame is lost at the seam", () => {
    const sampler = new FrameSampler();
    sampler.push(0);
    sampler.push(100);
    sampler.reset();
    sampler.push(110);
    expect(sampler.frames).toBe(1);
    expect(sampler.snapshot().wall?.mean).toBe(10);
  });

  test("a limit makes the window roll rather than grow", () => {
    const sampler = new FrameSampler(2);
    for (let i = 0; i <= 10; i += 1) {
      sampler.push(i * 10);
    }
    expect(sampler.frames).toBe(2);
  });
});

describe("buildPlan", () => {
  test("counts are deduplicated, sorted and cleared of nonsense", () => {
    const steps = buildPlan({ satelliteCounts: [100, 0, 100, -5, 10.5], componentSets: [["Point"]] });
    expect(steps.filter((step) => !step.repeat).map((step) => step.satelliteCount)).toEqual([0, 100]);
  });

  test("component sets are outermost so a cancelled sweep leaves whole series", () => {
    const steps = buildPlan({ satelliteCounts: [1, 2], componentSets: [["Point"], ["Label"]], repeatFirstStep: false });
    expect(steps.map((step) => `${step.components.join()}@${step.satelliteCount}`)).toEqual(["Point@1", "Point@2", "Label@1", "Label@2"]);
  });

  test("the clock is a real axis, and one value unless asked for", () => {
    const plain = buildPlan({ satelliteCounts: [1], componentSets: [["Point"]], repeatFirstStep: false });
    expect(plain.map((step) => step.clockMultiplier)).toEqual([1]);

    const swept = buildPlan({ satelliteCounts: [1, 2], componentSets: [["Point"]], clockMultipliers: [1, 100], repeatFirstStep: false });
    expect(swept.map((step) => `${step.clockMultiplier}@${step.satelliteCount}`)).toEqual(["1@1", "1@2", "100@1", "100@2"]);
  });

  test("the series names the clock only when it is not real time", () => {
    expect(formatSeries(["Point"], 1)).toBe("Point");
    expect(formatSeries(["Point"], 100)).toBe("Point @ ×100");
  });

  test("the first step is re-run last, and marked", () => {
    const steps = buildPlan({ satelliteCounts: [10, 20], componentSets: [["Point"]] });
    const last = steps[steps.length - 1] as BenchmarkStep;
    expect(steps).toHaveLength(3);
    expect(last.repeat).toBe(true);
    expect(last.satelliteCount).toBe(10);
    expect(steps.filter((step) => step.repeat)).toHaveLength(1);
  });

  test("a lone step is not repeated — there would be nothing to compare it against", () => {
    expect(buildPlan({ satelliteCounts: [10], componentSets: [["Point"]] })).toHaveLength(1);
  });

  test("the cumulative sets grow by one component and start from nothing", () => {
    expect(CUMULATIVE_COMPONENT_SETS[0]).toEqual([]);
    expect(CUMULATIVE_COMPONENT_SETS[1]).toEqual(["Point"]);
    for (const [index, set] of CUMULATIVE_COMPONENT_SETS.entries()) {
      expect(set).toHaveLength(index);
    }
  });

  test("the isolated sets are Point plus exactly one other", () => {
    expect(ISOLATED_COMPONENT_SETS[0]).toEqual(["Point"]);
    for (const set of ISOLATED_COMPONENT_SETS.slice(1)) {
      expect(set[0]).toBe("Point");
      expect(set).toHaveLength(2);
    }
  });
});

describe("scalingFits", () => {
  test("a linear cost is reported as its slope per 1,000 satellites", () => {
    const fits = scalingFits(
      run([
        result({ sats: 0, components: ["Point"], cpuMs: 5 }),
        result({ sats: 500, components: ["Point"], cpuMs: 10 }),
        result({ sats: 1000, components: ["Point"], cpuMs: 15 }),
      ]),
    );
    expect(fits).toHaveLength(1);
    expect(fits[0]).toMatchObject({ series: "Point", cpuMsPer1000: 10, baseCpuMs: 5, r2: 1 });
  });

  test("clock rates are separate series, never one averaged fit", () => {
    const fits = scalingFits(
      run([
        result({ sats: 0, components: ["Point"], cpuMs: 5 }),
        result({ sats: 1000, components: ["Point"], cpuMs: 10 }),
        result({ sats: 0, components: ["Point"], clock: 100, cpuMs: 20 }),
        result({ sats: 1000, components: ["Point"], clock: 100, cpuMs: 60 }),
      ]),
    );
    expect(fits.map((fit) => fit.series)).toEqual(["Point", "Point @ ×100"]);
    expect(fits[1]?.cpuMsPer1000).toBe(40);
  });

  test("the repeat step is left out, so it cannot weight one point twice", () => {
    const fits = scalingFits(
      run([
        result({ sats: 0, components: ["Point"], cpuMs: 5 }),
        result({ sats: 1000, components: ["Point"], cpuMs: 15 }),
        result({ sats: 0, components: ["Point"], cpuMs: 500, repeat: true }),
      ]),
    );
    expect(fits[0]).toMatchObject({ points: 2, cpuMsPer1000: 10, baseCpuMs: 5 });
  });

  test("satsAt60fps is blank when the fixed cost already blows the budget", () => {
    const fits = scalingFits(run([result({ sats: 0, components: ["Point"], cpuMs: 30 }), result({ sats: 1000, components: ["Point"], cpuMs: 40 })]));
    expect(fits[0]?.satsAt60fps).toBe("");
  });
});

describe("marginalCosts", () => {
  test("a set is differenced against the largest subset measured beside it", () => {
    const costs = marginalCosts(
      run([
        result({ sats: 100, components: ["Point"], cpuMs: 10 }),
        result({ sats: 100, components: ["Point", "Label"], cpuMs: 14 }),
        result({ sats: 100, components: ["Point", "Label", "Orbit"], cpuMs: 20 }),
      ]),
    );
    expect(costs).toEqual([
      { sats: 100, clock: 1, added: "Label", over: "Point", deltaCpuMs: 4, usPerSatellite: 40 },
      { sats: 100, clock: 1, added: "Orbit", over: "Point + Label", deltaCpuMs: 6, usPerSatellite: 60 },
    ]);
  });

  test("rows under different clocks are never differenced against each other", () => {
    const costs = marginalCosts(run([result({ sats: 100, components: ["Point"], cpuMs: 10 }), result({ sats: 100, components: ["Point", "Label"], clock: 100, cpuMs: 90 })]));
    expect(costs).toEqual([]);
  });

  test("a set with no subset beside it yields no row rather than a bogus baseline", () => {
    const costs = marginalCosts(run([result({ sats: 100, components: ["Label"], cpuMs: 10 }), result({ sats: 100, components: ["Orbit"], cpuMs: 20 })]));
    expect(costs).toEqual([]);
  });
});

describe("propagationCosts", () => {
  test("each rate is differenced against x1 for the same scene", () => {
    const costs = propagationCosts(
      run([
        result({ sats: 200, components: ["Point"], cpuMs: 10 }),
        result({ sats: 200, components: ["Point"], clock: 100, cpuMs: 30 }),
        result({ sats: 200, components: ["Point"], clock: 1000, cpuMs: 110 }),
      ]),
    );
    expect(costs.map((cost) => [cost.clock, cost.deltaCpuMs, cost.usPerSatellite])).toEqual([
      [100, 20, 100],
      [1000, 100, 500],
    ]);
  });

  test("without a x1 row there is nothing to difference against", () => {
    const costs = propagationCosts(
      run([result({ sats: 200, components: ["Point"], clock: 100, cpuMs: 30 }), result({ sats: 200, components: ["Point"], clock: 1000, cpuMs: 110 })]),
    );
    expect(costs).toEqual([]);
  });

  test("a run that never swept the clock reports nothing at all", () => {
    expect(propagationCosts(run([result({ sats: 200, components: ["Point"], cpuMs: 10 })]))).toEqual([]);
  });
});

describe("repeatChecks", () => {
  test("the repeat is matched to its original and reported as drift", () => {
    const checks = repeatChecks(
      run([
        result({ sats: 100, components: ["Point"], cpuMs: 10, buildMs: 800 }),
        result({ sats: 500, components: ["Point"], cpuMs: 20, buildMs: 100 }),
        result({ sats: 100, components: ["Point"], cpuMs: 11, buildMs: 200, repeat: true }),
      ]),
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ sats: 100, firstCpuMs: 10, repeatCpuMs: 11, cpuDriftPct: 10, firstBuildMs: 800, repeatBuildMs: 200, buildDriftPct: -75 });
  });

  test("a run without a repeat step reports nothing", () => {
    expect(repeatChecks(run([result({ sats: 100, components: ["Point"], cpuMs: 10 })]))).toEqual([]);
  });
});

describe("gpu timing", () => {
  test("a plausible GPU time is reported", () => {
    const rows = reportRows(run([result({ sats: 0, components: ["Point"], cpuMs: 1, gpuMs: 9, wallMs: 14 })]));
    expect(rows[0]?.gpuMs).toBe(9);
  });

  test("a GPU-bound scene, where gpu approaches the frame interval, is still believed", () => {
    const rows = reportRows(run([result({ sats: 0, components: ["Point"], cpuMs: 1, gpuMs: 13.5, wallMs: 14 })]));
    expect(rows[0]?.gpuMs).toBe(13.5);
  });

  test("a timer claiming more GPU than the frame it presented in is withheld", () => {
    // The ANGLE/Metal case: 49 ms of "GPU" against frames arriving every 14 ms.
    // A frame that presented cannot have cost that, so the column goes blank
    // rather than print it.
    const bad = run([result({ sats: 0, components: ["Point"], cpuMs: 1, gpuMs: 49, wallMs: 14 })]);
    expect(gpuTimerTrustworthy(bad)).toBe(false);
    expect(reportRows(bad)[0]?.gpuMs).toBe("");
  });

  test("one odd step does not discredit a run, a majority does", () => {
    const mostlyFine = run([
      result({ sats: 0, components: ["Point"], cpuMs: 1, gpuMs: 9, wallMs: 14 }),
      result({ sats: 1, components: ["Point"], cpuMs: 1, gpuMs: 9, wallMs: 14 }),
      result({ sats: 2, components: ["Point"], cpuMs: 1, gpuMs: 60, wallMs: 14 }),
    ]);
    expect(gpuTimerTrustworthy(mostlyFine)).toBe(true);

    const mostlyBad = run([
      result({ sats: 0, components: ["Point"], cpuMs: 1, gpuMs: 60, wallMs: 14 }),
      result({ sats: 1, components: ["Point"], cpuMs: 1, gpuMs: 60, wallMs: 14 }),
      result({ sats: 2, components: ["Point"], cpuMs: 1, gpuMs: 9, wallMs: 14 }),
    ]);
    expect(gpuTimerTrustworthy(mostlyBad)).toBe(false);
  });

  test("no GPU samples at all is blank, not zero", () => {
    const none = run([result({ sats: 0, components: ["Point"], cpuMs: 1 })]);
    expect(gpuTimerTrustworthy(none)).toBe(false);
    expect(reportRows(none)[0]?.gpuMs).toBe("");
  });

  test("the sampler keeps GPU timings as their own population", () => {
    const sampler = new FrameSampler();
    sampler.push(0);
    sampler.push(10, 1);
    sampler.push(20, 1);
    // Two frames, one GPU result — they arrive out of step and are not paired.
    sampler.pushGpu(8);
    const snap = sampler.snapshot();
    expect(snap.frames).toBe(2);
    expect(snap.gpu?.count).toBe(1);
    expect(snap.gpu?.mean).toBe(8);
  });

  test("reset clears GPU timings with everything else", () => {
    const sampler = new FrameSampler();
    sampler.pushGpu(8);
    sampler.reset();
    expect(sampler.snapshot().gpu).toBeUndefined();
  });
});

describe("thinRows", () => {
  test("rows sampled over too few frames are the ones flagged", () => {
    const thin = thinRows(run([result({ sats: 0, components: ["Point"], cpuMs: 1, frames: 3 }), result({ sats: 1, components: ["Point"], cpuMs: 1, frames: 300 })]));
    expect(thin.map((row) => row.frames)).toEqual([3]);
  });
});

describe("toCsv", () => {
  test("the header names every column of the row beneath it", () => {
    const csv = toCsv(run([result({ sats: 1, components: ["Point", "Label"], cpuMs: 1 })]));
    const [header, row] = csv.split("\n");
    expect(header?.split(",")).toContain("components");
    expect(row?.split(",")).toHaveLength(header?.split(",").length ?? 0);
  });

  test("a value carrying a comma is quoted rather than left to split the row", () => {
    // Component names must not contain commas (see CONTEXT.md), so this is the
    // quoting being defensive rather than a case the app can reach — and the row
    // staying one field is the whole point of it.
    const csv = toCsv(run([result({ sats: 1, components: ["Point", "A,B"], cpuMs: 1 })]));
    const [header, row] = csv.split("\n");
    expect(row).toContain('"Point + A,B"');
    expect(row?.split(",")).toHaveLength((header?.split(",").length ?? 0) + 1);
  });

  test("an empty run is an empty string rather than a lone header", () => {
    expect(toCsv(run([]))).toBe("");
  });
});
