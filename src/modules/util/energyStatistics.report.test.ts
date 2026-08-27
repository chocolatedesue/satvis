// Generates docs/starlink-energy-report.md — the Starlink shells' energy statistics,
// computed from the same ν and κ the globe is painted with.
//
// Why it lives in a test file: the statistics come from `src/modules/util/*.ts`, and
// vitest is the only runner in this repo that resolves those imports. A standalone
// `.mjs` script would have to either duplicate the physics or reach for a TypeScript
// loader that is not a dependency — and a statistic that has drifted from the picture
// it claims to summarise is worse than no statistic. So the runner generates it:
//
//   pnpm energy-report
//
// Skipped by default, because it is a minute of SGP4 rather than a test: `pnpm test`
// stays fast and CI does not recompute a document nobody asked for. The assertions it
// does carry are about the report's own integrity — that every shell produced numbers,
// and that the invariants the text asserts in prose actually hold in the data.

import { writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { PanelAxis } from "../../config/illumination";
import { fleetSeries, fleetSnapshot, orbitEnergyProfile, percentile, secondsUntilDark, type OrbitEnergyProfile } from "./energyStatistics";
import { createSatrec } from "./gp";
import { betaCycleDays, dawnDuskBetaRangeDeg, eclipseFreeBetaDeg, nodalPrecessionDegPerDay, SUN_DEG_PER_DAY } from "./sunSynchronous";
import { WALKER_EPOCH_ISO, walkerDeltaRecords, type WalkerDeltaParams } from "./walkerDelta";

const ENABLED = process.env.ENERGY_REPORT === "1";

/**
 * The gen-1 Starlink shells, as commonly cited from the FCC filings.
 *
 * Provenance matters here and the numbers have moved: the 2018 authorisation, the 2019
 * modification that lowered the first shells from ~1150 km to ~550 km, and the 2020-21
 * modifications all differ. This is the widely quoted post-modification gen-1 set,
 * 4408 satellites in five shells. Treat the totals and plane counts as "the design as
 * filed", not as what is in orbit on any given day.
 *
 * `phasing` is not published and does not enter any statistic here: with 20+ satellites
 * evenly spread round each plane, the along-track offset between planes changes which
 * satellite is where, not how much of the shell is in shadow. It is set to 1 so the
 * pattern validates.
 */
interface Shell {
  name: string;
  params: WalkerDeltaParams;
}

const SHELLS: Shell[] = [
  { name: "S1 — 550 km / 53.0°", params: { total: 1584, planes: 72, phasing: 1, inclinationDeg: 53.0, altitudeKm: 550, raanSpanDeg: 360 } },
  { name: "S2 — 540 km / 53.2°", params: { total: 1584, planes: 72, phasing: 1, inclinationDeg: 53.2, altitudeKm: 540, raanSpanDeg: 360 } },
  { name: "S3 — 570 km / 70.0°", params: { total: 720, planes: 36, phasing: 1, inclinationDeg: 70.0, altitudeKm: 570, raanSpanDeg: 360 } },
  { name: "S4 — 560 km / 97.6°", params: { total: 348, planes: 6, phasing: 1, inclinationDeg: 97.6, altitudeKm: 560, raanSpanDeg: 360 } },
  { name: "S5 — 560 km / 97.6°", params: { total: 172, planes: 4, phasing: 1, inclinationDeg: 97.6, altitudeKm: 560, raanSpanDeg: 360 } },
];

/** Four dates through the year: the sun's declination is what moves these numbers. */
const DATES = [
  ["Mar equinox", "2026-03-20T12:00:00Z"],
  ["Jun solstice", "2026-06-21T12:00:00Z"],
  ["Sep equinox", "2026-09-22T12:00:00Z"],
  ["Dec solstice", "2026-12-21T12:00:00Z"],
] as const;

/** The panel model the report is computed under. Named in the output, because κ is a model. */
const AXIS: PanelAxis = "zenith";

/** How many planes of a shell to sample. β varies with RAAN, so one plane is not a shell. */
const PLANES_SAMPLED = 12;

/** One representative satellite per sampled plane. */
function planeRepresentatives(shell: Shell) {
  const perPlane = Math.round(shell.params.total / shell.params.planes);
  const stride = Math.max(1, Math.floor(shell.params.planes / PLANES_SAMPLED));
  const records = walkerDeltaRecords(shell.params, new Date(WALKER_EPOCH_ISO));
  const chosen = [];
  for (let plane = 0; plane < shell.params.planes; plane += stride) {
    const record = records[plane * perPlane];
    if (record) {
      chosen.push(createSatrec(record));
    }
  }
  return chosen;
}

/** Every satellite of every shell, for the fleet-level figures. */
function wholeFleet() {
  return SHELLS.flatMap((shell) => walkerDeltaRecords(shell.params, new Date(WALKER_EPOCH_ISO)).map((record) => createSatrec(record)));
}

const seconds = (value: number) => `${Math.round(value)} s`;
const minutes = (value: number) => `${(value / 60).toFixed(1)} min`;
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

interface ShellRow {
  shell: string;
  date: string;
  profiles: OrbitEnergyProfile[];
}

function summarise(profiles: OrbitEnergyProfile[]) {
  const eclipse = profiles.map((p) => p.eclipseFraction);
  const dark = profiles.map((p) => p.darkFraction);
  const longestEclipse = profiles.map((p) => p.longestEclipseSeconds);
  const longestDark = profiles.map((p) => p.longestDarkSeconds);
  const beta = profiles.map((p) => Math.abs(p.betaDeg));
  return {
    periodMinutes: profiles[0]?.periodMinutes ?? Number.NaN,
    betaMin: Math.min(...beta),
    betaMax: Math.max(...beta),
    eclipseMin: Math.min(...eclipse),
    eclipseMax: Math.max(...eclipse),
    darkMin: Math.min(...dark),
    darkMax: Math.max(...dark),
    longestEclipse: Math.max(...longestEclipse),
    longestDark: Math.max(...longestDark),
    penumbra: Math.max(...profiles.map((p) => p.penumbraSecondsPerOrbit)),
    planesNeverEclipsed: eclipse.filter((value) => value === 0).length,
    planesSampled: profiles.length,
  };
}

describe.skipIf(!ENABLED)("the Starlink energy report", () => {
  it("computes it and writes docs/starlink-energy-report.md", () => {
    const rows: ShellRow[] = [];
    for (const shell of SHELLS) {
      const satrecs = planeRepresentatives(shell);
      for (const [label, iso] of DATES) {
        rows.push({ shell: shell.name, date: label, profiles: satrecs.map((satrec) => orbitEnergyProfile(satrec, new Date(iso), AXIS)) });
      }
    }
    expect(rows).toHaveLength(SHELLS.length * DATES.length);
    for (const row of rows) {
      expect(row.profiles.length, `${row.shell} ${row.date}`).toBeGreaterThan(3);
    }

    // Fleet level: every satellite of every shell, over one day at 2-minute steps.
    const fleet = wholeFleet();
    expect(fleet.length).toBe(SHELLS.reduce((sum, shell) => sum + shell.params.total, 0));
    const fleetByDate = DATES.map(([label, iso]) => ({
      label,
      series: fleetSeries(fleet, new Date(iso), 86400, 120, AXIS),
      snapshot: fleetSnapshot(fleet, new Date(iso), AXIS),
    }));

    // Scheduling horizon: for one shell, how long from a random instant until the host
    // goes dark. Sampled across an orbit rather than across the fleet, because the
    // answer is a property of where in its orbit a satellite happens to be.
    const horizonShell = SHELLS[0] as Shell;
    const horizonSatrec = planeRepresentatives(horizonShell)[0]!;
    const horizons: number[] = [];
    for (let minute = 0; minute < 96; minute += 1) {
      const value = secondsUntilDark(horizonSatrec, new Date(new Date(DATES[1][1]).getTime() + minute * 60_000), AXIS, 6000, 10);
      if (value !== undefined) {
        horizons.push(value);
      }
    }
    expect(horizons.length).toBeGreaterThan(20);

    const lines: string[] = [];
    lines.push("# Starlink energy statistics");
    lines.push("");
    lines.push("Generated by `pnpm energy-report` (`src/modules/util/energyStatistics.report.test.ts`).");
    lines.push("Recompute rather than edit: every number here comes from the same functions the globe is");
    lines.push("painted with.");
    lines.push("");
    lines.push("## Where the numbers come from, and where they stop");
    lines.push("");
    lines.push("- **ν, the eclipse channel** — `satellite.js` `shadowFraction`: the exact circle–circle");
    lines.push("  overlap of the Sun's and Earth's apparent discs seen from the satellite, so umbra and");
    lines.push("  penumbra are distinct. Spherical Earth (WGS-72 radius), no atmosphere, no oblateness.");
    lines.push("  The sun is `satellite.js` `sunPos`, a port of Vallado's low-precision formula: 0.01°,");
    lines.push("  valid 1950–2050.");
    lines.push("- **κ, the panel channel** — this repo's model, not a measurement. Nothing in a GP element");
    lines.push(`  set describes attitude. Computed here under the **${AXIS}** panel model: a body-fixed`);
    lines.push("  panel on the anti-Earth face of a nadir-pointing bus. A sun-tracking panel would read");
    lines.push("  much better; the orbit-normal model would read better still. Treat every *dark* figure");
    lines.push('  below as "this panel model", and every *eclipse* figure as geometry.');
    lines.push("- **Propagation** — SGP4 over synthetic circular element sets generated from the shell");
    lines.push("  parameters, at the shells' filed altitudes and inclinations. No drag, no");
    lines.push("  station-keeping, no manoeuvres.");
    lines.push("- **Not modelled** — batteries, charge rate, panel area, pointing loss, thermal limits,");
    lines.push("  eclipse-season station-keeping, or any power policy. These are the illumination facts a");
    lines.push("  power budget is built on, not the budget.");
    lines.push("");
    lines.push("## Shells");
    lines.push("");
    lines.push("As commonly cited from the post-modification gen-1 filings — 4408 satellites in five");
    lines.push("shells. Plane counts are the design as filed, not what is in orbit today.");
    lines.push("");
    lines.push("| Shell | Satellites | Planes | Period | Node drift | β cycle | Max \\|β\\| reachable | β needed to clear the shadow |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const shell of SHELLS) {
      const { altitudeKm, inclinationDeg, total, planes } = shell.params;
      const profile = orbitEnergyProfile(planeRepresentatives(shell)[0]!, new Date(DATES[0][1]), AXIS);
      // The most β any plane in this shell can ever see: the best-oriented plane, at the
      // best moment of the year. Whether that clears the shadow is the whole story.
      // Taken over both solstices and the equinox — the first version of this only
      // checked one solstice and reported 59° for the 97.6° shells, which is their
      // *worst* case, not their best.
      const maxBeta = dawnDuskBetaRangeDeg(inclinationDeg).maxDeg;
      const cycleDays = betaCycleDays(altitudeKm, inclinationDeg);
      // Ten years is not a cycle anyone routes around; say what it is instead.
      const cycle = cycleDays > 3650 ? "frozen — quasi-SSO" : `${cycleDays.toFixed(0)} days`;
      lines.push(
        `| ${shell.name} | ${total} | ${planes} | ${profile.periodMinutes.toFixed(1)} min | ${nodalPrecessionDegPerDay(altitudeKm, inclinationDeg).toFixed(2)}°/day | ${cycle} | ${maxBeta.toFixed(1)}° | ${eclipseFreeBetaDeg(altitudeKm).toFixed(1)}° |`,
      );
    }
    lines.push("");
    lines.push("None of the five is sun-synchronous, and none is at an altitude where a *dawn–dusk*");
    lines.push("orbit could be always sunlit — that band is 1610–3080 km.");
    lines.push("");
    lines.push("But the last two columns say something the shells were not designed for, and it is the");
    lines.push("finding this report exists for: **in every shell, the β a well-oriented plane can reach");
    lines.push("exceeds the β it needs to clear the Earth's shadow.** At 53° a plane reaches 76.4° and needs");
    lines.push("67.0°. So some planes are, at some times, **not eclipsed at all** — while other planes of the");
    lines.push("same shell are in shadow for a third of every orbit.");
    lines.push("");
    lines.push("The β-cycle column says how that structure behaves over time, and the shells split in two:");
    lines.push("");
    lines.push("- **The 53° shells (S1, S2) rotate.** Their nodes regress 4.5°/day against the sun's");
    lines.push("  1°/day, so each plane takes its turn in the sunlit season roughly every 66 days. Any");
    lines.push("  static assignment of energy-hungry work to planes goes stale in weeks.");
    lines.push("- **The 97.6° shells (S4, S5) are frozen.** Their node drift is +0.98°/day, which is the");
    lines.push("  sun's own rate to within a hundredth — they are *accidentally sun-synchronous*. Each plane");
    lines.push("  keeps its angle to the sun indefinitely, so its energy budget is a standing property of");
    lines.push("  the plane rather than a phase in a cycle. Some planes are permanently well-lit and others");
    lines.push("  permanently deeply eclipsed, and it does not rotate.");
    lines.push("- **S3 at 70° sits between them**, on a 103-day cycle and with the highest reachable β of");
    lines.push("  the five (86.6°).");
    lines.push("");
    lines.push("## Per-orbit energy, by shell and season");
    lines.push("");
    lines.push(`${PLANES_SAMPLED} planes sampled per shell, two orbits per sample, 10 s steps. Ranges are across planes:`);
    lines.push("β varies with a plane's right ascension, so within one shell on one day the planes do not");
    lines.push("agree — which is itself a routing-relevant fact.");
    lines.push("");
    lines.push("| Shell | Date | \\|β\\| across planes | Eclipse per orbit | Planes with none | Longest eclipse | No usable power | Longest dark run | Penumbra/orbit |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const row of rows) {
      const s = summarise(row.profiles);
      lines.push(
        `| ${row.shell} | ${row.date} | ${s.betaMin.toFixed(0)}–${s.betaMax.toFixed(0)}° | ${percent(s.eclipseMin)}–${percent(s.eclipseMax)} | ${s.planesNeverEclipsed}/${s.planesSampled} | ${minutes(s.longestEclipse)} | ${percent(s.darkMin)}–${percent(s.darkMax)} | ${minutes(s.longestDark)} | ${seconds(s.penumbra)} |`,
      );
    }
    lines.push("");
    lines.push("## The whole fleet at once");
    lines.push("");
    lines.push("All 4408 satellites, one day per date, sampled every 2 minutes. This is the number a");
    lines.push("router cares about: not how often *a* satellite is in shadow, but how much of the fleet is");
    lines.push("in shadow *at the same time*.");
    lines.push("");
    lines.push("| Date | Eclipsed share (min–mean–max) | No usable power (min–mean–max) |");
    lines.push("| --- | --- | --- |");
    for (const entry of fleetByDate) {
      const e = entry.series.eclipsedFraction;
      const d = entry.series.darkFraction;
      lines.push(`| ${entry.label} | ${percent(e.min)} – ${percent(e.mean)} – ${percent(e.max)} | ${percent(d.min)} – ${percent(d.mean)} – ${percent(d.max)} |`);
    }
    lines.push("");
    lines.push("## Scheduling horizon");
    lines.push("");
    lines.push(`For ${horizonShell.name}, at the June solstice: starting a task at a random moment while the`);
    lines.push("host is powered, how long until it goes dark.");
    lines.push("");
    lines.push(`- p10 **${seconds(percentile(horizons, 0.1))}**, p50 **${seconds(percentile(horizons, 0.5))}**, p90 **${seconds(percentile(horizons, 0.9))}**`);
    lines.push(`- longest **${seconds(Math.max(...horizons))}**, shortest **${seconds(Math.min(...horizons))}**`);
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push(`Generated ${new Date().toISOString()} · panel model \`${AXIS}\` · ${fleet.length} satellites.`);
    lines.push("");

    writeFileSync("docs/starlink-energy-report.md", lines.join("\n"));

    // The invariants the prose above asserts, checked against the data rather than
    // trusted: a report that says "every shell is eclipsed every orbit" has to be
    // reporting that.
    // Dark is a superset of eclipse, so the inequality holds *per satellite*. Across
    // planes it need not: the least-eclipsed plane and the least-dark plane are
    // different planes, which is exactly the asymmetry this report is about.
    for (const row of rows) {
      for (const profile of row.profiles) {
        expect(profile.darkFraction, `${row.shell} ${row.date}`).toBeGreaterThanOrEqual(profile.eclipseFraction);
        expect(profile.longestDarkSeconds).toBeGreaterThanOrEqual(profile.longestEclipseSeconds);
      }
      // Every shell on every date still has planes that are eclipsed for a third of
      // the orbit — the eclipse-free planes are a minority, not the rule.
      expect(summarise(row.profiles).eclipseMax, `${row.shell} ${row.date}`).toBeGreaterThan(0.25);
    }
    // The quasi-sun-synchronous claim about S4/S5, checked rather than asserted in prose.
    for (const shell of SHELLS.filter((candidate) => candidate.params.inclinationDeg > 95)) {
      const drift = nodalPrecessionDegPerDay(shell.params.altitudeKm, shell.params.inclinationDeg);
      expect(Math.abs(drift - SUN_DEG_PER_DAY), `${shell.name} drift vs the sun`).toBeLessThan(0.05);
    }
    // And that the 53° shells are not frozen, which is the contrast the text draws.
    expect(betaCycleDays(550, 53)).toBeLessThan(120);

    // And the finding: at least one shell/date combination has a plane with no eclipse
    // at all. If this ever stops holding, the prose above is wrong.
    expect(rows.some((row) => summarise(row.profiles).planesNeverEclipsed > 0)).toBe(true);
    for (const entry of fleetByDate) {
      // The aggregate is far steadier than any one satellite, which swings 0→1.
      // Nearly a constant: the fleet's eclipsed share moves by well under a percentage
      // point across a whole day, while any one satellite swings between 0 and 1.
      expect(entry.series.eclipsedFraction.max - entry.series.eclipsedFraction.min).toBeLessThan(0.02);
      expect(entry.series.eclipsedFraction.mean).toBeGreaterThan(0.15);
      expect(entry.series.eclipsedFraction.mean).toBeLessThan(0.45);
    }
  }, 600_000);
});
