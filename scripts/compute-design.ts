// How much compute a design delivers over one cycle, and how steady that is.
//
// The capacity question is not "how sunny is the fleet" — it is "how often is
// every stage of the pipeline powered at once", because one dark stage stops the
// whole pipeline. This sweeps the knobs a designer actually holds — how many
// shells, how many planes, how deep the pipeline — at a fixed satellite and GPU
// budget, and prints the two columns that matter: what the placement delivers,
// and what migration could add on top of it.
//
//   node --experimental-strip-types scripts/orbit-lab.ts capacity <alt>:<inc> [sats] [gpusPerSat] [stages]
//
// See docs/compute-capacity.md for what the sweep found.

import { capacityReport, fleetUtilization, powerSeries, selectHosts, selectHostsRandom, selectHostsSunniest, type OrbitPhase } from "../src/modules/util/computeCapacity.ts";
import { shellFamily, familyCycleHours, minSatellitesPerRing } from "../src/modules/util/shellLayout.ts";
import { walkerDeltaRecords, WALKER_EPOCH_ISO, type WalkerDeltaParams } from "../src/modules/util/walkerDelta.ts";

/** The epoch every generated pattern is stated at, so a design is a date as well as a geometry. */
const EPOCH = new Date(WALKER_EPOCH_ISO);

/** Sample step: a minute, which is a fortieth of the shortest eclipse worth planning around. */
const STEP_SECONDS = 60;

/** The pipeline depths worth reporting — a decode is not usefully cut into fewer than two. */
const DEPTHS = [2, 4, 6, 8] as const;

/** Plane counts worth reporting: few planes crowd the fleet's eclipses together. */
const PLANES = [2, 4, 6] as const;

function membersOf(params: WalkerDeltaParams): OrbitPhase[] {
  return walkerDeltaRecords(params, EPOCH).flatMap((record) =>
    record.kind === "omm"
      ? [{ altitudeKm: params.altitudeKm, inclinationDeg: params.inclinationDeg, nodeDeg: Number(record.omm.RA_OF_ASC_NODE), phaseDeg: Number(record.omm.MEAN_ANOMALY) }]
      : [],
  );
}

interface Row {
  shells: number;
  planes: number;
  depth: number;
  lit: number;
  serving: number;
  ceiling: number;
  stallMinutes: number;
  stalls: number;
  gpuHours: number;
}

function measure(
  members: OrbitPhase[],
  cycleHours: number,
  depth: number,
  gpusPerSat: number,
): { serving: number; ceiling: number; stallMinutes: number; stalls: number; gpuHours: number; lit: number } {
  const series = powerSeries(members, { start: EPOCH, hours: cycleHours, stepSeconds: STEP_SECONDS });
  const hosts = selectHosts(series, depth);
  const report = capacityReport(series, hosts, gpusPerSat);
  const lit = series.litFraction.reduce((total, value) => total + value, 0) / Math.max(1, series.litFraction.length);
  return {
    serving: report.servingFraction,
    ceiling: report.ceilingFraction,
    stallMinutes: report.longestStallSeconds / 60,
    stalls: report.stalls,
    gpuHours: report.gpuHours,
    lit,
  };
}

function fixed(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "—";
}

export function usageCapacity(): string {
  return ["  capacity <altKm>:<incDeg> [sats] [gpusPerSat]  how much compute a design holds, over one family cycle"].join("\n");
}

/** The report: one table per plane count, one row per (shells, depth). */
export function reportCapacity(orbit: { altitudeKm: number; inclinationDeg: number }, satellites = 60, gpusPerSat = 8, stages = 4): void {
  const shells = shellFamily(orbit, { cycleRevolutions: 15 });
  const cycleHours = familyCycleHours(shells);
  console.log("");
  console.log(`== compute capacity: ${orbit.inclinationDeg}° / ${orbit.altitudeKm} km ==`);
  console.log(`   ${satellites} satellites, ${gpusPerSat} GPUs each, one family cycle = ${cycleHours.toFixed(2)} h`);
  if (shells.length === 0) {
    console.log("   no family holds at this orbit");
    return;
  }

  const rows: Row[] = [];
  let pruned = 0;
  for (const planeCount of PLANES) {
    for (let shellCount = 1; shellCount <= shells.length; shellCount += 1) {
      const used = shells.slice(0, shellCount);
      // A ring link's chord has to clear the Earth, so a plane cannot be flown
      // thinner than `minSatellitesPerRing` at the lowest shell in the set — and
      // that, not the budget, is what caps how many shells a fleet can be split
      // into. A combination that cannot keep its rings is not a cheaper design,
      // it is a different one: a shell with no ring links has no fabric.
      const floor = Math.max(...used.map((shell) => minSatellitesPerRing(shell.altitudeKm)));
      const perPlane = Math.floor(satellites / (shellCount * planeCount));
      if (perPlane < floor) {
        pruned += 1;
        continue;
      }
      const members: OrbitPhase[] = [];
      for (const shell of used) {
        const params: WalkerDeltaParams = {
          total: perPlane * planeCount,
          planes: planeCount,
          phasing: 1,
          inclinationDeg: shell.inclinationDeg,
          altitudeKm: shell.altitudeKm,
          raanSpanDeg: 360,
        };
        members.push(...membersOf(params));
      }
      for (const depth of DEPTHS) {
        const measured = measure(members, cycleHours, depth, gpusPerSat);
        rows.push({ shells: shellCount, planes: planeCount, depth, ...measured });
      }
    }
  }

  console.log("");
  console.log("   shells planes depth |  lit   serving  ceiling  longest stall |  GPU-hours");
  for (const row of rows) {
    console.log(
      `     ${String(row.shells).padStart(4)} ${String(row.planes).padStart(6)} ${String(row.depth).padStart(5)} |` +
        ` ${fixed(row.lit, 3)}   ${fixed(row.serving, 3)}    ${fixed(row.ceiling, 3)}    ${fixed(row.stallMinutes, 1).padStart(6)} min (${String(row.stalls).padStart(2)}) |` +
        ` ${fixed(row.gpuHours, 0).padStart(7)}`,
    );
  }
  if (pruned > 0) {
    console.log("");
    console.log(`   ${pruned} combination(s) omitted: ${satellites} satellites cannot fill that many planes that thinly and still keep a ring link clear of the Earth.`);
  }

  const best = rows.toSorted((a, b) => b.gpuHours - a.gpuHours)[0];
  const steadiest = rows.filter((row) => row.depth === stages).toSorted((a, b) => b.serving - a.serving || a.stalls - b.stalls)[0];
  if (best) {
    console.log("");
    console.log(`   most GPU-hours: ${best.shells} shell(s) x ${best.planes} planes at depth ${best.depth} — ${fixed(best.gpuHours, 0)} GPU-hours per cycle`);
  }
  if (steadiest) {
    console.log(
      `   steadiest at depth ${stages}: ${steadiest.shells} shell(s) x ${steadiest.planes} planes — ${fixed(steadiest.serving, 3)} serving, longest stall ${fixed(steadiest.stallMinutes, 1)} min`,
    );
  }
}

/** One design, measured the way the paper reports it. */
interface Measurement {
  serving: number;
  ceiling: number;
  stallMinutes: number;
  stalls: number;
  gpuHours: number;
  utilization: number;
}

function measureAll(members: OrbitPhase[], cycleHours: number, depth: number, gpusPerSat: number, satellites: number, start = EPOCH): Measurement {
  const series = powerSeries(members, { start, hours: cycleHours, stepSeconds: STEP_SECONDS });
  const report = capacityReport(series, selectHosts(series, depth), gpusPerSat);
  return {
    serving: report.servingFraction,
    ceiling: report.ceilingFraction,
    stallMinutes: report.longestStallSeconds / 60,
    stalls: report.stalls,
    gpuHours: report.gpuHours,
    utilization: fleetUtilization(report, satellites, gpusPerSat, cycleHours),
  };
}

/** How many satellites a design actually flies. */
function flownFor(shells: number, planes: number, perPlane: number): number {
  return shells * planes * perPlane;
}

/**
 * The pool for one design: `shellCount` shells of the family, `planeCount`
 * planes each, `perPlane` satellites per plane.
 */
function poolFor(used: { altitudeKm: number; inclinationDeg: number }[], planeCount: number, perPlane: number): OrbitPhase[] {
  return used.flatMap((shell) =>
    membersOf({
      total: perPlane * planeCount,
      planes: planeCount,
      phasing: 1,
      inclinationDeg: shell.inclinationDeg,
      altitudeKm: shell.altitudeKm,
      raanSpanDeg: 360,
    }),
  );
}

export function usageEvaluate(): string {
  return ["  evaluate <altKm>:<incDeg> [sats] [gpusPerSat] [stages]  baselines and ablations, paper tables"].join("\n");
}

/**
 * The evaluation: baselines first, then one-factor-at-a-time ablations.
 *
 * Printed as the tables in `docs/compute-capacity.md`, which is why every row
 * carries the design it came from rather than just its score — a number without
 * the shell and plane count it was measured at is not a result.
 */
export function reportEvaluation(orbit: { altitudeKm: number; inclinationDeg: number }, satellites = 60, gpusPerSat = 8, stages = 4): void {
  const shells = shellFamily(orbit, { cycleRevolutions: 15 });
  const cycleHours = familyCycleHours(shells);
  const shellCount = Math.min(3, shells.length);
  const planeCount = 2;
  const floor = Math.max(...shells.slice(0, shellCount).map((shell) => minSatellitesPerRing(shell.altitudeKm)));
  const perPlane = Math.max(floor, Math.floor(satellites / (shellCount * planeCount)));
  const used = shells.slice(0, shellCount);
  const pool = poolFor(used, planeCount, perPlane);
  const flown = flownFor(shellCount, planeCount, perPlane);

  console.log("");
  console.log(`== evaluation: ${orbit.inclinationDeg}° / ${orbit.altitudeKm} km ==`);
  console.log(`   pool: ${flown} satellites — ${shellCount} shells x ${planeCount} planes x ${perPlane} per plane; cycle ${cycleHours.toFixed(2)} h; ${gpusPerSat} GPUs each`);

  const series = powerSeries(pool, { start: EPOCH, hours: cycleHours, stepSeconds: STEP_SECONDS });

  console.log("");
  console.log(`   baselines (depth ${stages})            serving   ceiling   longest stall   GPU-hours   fleet util`);
  const rows: Array<[string, Measurement]> = [];

  // Random: five seeds, reported as mean and worst, because a single seed is an
  // anecdote and the spread is the point — placement matters this much.
  const randomScores: number[] = [];
  const randomGpu: number[] = [];
  const randomStalls: number[] = [];
  for (let seed = 1; seed <= 5; seed += 1) {
    const report = capacityReport(series, selectHostsRandom(series, stages, seed), gpusPerSat);
    randomScores.push(report.servingFraction);
    randomGpu.push(report.gpuHours);
    randomStalls.push(report.longestStallSeconds / 60);
  }
  const randomMean = randomScores.reduce((a, b) => a + b, 0) / randomScores.length;
  const randomWorst = Math.min(...randomScores);
  const randomGpuMean = randomGpu.reduce((a, b) => a + b, 0) / randomGpu.length;
  // Worst, not mean: a scheduler plans against the worst seed it could have got.
  const randomStall = Math.max(...randomStalls);
  console.log(
    `     random placement (5 seeds)      ${fixed(randomMean, 3)} ±${fixed(randomMean - randomWorst, 3)}   1.000   ${fixed(randomStall, 1).padStart(6)} min    ${fixed(randomGpuMean, 0).padStart(7)}       ${fixed((randomGpuMean / (flown * gpusPerSat * cycleHours)) * 100, 1).padStart(5)}%`,
  );

  const sunniest = capacityReport(series, selectHostsSunniest(series, stages), gpusPerSat);
  console.log(
    `     sunniest-first                  ${fixed(sunniest.servingFraction, 3)}    1.000   ${fixed(sunniest.longestStallSeconds / 60, 1).padStart(6)} min    ${fixed(sunniest.gpuHours, 0).padStart(7)}       ${fixed(fleetUtilization(sunniest, flown, gpusPerSat, cycleHours) * 100, 1).padStart(5)}%`,
  );

  // One shell, budget-matched: the same satellites flown as one shell instead of
  // three. Not one shell of a third of the fleet — a baseline that spends fewer
  // satellites is not a baseline, it is a different experiment.
  const singlePerPlane = Math.max(floor, Math.floor(satellites / planeCount));
  const single = measureAll(poolFor(used.slice(0, 1), planeCount, singlePerPlane), cycleHours, stages, gpusPerSat, flownFor(1, planeCount, singlePerPlane));
  console.log(
    `     single shell (industry default) ${fixed(single.serving, 3)}    ${fixed(single.ceiling, 3)}   ${fixed(single.stallMinutes, 1).padStart(6)} min    ${fixed(single.gpuHours, 0).padStart(7)}       ${fixed(single.utilization * 100, 1).padStart(5)}%`,
  );

  const ours = measureAll(pool, cycleHours, stages, gpusPerSat, flown);
  console.log(
    `     ours: greedy joint selection    ${fixed(ours.serving, 3)}    ${fixed(ours.ceiling, 3)}   ${fixed(ours.stallMinutes, 1).padStart(6)} min    ${fixed(ours.gpuHours, 0).padStart(7)}       ${fixed(ours.utilization * 100, 1).padStart(5)}%`,
  );
  rows.push(["ours", ours]);

  console.log("");
  console.log("   ablations (one factor at a time)");

  console.log("");
  console.log("     A1 shells (planes 2, depth " + stages + ")");
  for (let k = 1; k <= Math.min(3, shells.length); k += 1) {
    const per = Math.max(floor, Math.floor(satellites / (k * planeCount)));
    // Budget-matched: every row flies the same satellites, split differently.
    const m = measureAll(poolFor(used.slice(0, k), planeCount, per), cycleHours, stages, gpusPerSat, flownFor(k, planeCount, per));
    console.log(
      `       ${k} shell(s) x ${per}/plane  serving ${fixed(m.serving, 3)}  stall ${fixed(m.stallMinutes, 1).padStart(5)} min  GPU-hours ${fixed(m.gpuHours, 0).padStart(6)}`,
    );
  }

  console.log("");
  console.log("     A2 planes (" + shellCount + " shells, depth " + stages + ")");
  for (const p of [2, 4, 6]) {
    const perP = Math.floor(satellites / (shellCount * p));
    if (perP < floor) {
      console.log(`       ${p} planes — infeasible: ${perP} per plane is below the ${floor} a ring link needs to clear the Earth`);
      continue;
    }
    const m = measureAll(poolFor(used, p, perP), cycleHours, stages, gpusPerSat, flownFor(shellCount, p, perP));
    console.log(
      `       ${p} planes x ${perP}/plane  serving ${fixed(m.serving, 3)}  stall ${fixed(m.stallMinutes, 1).padStart(5)} min  GPU-hours ${fixed(m.gpuHours, 0).padStart(6)}`,
    );
  }

  console.log("");
  // Ablated where it matters — on the single shell, where the pool is small
  // enough that placement decides the outcome. Across three shells even a random
  // placement finds four satellites that never eclipse together, which is itself
  // the result: diversity makes the selection easy.
  console.log("     A3 selection (1 shell, budget-matched, depth " + stages + ")");
  const singleSeries = powerSeries(poolFor(used.slice(0, 1), planeCount, singlePerPlane), { start: EPOCH, hours: cycleHours, stepSeconds: STEP_SECONDS });
  const randomHere: number[] = [];
  for (let seed = 1; seed <= 5; seed += 1) {
    randomHere.push(capacityReport(singleSeries, selectHostsRandom(singleSeries, stages, seed), gpusPerSat).servingFraction);
  }
  const randomHereMean = randomHere.reduce((a, b) => a + b, 0) / randomHere.length;
  console.log(`       random (5 seeds)  serving ${fixed(randomHereMean, 3)}  (worst ${fixed(Math.min(...randomHere), 3)})`);
  console.log(`       sunniest-first    serving ${fixed(capacityReport(singleSeries, selectHostsSunniest(singleSeries, stages), gpusPerSat).servingFraction, 3)}`);
  console.log(`       greedy joint      serving ${fixed(single.serving, 3)}`);

  console.log("");
  console.log("     A4 pipeline depth");
  for (const depth of DEPTHS) {
    const m = measureAll(pool, cycleHours, depth, gpusPerSat, flown);
    console.log(
      `       ${depth} stages   serving ${fixed(m.serving, 3)}  stall ${fixed(m.stallMinutes, 1).padStart(5)} min  GPU-hours ${fixed(m.gpuHours, 0).padStart(6)}  util ${fixed(m.utilization * 100, 1).padStart(5)}%`,
    );
  }

  console.log("");
  console.log("     A5 season (the sun moves; the fleet's nodes do not)");
  for (const month of [0, 3, 6, 9]) {
    const start = new Date(Date.UTC(2026, month, 1));
    const m = measureAll(pool, cycleHours, stages, gpusPerSat, flown, start);
    console.log(
      `       ${start.toISOString().slice(0, 10)}  serving ${fixed(m.serving, 3)}  stall ${fixed(m.stallMinutes, 1).padStart(5)} min  GPU-hours ${fixed(m.gpuHours, 0).padStart(6)}`,
    );
  }

  console.log("");
  console.log("     A6 the sun (model ablation: does a 24 h window need the sun to move?)");
  for (const moveSun of [true, false]) {
    const s = powerSeries(pool, { start: EPOCH, hours: cycleHours, stepSeconds: STEP_SECONDS, moveSun });
    const report = capacityReport(s, selectHosts(s, stages), gpusPerSat);
    console.log(
      `       sun ${moveSun ? "moved " : "frozen"}  serving ${fixed(report.servingFraction, 3)}  stall ${fixed(report.longestStallSeconds / 60, 1).padStart(5)} min  GPU-hours ${fixed(report.gpuHours, 0).padStart(6)}`,
    );
  }

  // How much of the fleet one fleet-scale workload can use: a deeper cut uses
  // more of the GPUs that are already flying, until the conjunction breaks.
  console.log("");
  console.log("     A7 how deep the cut can go before the conjunction breaks");
  for (const depth of [8, 16, 24, 32, 48]) {
    const m = measureAll(pool, cycleHours, depth, gpusPerSat, flown);
    console.log(
      `       ${String(depth).padStart(2)} stages   serving ${fixed(m.serving, 3)}  stall ${fixed(m.stallMinutes, 1).padStart(5)} min  GPU-hours ${fixed(m.gpuHours, 0).padStart(6)}  util ${fixed(m.utilization * 100, 1).padStart(5)}%`,
    );
  }

  const gap = ours.ceiling - single.serving;
  console.log("");
  console.log(
    `   the migration gap at one shell: ${fixed(gap, 3)} — what a hand-off mechanism is buying, and the only number in this table that a baseline cannot reach by spending satellites.`,
  );
}
