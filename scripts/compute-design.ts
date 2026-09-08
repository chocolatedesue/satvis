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

import { capacityReport, powerSeries, selectHosts, type OrbitPhase } from "../src/modules/util/computeCapacity.ts";
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
    record.kind === "omm" ? [{ altitudeKm: params.altitudeKm, inclinationDeg: params.inclinationDeg, nodeDeg: Number(record.omm.RA_OF_ASC_NODE), phaseDeg: Number(record.omm.MEAN_ANOMALY) }] : [],
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
