<!-- The orbit lab: generate a Walker pattern, and read what the sun is doing to
     it.

     One panel for two things because they are one workflow — a synthetic
     constellation exists to be analysed, and the analysis needs something with a
     known geometry to be checked against. Both halves also work alone: the
     illumination half colours the real catalog, and the generator half is just a
     constellation. -->
<template>
  <div class="orbitLab">
    <div class="toolbarTitle">Walker constellation</div>
    <p class="orbitLab__note">
      Walker notation <code>i: T/P/F</code> — T satellites in P planes, each plane offset along-track from the last by F·360°/T. Generated as circular element sets at a fixed
      epoch, so this is the pattern's geometry, not a forecast of any real constellation.
    </p>

    <div class="orbitLab__radios">
      <label v-for="mode in CAMERA_MODES" :key="mode" class="toolbarSwitch">
        <input type="radio" name="orbitLabCameraMode" :value="mode" :checked="cameraMode === mode" @change="cameraMode = mode" />
        <span class="slider"></span>
        {{ CAMERA_MODE_LABEL[mode] }}
      </label>
    </div>
    <p class="orbitLab__note">
      An orbit plane is fixed in <em>inertial</em> space, not in the rotating Earth's — once launched it does not follow the ground round. So in the <strong>Inertial</strong> frame
      the orbit holds still and the Earth turns underneath it, which is what actually happens; in <strong>Earth-fixed</strong> the ground holds still and the same stationary orbit
      appears to sweep past. Every demo below opens in the inertial frame.
    </p>

    <button type="button" class="orbitLab__button orbitLab__button--wide" @click="twoOrbitDemo">Two-orbit demo</button>
    <p class="orbitLab__note">
      One click: two orbital planes 90° apart with ten satellites each, orbit lines coloured by illumination, points coloured to match and enlarged, and the clock at
      {{ DEMO_MULTIPLIER }}× so an orbit takes about {{ demoOrbitSeconds }} s. Watch a point cross from the sunlit arc into the eclipsed one and change colour as it goes.
    </p>
    <p class="orbitLab__note">
      Penumbra is a sliver either way: a satellite crosses it in 10–20 s of a ~96 minute orbit, so on the arc it is a short blue tick at each eclipse boundary rather than a band.
    </p>
    <p class="orbitLab__note">
      The <code>Illumination arc</code> component is in the satellite-components menu. It stands in for the plain <code>Orbit</code> while it is on — the two are the same ellipse,
      so drawing both would z-fight.
    </p>

    <button type="button" class="orbitLab__button orbitLab__button--wide" @click="sunSyncDemo">Always-sunlit SSO demo</button>
    <p class="orbitLab__note">
      Two sun-synchronous orbits at <strong>{{ alwaysSunlitAltitude }} km</strong>, differing only in how their plane faces the sun: the dawn–dusk one never enters the Earth's
      shadow, the noon–midnight one is eclipsed for a third of every orbit. Same altitude, same inclination — a quarter turn of the plane apart.
    </p>

    <button type="button" class="orbitLab__button orbitLab__button--wide" @click="shellsDemo">Stacked-shells demo</button>
    <p class="orbitLab__note">
      Three Walker shells at once — 4 planes of 10 at <strong>53° / 550 km</strong>, 4 planes of 6 at <strong>70° / 1200 km</strong> and <strong>97.6° / 1200 km</strong> — with the
      clock at {{ SHELLS_MULTIPLIER }}×. Each shell is rigid inside itself; what moves is shell against shell. The 550 km one laps the two higher shells (a full relative revolution
      about every 76 s at this speed), while the two same-period high shells hold their along-track lock and drift apart in node instead, their crossing seam creeping a couple of
      degrees of RAAN per simulated day.
    </p>

    <label class="toolbarSwitch">
      <input type="checkbox" :checked="links" @change="links = ($event.target as HTMLInputElement).checked" />
      <span class="slider"></span>
      Show constellation links
    </label>
    <p class="orbitLab__note">
      Wires every generated Walker satellite into the topology the derivation script picked: <span style="color: #34d399">green ring links</span> inside each plane hold their
      length to within a part in a thousand, <span style="color: #a78bfa">violet inter-plane links</span> breathe as their planes cross, a link that passes behind the Earth is
      hidden rather than drawn through it, and the Walker Star seam is never wired — its endpoints sweep past each other at twice orbital rate.
    </p>

    <div class="toolbarTitle">Marked cluster</div>
    <button type="button" class="orbitLab__button orbitLab__button--wide" :disabled="!walkerActive" @click="markColumn">Mark one column</button>
    <button type="button" class="orbitLab__button orbitLab__button--wide" :disabled="!walkerActive" @click="markCrossShell">Mark one per shell</button>
    <button type="button" class="orbitLab__button orbitLab__button--wide" :disabled="!marks.length" @click="clearMarks">Clear marks</button>
    <p class="orbitLab__note">
      Marks a small fleet to watch as a unit: each member carries an <span style="color: #fbbf24">amber halo</span> and its slot label, and every pair is bonded in amber — across
      planes and across shells, rules aside, because the point of a marked cluster is to test stability by eye. <strong>Mark one column</strong> picks the same slot in every plane
      of the first pattern: the bonds hold their geometry (along-track offsets are exact) and the cluster flies as a rigid ladder. <strong>Mark one per shell</strong> spans the
      shells: same period holds, different period shears, and the bonds show which is which. The line style is the stability verdict, read straight off the picture: a
      <strong>solid</strong> bond joins members sharing a period, so the pair never parts and its distance envelope repeats every orbit; a <strong>dashed</strong> bond joins
      members whose periods differ, and it drifts through its synodic cycle without ever settling.
    </p>

    <div class="toolbarTitle">KV-cache live migration</div>
    <button type="button" class="orbitLab__button orbitLab__button--wide" @click="migrationDemo">KV-cache migration demo</button>
    <button type="button" class="orbitLab__button orbitLab__button--wide" @click="walker25Demo">25x4 fleet migration demo</button>
    <label class="toolbarSwitch">
      <input type="checkbox" :checked="migration" @change="migration = ($event.target as HTMLInputElement).checked" />
      <span class="slider"></span>
      Show migration overlay
    </label>
    <label class="orbitLab__field">
      <span>Pipeline stages</span>
      <select class="orbitLab__stages" :value="migrationStages" @change="migrationStages = Number(($event.target as HTMLSelectElement).value)">
        <option v-for="count in PIPELINE_STAGE_CHOICES" :key="count" :value="count">{{ count }}</option>
      </select>
    </label>
    <p class="orbitLab__note">
      An inference pipeline is cut into {{ migrationStatus?.stageCount ?? migrationStages }} stages, each holding its own {{ migrationStatus?.kvGigabytes ?? 2 }} GB KV cache on its
      own satellite — one stage per satellite, drawn as a haloed dot in the stage's colour. The moment a host loses power — it enters the Earth's shadow, or its panel turns away
      from the sun (<code>sunlit_back</code>) — that stage's cache is live-migrated over one {{ migrationStatus?.islGbps ?? 100 }} Gbps inter-satellite link to the nearest
      satellite that still has power and is not already running a stage. Naive: one link, one hop, no overlap, no incremental patching — the baseline LAB-47 improves on.
    </p>
    <p class="orbitLab__note">
      The pipeline only produces tokens while <strong>every</strong> stage has power at the same instant, so its ceiling falls well below any single satellite's lit fraction — that
      conjunction, not one satellite's eclipse, is what the naive policy costs. <strong>All stages powered</strong> below is that ceiling, measured over simulated time; the
      migrations' own cost is the link time beside it.
    </p>
    <p class="orbitLab__note">
      The travelling dot is illustrative — it crosses the link in {{ MIGRATION_ANIMATION_SIM_SECONDS }} <strong>simulated</strong> seconds, so it rides the clock below: wind the
      multiplier up and migrations finish sooner, pause and the packet stops mid-link. That duration is an animation, not the transfer. The <strong>transfer time</strong> is the
      real cost: {{ migrationStatus?.kvGigabytes ?? 2 }} GB serialised across the link plus one-way light travel, some two orders of magnitude quicker than the dot. Elapsed times
      are <strong>simulated</strong> seconds, not wall clock, so they describe the orbit rather than the playback rate.
    </p>

    <table v-if="migrationStatus?.active && migrationStatus.stages.length > 0" class="orbitLab__facts">
      <tbody>
        <tr v-for="stage in migrationStatus.stages" :key="stage.index">
          <td class="orbitLab__factName">
            <span class="orbitLab__swatch" :style="{ backgroundColor: stage.color }"></span>
            S{{ stage.index + 1 }}
          </td>
          <td class="orbitLab__factValue">
            <template v-if="stage.phase === 'migrating'"
              >{{ shortHost(stage.from) }} → {{ shortHost(stage.to) }} ({{ ((stage.transferSeconds ?? 0) * 1000).toFixed(0) }} ms)</template
            >
            <template v-else-if="stage.phase === 'stranded'">{{ shortHost(stage.hostName) }} · stranded</template>
            <template v-else>{{ shortHost(stage.hostName) }}{{ stage.powered ? "" : " · dark" }}</template>
          </td>
        </tr>
      </tbody>
    </table>

    <table v-if="migrationStatus?.active" class="orbitLab__facts">
      <tbody>
        <tr>
          <td class="orbitLab__factName">Pipeline</td>
          <td class="orbitLab__factValue">
            {{ migrationStatus.serving ? "serving" : "stalled" }} · {{ migrationStatus.poweredStages }}/{{ migrationStatus.stages.length }} stages powered
          </td>
        </tr>
        <tr v-if="migrationStatus.allPoweredFraction !== undefined">
          <td class="orbitLab__factName">All stages powered</td>
          <td class="orbitLab__factValue">
            {{ pct(migrationStatus.allPoweredFraction) }} of {{ simDuration(migrationStatus.ledger.allPoweredSeconds + migrationStatus.ledger.stalledSeconds) }}
          </td>
        </tr>
        <tr>
          <td class="orbitLab__factName">Migrations</td>
          <td class="orbitLab__factValue">{{ migrationStatus.migrations }}</td>
        </tr>
        <tr v-if="migrationStatus.ledger.migrations > 0">
          <td class="orbitLab__factName">KV moved</td>
          <td class="orbitLab__factValue">
            {{ migrationStatus.ledger.gigabytesMoved.toFixed(0) }} GB in {{ (migrationStatus.ledger.transferSeconds * 1000).toFixed(0) }} ms of link time
          </td>
        </tr>
        <tr v-if="migrationStatus.linkKm !== undefined">
          <td class="orbitLab__factName">ISL in flight</td>
          <td class="orbitLab__factValue">{{ migrationStatus.linkKm.toFixed(0) }} km</td>
        </tr>
      </tbody>
    </table>
    <p v-if="migrationStatus?.active" class="orbitLab__note">{{ migrationStatus.reason }}</p>

    <template v-if="migrationStatus?.active && migrationStatus.log.length > 0">
      <div class="toolbarTitle">Migration log</div>
      <table class="orbitLab__facts">
        <tbody>
          <tr v-for="(event, index) in migrationStatus.log" :key="`${event.at}-${event.stage}-${index}`">
            <td class="orbitLab__factName">{{ clockOf(event.at) }}</td>
            <td class="orbitLab__factValue">
              <span class="orbitLab__swatch" :style="{ backgroundColor: stageColor(event.stage) }"></span>
              S{{ event.stage + 1 }} {{ shortHost(event.from) }} → {{ shortHost(event.to) }} · {{ event.linkKm.toFixed(0) }} km · {{ (event.transferSeconds * 1000).toFixed(0) }} ms
            </td>
          </tr>
        </tbody>
      </table>
      <p class="orbitLab__note">Newest first, at the simulated time the migration was decided.</p>
    </template>

    <label class="orbitLab__field">
      <span>Preset</span>
      <select class="orbitLab__preset" :value="presetIndex" @change="applyPreset(Number(($event.target as HTMLSelectElement).value))">
        <option :value="-1">Custom</option>
        <option v-for="(preset, index) in WALKER_PRESETS" :key="preset.label" :value="index">{{ preset.label }}</option>
      </select>
    </label>
    <p v-if="presetNote" class="orbitLab__note">{{ presetNote }}</p>

    <div class="orbitLab__grid">
      <label class="orbitLab__field">
        <span>Total (T)</span>
        <input v-model.number="draft.total" type="number" min="1" :max="MAX_WALKER_SATELLITES" step="1" />
      </label>
      <label class="orbitLab__field">
        <span>Planes (P)</span>
        <input v-model.number="draft.planes" type="number" min="1" step="1" />
      </label>
      <label class="orbitLab__field">
        <span>Phasing (F)</span>
        <input v-model.number="draft.phasing" type="number" min="0" step="1" />
      </label>
      <label class="orbitLab__field">
        <span>Inclination °</span>
        <input v-model.number="draft.inclinationDeg" type="number" min="0" max="180" step="0.1" />
      </label>
      <label class="orbitLab__field">
        <span>Altitude km</span>
        <input v-model.number="draft.altitudeKm" type="number" min="150" step="10" />
      </label>
      <label class="orbitLab__field">
        <span>RAAN span °</span>
        <input v-model.number="draft.raanSpanDeg" type="number" min="1" max="360" step="1" />
      </label>
    </div>

    <p class="orbitLab__derived">
      {{ perPlane }} per plane · {{ periodMinutes }} min period · {{ meanMotion }} rev/day
      <template v-if="draft.raanSpanDeg === 180"> · Walker Star (planes over 180°)</template>
    </p>
    <p v-if="validation.error" class="orbitLab__error">{{ validation.error }}</p>

    <div class="orbitLab__actions">
      <button type="button" class="orbitLab__button" :disabled="!validation.ok" :title="`Draw only ${wire}`" @click="generate">
        {{ patterns.length === 1 && patterns[0] === wire ? "Regenerate" : "Show only" }}
      </button>
      <button type="button" class="orbitLab__button" :disabled="!validation.ok || patterns.includes(wire)" :title="`Draw ${wire} beside the others`" @click="addPattern">
        Add
      </button>
      <button type="button" class="orbitLab__button" :disabled="!walkerActive" @click="clear">Hide all</button>
    </div>

    <template v-if="patterns.length > 0">
      <div class="toolbarTitle">Generated patterns</div>
      <ul class="orbitLab__patterns">
        <li v-for="pattern in patterns" :key="pattern">
          <button
            type="button"
            class="orbitLab__patternName"
            :class="{ 'orbitLab__patternName--off': !isShown(pattern) }"
            :title="isShown(pattern) ? 'Stop drawing this pattern' : 'Draw this pattern'"
            @click="toggleShown(pattern)"
          >
            <code>{{ pattern }}</code>
          </button>
          <button type="button" class="orbitLab__patternDrop" title="Load these numbers into the form" @click="loadIntoForm(pattern)">edit</button>
          <button type="button" class="orbitLab__patternDrop" title="Forget this pattern" @click="dropPattern(pattern)">×</button>
        </li>
      </ul>
      <p class="orbitLab__note">
        All of them travel in the url, so this link is the whole scene:
        <code>?walker={{ patterns.join(",") }}</code>
      </p>
    </template>

    <div class="toolbarTitle">Sun-synchronous</div>
    <p class="orbitLab__note">
      Computed from the altitude above, by inverting the J₂ nodal precession Ω̇ = −(3/2)·J₂·n·(Rₑ/a)²·cos i for the sun's own 0.9856°/day. Secular two-body, in the same WGS-72
      system the element sets use — within about 0.1° of the published inclinations.
    </p>
    <table class="orbitLab__facts">
      <tbody>
        <tr title="The best |β| any plane at this inclination can reach, at the best moment of the year, against what the shadow demands here">
          <td class="orbitLab__factName">Reachable β vs demanded</td>
          <td class="orbitLab__factValue">{{ reachableVsDemanded }}</td>
        </tr>
        <tr title="Share of this shell's planes that clear the Earth's shadow entirely, averaged over a year. Depends on altitude and inclination alone.">
          <td class="orbitLab__factName">Planes never eclipsed</td>
          <td class="orbitLab__factValue">{{ eclipseFreePlanes }}</td>
        </tr>
        <tr title="How much altitude buys the same β margin as one degree of inclination, at this altitude">
          <td class="orbitLab__factName">1° inclination is worth</td>
          <td class="orbitLab__factValue">{{ exchangeRate }}</td>
        </tr>
        <tr title='How fast the J₂ bulge turns this orbit&apos;s node — the rate by which "fixed" is only nearly true'>
          <td class="orbitLab__factName">Node drift, this orbit</td>
          <td class="orbitLab__factValue">{{ nodeDrift }}</td>
        </tr>
        <tr title="The inclination that makes this altitude sun-synchronous">
          <td class="orbitLab__factName">Sun-sync inclination</td>
          <td class="orbitLab__factValue">{{ ssoInclination }}</td>
        </tr>
        <tr title="Sun elevation above the orbit plane at the worst moment of the year, for a dawn–dusk plane">
          <td class="orbitLab__factName">Worst β (dawn–dusk)</td>
          <td class="orbitLab__factValue">{{ ssoWorstBeta }}</td>
        </tr>
        <tr title="What |β| must clear for the orbit to miss the Earth's shadow: arcsin(Rₑ/(Rₑ+h)), plus a degree for the penumbra">
          <td class="orbitLab__factName">β needed to stay lit</td>
          <td class="orbitLab__factValue">{{ ssoRequiredBeta }}</td>
        </tr>
        <tr :title="ssoVerdictNote">
          <td class="orbitLab__factName">Always sunlit?</td>
          <td class="orbitLab__factValue">{{ ssoVerdict }}</td>
        </tr>
      </tbody>
    </table>
    <p class="orbitLab__note">
      The three knobs, weakest last: <strong>where the node sits relative to the sun</strong> picks β within the range the inclination allows, and is free —
      <strong>inclination</strong> raises that ceiling one-for-one — <strong>altitude</strong> only lowers what the shadow demands, at about 0.02°/km. Full sweep in
      <code>docs/starlink-energy-report.md</code>.
    </p>
    <p class="orbitLab__note">
      Fixed, but not exactly: the Earth's J₂ bulge turns every orbit's node a few degrees a day — −5°/day for the ISS, and precisely +0.9856°/day for a sun-synchronous orbit, which
      is the whole trick those orbits are built on.
    </p>
    <p class="orbitLab__note">
      Always-sunlit dawn–dusk orbits exist only between <strong>{{ sunlitBand }}</strong> — a band, not a floor: the shadow shrinks with altitude, but sun-synchrony demands an ever
      steeper retrograde inclination, which caps β. Above the band the second effect wins. Every flown dawn–dusk mission (Sentinel-1 at 693 km, TerraSAR-X at 514 km) sits below it
      and is eclipse-free for part of the year only.
    </p>
    <button type="button" class="orbitLab__button orbitLab__button--wide" :disabled="!validation.ok" @click="useSunSyncInclination">Use this inclination for the form</button>

    <div class="toolbarTitle">Illumination</div>
    <p class="orbitLab__note">
      ν is the fraction of the solar disc left uncovered by the Earth (satellite.js's conical shadow model). κ is the signed cosine between the sun and an assumed solar panel
      normal — a model, not a fact: no element set carries attitude.
    </p>

    <div class="orbitLab__radios">
      <label v-for="mode in POINT_COLOR_MODES" :key="mode" class="toolbarSwitch">
        <input type="radio" name="pointColorMode" :value="mode" :checked="pointColorMode === mode" @change="pointColorMode = mode" />
        <span class="slider"></span>
        {{ POINT_COLOR_MODE_LABEL[mode] }}
      </label>
    </div>

    <label class="orbitLab__field">
      <span>Point size</span>
      <select :value="pointSize" @change="pointSize = ($event.target as HTMLSelectElement).value as PointSize">
        <option v-for="size in POINT_SIZES" :key="size" :value="size">{{ POINT_SIZE_LABEL[size] }}</option>
      </select>
    </label>

    <label class="orbitLab__field">
      <span>Panel normal</span>
      <select :value="panelAxis" @change="panelAxis = ($event.target as HTMLSelectElement).value as PanelAxis">
        <option v-for="axis in PANEL_AXES" :key="axis" :value="axis">{{ PANEL_AXIS_LABEL[axis] }}</option>
      </select>
    </label>

    <table class="orbitLab__legend">
      <tbody>
        <tr v-for="state in ILLUMINATION_STATES" :key="state" :title="ILLUMINATION_DESCRIPTION[state]">
          <td><span class="orbitLab__swatch" :style="{ backgroundColor: ILLUMINATION_COLOR[state] }"></span></td>
          <td class="orbitLab__legendName">{{ state }}</td>
          <td class="orbitLab__legendCount">{{ census.counts[state] ?? 0 }}</td>
          <td class="orbitLab__legendShare">{{ share(census.counts[state] ?? 0) }}</td>
        </tr>
      </tbody>
    </table>
    <p class="orbitLab__derived">
      {{ census.total }} satellites on screen<template v-if="census.total > 0"> · {{ share(census.dark) }} without usable power</template>
    </p>
    <p v-if="pointColorMode === 'class'" class="orbitLab__note">Switch the colouring to Illumination to paint these states onto the globe.</p>

    <template v-if="selected">
      <div class="toolbarTitle">{{ selected.name }}</div>
      <p class="orbitLab__derived">
        <span class="orbitLab__swatch" :style="{ backgroundColor: ILLUMINATION_COLOR[selected.state] }"></span>
        {{ selected.state }} · ν {{ selected.nu.toFixed(3) }} · κ {{ selected.kappa.toFixed(3) }} · β {{ selected.betaDeg.toFixed(1) }}°
      </p>
      <div v-if="selected.strip.length > 0" class="orbitLab__strip" :title="`${STRIP_ORBITS} orbits from now (${selected.spanMinutes} min), ${STRIP_STEP_SECONDS} s per sample`">
        <span v-for="(segment, index) in selected.strip" :key="index" :style="{ backgroundColor: segment.color, flexGrow: segment.weight }"></span>
      </div>
      <p v-if="selected.strip.length > 0" class="orbitLab__note">
        Next {{ STRIP_ORBITS }} orbits ({{ selected.spanMinutes }} min): {{ pct(selected.fractions.umbra ?? 0) }} umbra · {{ pct(selected.fractions.penumbra ?? 0) }} penumbra ·
        {{ pct(selected.fractions.sunlit_back ?? 0) }} back-facing · {{ pct(selected.darkFraction) }} dark in total
      </p>
    </template>
    <p v-else class="orbitLab__note">Click a satellite to read its ν/κ and its next orbit.</p>
  </div>
</template>

<script setup lang="ts">
import { JulianDate } from "@cesium/engine";
import { storeToRefs } from "pinia";
import { computed, onUnmounted, reactive, ref, watch } from "vue";

import { useController } from "../composables/useController";
import { useViewerClock } from "../composables/useViewerClock";
import { POINT_SIZE_LABEL, POINT_SIZES, type PointSize } from "../config/components";
import {
  ILLUMINATION_COLOR,
  ILLUMINATION_DESCRIPTION,
  ILLUMINATION_STATES,
  PANEL_AXES,
  PANEL_AXIS_LABEL,
  POINT_COLOR_MODE_LABEL,
  POINT_COLOR_MODES,
  type IlluminationState,
  type PanelAxis,
} from "../config/illumination";
import { MIGRATION_ANIMATION_SIM_SECONDS, PIPELINE_STAGE_CHOICES, stageColor } from "../config/migration";
import { CAMERA_MODES } from "../config/viewModes";
import {
  applyMigrationScene,
  applyShellsScene,
  applySunSyncScene,
  applyTwoOrbitScene,
  applyWalker25Scene,
  type ClockControl,
  DEMO_MULTIPLIER,
  SHELLS_MULTIPLIER,
} from "../modules/demoScenes";
import { illuminationTimeline } from "../modules/util/illumination";
import { annualEclipseFreePlaneFraction, betaExchangeRateKmPerDegree, maxReachableBetaDeg } from "../modules/util/orbitDesign";
import {
  alwaysSunlitAltitudeBandKm,
  alwaysSunlitVerdict,
  nodalPrecessionDegPerDay,
  representativeAlwaysSunlitAltitudeKm,
  sunSyncWalkerParams,
} from "../modules/util/sunSynchronous";
import {
  decodeWalker,
  encodeWalker,
  MAX_WALKER_SATELLITES,
  meanMotionRevPerDay,
  planeSlotOf,
  satsPerPlane,
  isWalkerTag,
  validateWalkerDelta,
  WALKER_PRESETS,
  WALKER_EPOCH_ISO,
  walkerTagFor,
  type WalkerDeltaParams,
} from "../modules/util/walkerDelta";
import { useCesiumStore } from "../stores/cesium";
import { useSatStore } from "../stores/sat";

/** How often the census and the selected satellite's readout are recomputed. */
const REFRESH_MS = 500;

/** Sample step for the strip, in seconds. Matches illuminationTimeline's own default reasoning. */
const STRIP_STEP_SECONDS = 10;

/**
 * How many orbits the strip covers.
 *
 * Two rather than one, because one orbit cannot show what changes between them.
 * The sun moves ~0.04° an hour and the orbit plane regresses a few degrees a day,
 * so consecutive orbits are nearly but not exactly alike — and where a satellite
 * is close to entering or leaving eclipse season, two orbits is where that first
 * shows up as two visibly different halves of the strip.
 */
const STRIP_ORBITS = 2;

const cc = useController();
const satStore = useSatStore();
const { pointColorMode, pointSize, panelAxis, walker, migration, migrationStages, links, marks } = storeToRefs(satStore);

// The clock is live viewer state rather than store state (see useViewerClock), and
// this is the seam the clock deck writes it through — so the demo writes it the same
// way rather than reaching for viewer.clock.
const clock = useViewerClock();

// The reference frame the camera is pinned to. Already a setting — it lives in the
// View menu and travels as `?camera=` — surfaced here because it is the difference
// between a picture that shows what the orbit does and one that does not.
const cesiumStore = useCesiumStore();
const { cameraMode } = storeToRefs(cesiumStore);

const CAMERA_MODE_LABEL: Record<string, string> = {
  Fixed: "Earth-fixed — ground still, orbit sweeps",
  Inertial: "Inertial — orbit still, Earth turns",
};

// The demo scenes are shared with the `?demo=` startup path (modules/demoScenes).
// The panel drives the clock through useViewerClock; the startup path drives the
// ClockViewModel directly. Both reach the scenes through this small control.
const clockControl: ClockControl = {
  setMultiplier: (value) => clock.setMultiplier(value),
  play: () => {
    if (!clock.playing.value) {
      clock.togglePlaying();
    }
  },
};

// The form's own copy: a pattern is only handed to the globe when Generate is
// pressed, so a half-typed T never becomes a constellation. Seeded from the url's
// pattern when there is one, so a shared link opens with its own numbers in the
// fields rather than the default preset's.
const draft = reactive<WalkerDeltaParams>({ ...(WALKER_PRESETS[0] as (typeof WALKER_PRESETS)[number]).params });
const initial = decodeWalker(walker.value[0] ?? "");
if (initial) {
  // The url's first pattern in the fields, so a shared link opens with its own
  // numbers rather than the default preset's.
  Object.assign(draft, initial);
}

const validation = computed(() => validateWalkerDelta(draft));
const wire = computed(() => (validation.value.ok ? encodeWalker(draft) : ""));
const perPlane = computed(() => (validation.value.ok ? satsPerPlane(draft) : 0));
const meanMotion = computed(() => meanMotionRevPerDay(draft.altitudeKm).toFixed(2));
const periodMinutes = computed(() => (1440 / meanMotionRevPerDay(draft.altitudeKm)).toFixed(1));

/** Every pattern generated this session, in the order they were added. */
const patterns = computed(() => walker.value);
const walkerActive = computed(() => satStore.enabledTags.some((tag) => isWalkerTag(tag)));

/** Whether this pattern's tag is currently switched on. */
function isShown(pattern: string): boolean {
  const params = decodeWalker(pattern);
  return params !== undefined && satStore.enabledTags.includes(walkerTagFor(params));
}

function tagsWithout(pattern: string): string[] {
  const params = decodeWalker(pattern);
  const tag = params && walkerTagFor(params);
  return satStore.enabledTags.filter((existing) => existing !== tag);
}

/** Draw or stop drawing one pattern, leaving the others as they are. */
function toggleShown(pattern: string): void {
  const params = decodeWalker(pattern);
  if (!params) {
    return;
  }
  const kept = tagsWithout(pattern);
  satStore.setActivation({ enabledTags: isShown(pattern) ? kept : [...kept, walkerTagFor(params)] });
}

/** Put a pattern's numbers back in the form, so it can be edited into another one. */
function loadIntoForm(pattern: string): void {
  const params = decodeWalker(pattern);
  if (params) {
    Object.assign(draft, params);
  }
}

/**
 * Forget a pattern: out of the list, out of the url, off the globe.
 *
 * Its records stay in the catalog — the catalog has no removal and nothing else
 * needs one — but with the tag gone and the pattern out of the url, nothing draws
 * them and a reload does not bring them back.
 */
function dropPattern(pattern: string): void {
  satStore.setActivation({ enabledTags: tagsWithout(pattern) });
  walker.value = walker.value.filter((existing) => existing !== pattern);
}

const demoOrbitSeconds = computed(() =>
  Math.round(((1440 / meanMotionRevPerDay((WALKER_PRESETS[0] as (typeof WALKER_PRESETS)[number]).params.altitudeKm)) * 60) / DEMO_MULTIPLIER),
);

// Everything the Sun-synchronous block reports, recomputed as the altitude field is
// typed. Cheap: an arcsin and an inverse cosine.
const ssoFacts = computed(() => alwaysSunlitVerdict(draft.altitudeKm));
// The design numbers, recomputed as the form is typed — this is the "can I tune it to
// suit me" question, and the answer is two closed-form angles and a comparison.
const reachableVsDemanded = computed(() => {
  const reachable = maxReachableBetaDeg(draft.inclinationDeg);
  // ssoFacts carries the margin; the geometric demand is the figure to compare against.
  const demanded = ssoFacts.value.requiredBetaDeg - 1;
  return `${reachable.toFixed(1)}° vs ${demanded.toFixed(1)}°${reachable >= demanded ? " ✓" : ""}`;
});
const eclipseFreePlanes = computed(() => {
  const fraction = annualEclipseFreePlaneFraction(draft.altitudeKm, draft.inclinationDeg);
  return fraction === 0 ? "none, ever" : `${(fraction * 100).toFixed(1)}% of the year`;
});
const exchangeRate = computed(() => `${betaExchangeRateKmPerDegree(draft.altitudeKm).toFixed(0)} km of altitude`);

const nodeDrift = computed(() => {
  const rate = nodalPrecessionDegPerDay(draft.altitudeKm, draft.inclinationDeg);
  return Number.isFinite(rate) ? `${rate >= 0 ? "+" : ""}${rate.toFixed(3)}°/day` : "—";
});
const ssoInclination = computed(() => (ssoFacts.value.inclinationDeg === undefined ? "none" : `${ssoFacts.value.inclinationDeg.toFixed(2)}°`));
const ssoWorstBeta = computed(() => (Number.isFinite(ssoFacts.value.worstBetaDeg) ? `${ssoFacts.value.worstBetaDeg.toFixed(1)}°` : "—"));
const ssoRequiredBeta = computed(() => `${ssoFacts.value.requiredBetaDeg.toFixed(1)}°`);
const ssoVerdict = computed(() => (ssoFacts.value.alwaysSunlit ? "yes" : "no"));
const ssoVerdictNote = computed(() =>
  ssoFacts.value.inclinationDeg === undefined
    ? "No inclination makes this altitude sun-synchronous."
    : ssoFacts.value.alwaysSunlit
      ? "A dawn–dusk plane at this altitude clears the shadow all year."
      : "A dawn–dusk plane at this altitude is eclipsed for part of the year.",
);

// The band and the altitude the demo uses. Constant for the session, so computed once
// rather than per keystroke.
const band = alwaysSunlitAltitudeBandKm();
const sunlitBand = band ? `${band.lowestKm} and ${band.highestKm} km` : "no altitude";
const alwaysSunlitAltitude = representativeAlwaysSunlitAltitudeKm() ?? 1760;

const presetIndex = computed(() => WALKER_PRESETS.findIndex((preset) => encodeWalker(preset.params) === wire.value));
const presetNote = computed(() => WALKER_PRESETS[presetIndex.value]?.note ?? "");

function applyPreset(index: number): void {
  const preset = WALKER_PRESETS[index];
  if (preset) {
    Object.assign(draft, preset.params);
  }
}

/**
 * Hand the pattern to the globe and switch its tag on, dropping any other
 * pattern's.
 *
 * Two writes rather than one, and both to the store: the pattern is what
 * sceneSync expands into element sets, and the tag is what activates them. A
 * generated constellation nobody asked to see would be a catalog entry and no
 * more, which is not what pressing Generate means.
 *
 * Replacing rather than adding, because Generate means "show me this pattern" —
 * the previous one is still in the catalog and still in the browser's group list,
 * so keeping both on screen stays one click away.
 */
function generate(): void {
  if (!validation.value.ok) {
    return;
  }
  walker.value = [wire.value];
  const kept = satStore.enabledTags.filter((tag) => !isWalkerTag(tag));
  satStore.setActivation({ enabledTags: [...kept, walkerTagFor(draft)] });
}

/**
 * The same, keeping what is already there.
 *
 * The reason both buttons exist: comparing two shells is the question this panel is
 * for, and before this the second Generate silently dropped the first pattern out of
 * the url — so the comparison survived until the page was reloaded and no further.
 */
function addPattern(): void {
  if (!validation.value.ok || walker.value.includes(wire.value)) {
    return;
  }
  walker.value = [...walker.value, wire.value];
  satStore.setActivation({ enabledTags: [...satStore.enabledTags, walkerTagFor(draft)] });
}

/**
 * The whole two-orbit demo in one press.
 *
 * Four writes that only make sense together — the pattern, its tag, the components
 * that draw the arc, and the colouring that matches the points to it. Offered as
 * one button because the thing being asked for is "show me the simplest version of
 * this", and reaching it through four menus is not that. Nothing here is a mode: a
 * reader can undo any of the four afterwards.
 */
function twoOrbitDemo(): void {
  const preset = WALKER_PRESETS[0] as (typeof WALKER_PRESETS)[number];
  // Fill the form too, so the numbers on screen match the scene. The scene itself
  // is applied by the shared helper that the `?demo=` link also uses.
  Object.assign(draft, preset.params);
  applyTwoOrbitScene(satStore, cesiumStore, clockControl);
}

/**
 * The two-orbit demo, plus the naive KV-cache live-migration overlay on top.
 *
 * Builds on twoOrbitDemo rather than repeating it: the migration story needs
 * exactly the scene that demo sets up — a handful of satellites, coloured by
 * illumination, in the inertial frame, with the clock moving so a host crosses
 * into shadow while someone watches. Turning the overlay on is the one thing this
 * adds: a workload that hops to a lit neighbour each time its host goes dark.
 */
function migrationDemo(): void {
  const preset = WALKER_PRESETS[0] as (typeof WALKER_PRESETS)[number];
  Object.assign(draft, preset.params);
  applyMigrationScene(satStore, cesiumStore, clockControl);
}
function walker25Demo(): void {
  const params = { total: 100, planes: 25, phasing: 1, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 };
  Object.assign(draft, params);
  applyWalker25Scene(satStore, cesiumStore, clockControl);
}
function useSunSyncInclination(): void {
  const inclinationDeg = ssoFacts.value.inclinationDeg;
  if (inclinationDeg !== undefined) {
    draft.inclinationDeg = Number(inclinationDeg.toFixed(3));
  }
}

/**
 * The always-sunlit demo: the same orbit twice, a quarter turn of the plane apart.
 *
 * Two patterns rather than one, because "never in shadow" is only meaningful against
 * something that is. Same altitude and same inclination in both, so the only thing
 * the difference can be attributed to is where the plane faces — which is the whole
 * content of the result.
 *
 * The node is placed relative to where the sun actually is at the pattern epoch, and
 * sun-synchrony is what keeps it there afterwards.
 */
function sunSyncDemo(): void {
  const epoch = new Date(WALKER_EPOCH_ISO);
  const dawnDusk = sunSyncWalkerParams({ altitudeKm: alwaysSunlitAltitude, total: 12, plane: "dawn-dusk" }, epoch);
  if (dawnDusk) {
    // Fill the form with the dawn–dusk numbers to match; the scene is applied by
    // the shared helper.
    Object.assign(draft, dawnDusk);
  }
  applySunSyncScene(satStore, cesiumStore, clockControl, alwaysSunlitAltitude);
}

/**
 * The stacked-shells demo: three Walker shells at once, watched from the outside.
 *
 * Three patterns rather than one, because the thing being shown is *relative*
 * motion — what a difference in period does (the low shell laps the high ones) and
 * what a difference in inclination does when the period is shared (a node drift that
 * nothing in the model removes). The form keeps the first shell's numbers, since it
 * holds one pattern's worth of fields and three patterns' worth of scene.
 */
function shellsDemo(): void {
  Object.assign(draft, { total: 24, planes: 4, phasing: 1, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 });
  applyShellsScene(satStore, cesiumStore, clockControl);
}

/** Leave the records in the catalog and stop drawing them — the tag is the switch. */
function clear(): void {
  satStore.setActivation({ enabledTags: satStore.enabledTags.filter((tag) => !isWalkerTag(tag)) });
}

/**
 * Mark the same slot in every plane of the first pattern.
 *
 * The slot is the middle one, so the marked ladder sits away from the ring's
 * seam-ish slot-1 edge and the halos read as one column. The bonds between
 * column members are exactly the links the auto-topology already draws - the
 * point here is the halo making the column followable by eye.
 */
function markColumn(): void {
  const active = walker.value[0];
  const params = active ? decodeWalker(active) : undefined;
  if (!params) {
    return;
  }
  const slotsPerPlane = Math.round(params.total / params.planes);
  const slot = Math.floor(slotsPerPlane / 2) + 1;
  satStore.marks = Array.from({ length: params.planes }, (_, plane) => `${plane + 1}-${slot}@${active}`);
}

/** Mark one satellite per pattern, same slot each: the cross-shell sample. */
function markCrossShell(): void {
  satStore.marks = walker.value.map((wire) => `1-1@${wire}`);
}

function clearMarks(): void {
  satStore.marks = [];
}

interface Census {
  counts: Partial<Record<IlluminationState, number>>;
  total: number;
  dark: number;
}

const census = ref<Census>({ counts: {}, total: 0, dark: 0 });

interface SelectedReadout {
  name: string;
  state: IlluminationState;
  nu: number;
  kappa: number;
  betaDeg: number;
  /** The whole strip's span, not one period. */
  spanMinutes: string;
  strip: { color: string; weight: number }[];
  fractions: Partial<Record<IlluminationState, number>>;
  darkFraction: number;
}

const selected = ref<SelectedReadout | undefined>(undefined);

/** What the migration overlay is doing, polled with everything else. */
const migrationStatus = ref(cc.migrationStatus);

/**
 * A span of simulated time, in the largest unit that keeps it readable.
 *
 * The demo runs at 60× and the browser check winds to 4000×, so the accounted span
 * crosses from seconds to hours within a session — printing raw seconds throughout
 * would make the served fraction's denominator unreadable exactly when it gets
 * interesting.
 */
function simDuration(seconds: number): string {
  if (seconds < 90) {
    return `${seconds.toFixed(0)} s`;
  }
  if (seconds < 5400) {
    return `${(seconds / 60).toFixed(1)} min`;
  }
  return `${(seconds / 3600).toFixed(1)} h`;
}

/**
 * A satellite's name without its constellation prefix: `P02-07` rather than
 * `W53:20/2/1@550~180 P02-07`.
 *
 * The migration tables are two narrow columns in a side panel, and the generated
 * names are long enough that the plane-and-slot part — the only part that differs
 * between rows, and the only part that says which plane a stage sits in — was the
 * part being clipped off the right edge.
 *
 * Read with the same parser the globe labels use (`planeSlotOf`), so a stage's tag is
 * one string wherever it appears. The trailing-token fallback is for a real
 * catalogued satellite, which has no plane or slot to name.
 */
function shortHost(name: string | undefined): string {
  if (!name) {
    return "—";
  }
  const tag = planeSlotOf(name);
  if (tag) {
    return tag;
  }
  const lastSpace = name.lastIndexOf(" ");
  return lastSpace === -1 ? name : name.slice(lastSpace + 1);
}

/** The wall-clock time of an ISO instant, to the second — the log's left column. */
function clockOf(iso: string): string {
  return iso.slice(11, 19);
}

/**
 * Which satellite the readout is about: the selected one, else the tracked one.
 *
 * Selection first, because clicking a satellite is the more deliberate of the two
 * — tracking is what the camera is doing, and a link can arrive with it already
 * set.
 */
function subjectSatellite() {
  const sats = cc.sats.activeSatellites;
  return sats.find((sat) => sat.isSelected) ?? sats.find((sat) => sat.isTracked);
}

/**
 * Recompute both readouts.
 *
 * On a timer rather than per frame: this walks every active satellite, and a
 * census is a number someone reads rather than an animation. Half a second is
 * under the interval at which a changing count is legible and well over the cost
 * of the walk, which is one memoized lookup per satellite (see IlluminationCache)
 * plus, for the subject only, one orbit of propagation.
 */
function refresh(): void {
  const date = JulianDate.toDate(cc.viewer.clock.currentTime);
  migrationStatus.value = cc.migrationStatus;
  const axis = panelAxis.value;
  const counts: Partial<Record<IlluminationState, number>> = {};
  let total = 0;
  let dark = 0;
  for (const sat of cc.sats.activeSatellites) {
    const illumination = sat.props.illumination(date, axis);
    if (!illumination) {
      continue;
    }
    total += 1;
    counts[illumination.state] = (counts[illumination.state] ?? 0) + 1;
    if (illumination.state !== "sunlit_on" && illumination.state !== "sunlit_edge") {
      dark += 1;
    }
  }
  census.value = { counts, total, dark };

  const subject = subjectSatellite();
  if (!subject) {
    selected.value = undefined;
    return;
  }
  const now = subject.props.illumination(date, axis);
  if (!now) {
    selected.value = undefined;
    return;
  }
  const spanMinutes = subject.props.orbit.orbitalPeriod * STRIP_ORBITS;
  const timeline = illuminationTimeline(subject.props.orbit.satrec, date, spanMinutes * 60, STRIP_STEP_SECONDS, axis);
  selected.value = {
    name: subject.props.name,
    state: now.state,
    nu: now.nu,
    kappa: now.kappa,
    betaDeg: now.betaDeg,
    spanMinutes: spanMinutes.toFixed(1),
    strip: runsOf(timeline.samples.map((sample) => sample.state)),
    fractions: timeline.fractions,
    darkFraction: timeline.darkFraction,
  };
}

/**
 * Consecutive equal states collapsed into weighted segments.
 *
 * A strip of ~570 one-sample divs is 570 elements the browser lays out on every
 * refresh; an orbit only ever has a handful of state changes, so the runs are the
 * same picture at a fraction of the DOM.
 */
function runsOf(states: IlluminationState[]): { color: string; weight: number }[] {
  const runs: { color: string; weight: number }[] = [];
  for (const state of states) {
    const last = runs[runs.length - 1];
    const color = ILLUMINATION_COLOR[state];
    if (last && last.color === color) {
      last.weight += 1;
    } else {
      runs.push({ color, weight: 1 });
    }
  }
  return runs;
}

/** A census count as a percentage of what is on screen. */
function share(count: number): string {
  const total = census.value.total;
  return total === 0 ? "0%" : `${((count / total) * 100).toFixed(0)}%`;
}

/** An already-normalized fraction as a percentage. */
function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

const timer = window.setInterval(refresh, REFRESH_MS);
refresh();
onUnmounted(() => window.clearInterval(timer));

// The axis is the one input the memoized readouts cannot notice on their own
// between ticks, so a change to it is answered immediately rather than at the next
// interval.
watch(panelAxis, () => refresh());
</script>

<style scoped>
.orbitLab {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.orbitLab__note {
  margin: 0;
  font-size: 11px;
  line-height: 1.35;
  opacity: 0.7;
}

.orbitLab__derived {
  margin: 0;
  font-size: 11px;
  opacity: 0.9;
}

.orbitLab__error {
  margin: 0;
  font-size: 11px;
  color: #d55e00;
}

.orbitLab__grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px 8px;
}

.orbitLab__field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: 12px;
}

.orbitLab__field input,
.orbitLab__field select {
  width: 88px;
  min-width: 0;
  padding: 1px 3px;
  color: inherit;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 3px;
}

.orbitLab__field select {
  width: 128px;
}

.orbitLab__actions {
  display: flex;
  gap: 6px;
}

.orbitLab__button {
  flex: 1;
  padding: 2px 6px;
  font-size: 12px;
  color: inherit;
  background: rgba(255, 255, 255, 0.12);
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 3px;
  cursor: pointer;
}

.orbitLab__button--wide {
  width: 100%;
}

.orbitLab__button:disabled {
  cursor: default;
  opacity: 0.4;
}

.orbitLab__radios {
  display: flex;
  flex-direction: column;
}

.orbitLab__patterns {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.orbitLab__patterns li {
  display: flex;
  align-items: center;
  gap: 4px;
}

/* The name is the switch: clicking it draws or stops drawing that pattern, which is
   the same thing its tag's checkbox in the satellite browser does. Dimmed when off,
   because a pattern that is listed and not drawn has to look different from one that
   is not listed at all. */
.orbitLab__patternName {
  flex: 1;
  overflow: hidden;
  padding: 1px 3px;
  color: inherit;
  font-size: 11px;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 3px;
  cursor: pointer;
}

.orbitLab__patternName--off {
  opacity: 0.45;
}

.orbitLab__patternDrop {
  padding: 1px 5px;
  color: inherit;
  font-size: 11px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 3px;
  cursor: pointer;
}

/* The sun-synchronous readout: two columns of computed numbers. Its own class rather
   than the legend's, because a legend maps a colour to a name and this maps a name to
   a value — and because sharing the class made every query for "the legend" match
   both. */
.orbitLab__facts {
  width: 100%;
  font-size: 11px;
  border-collapse: collapse;
}

.orbitLab__factName {
  width: 100%;
  /* The migration tables put a colour swatch beside a short label here; without
     this the two wrap onto separate lines in the panel's narrow column. */
  white-space: nowrap;
}

.orbitLab__factValue {
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.orbitLab__legend {
  width: 100%;
  font-size: 11px;
  border-collapse: collapse;
}

.orbitLab__legendName {
  width: 100%;
}

.orbitLab__legendCount,
.orbitLab__legendShare {
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.orbitLab__legendShare {
  padding-left: 6px;
  opacity: 0.7;
}

.orbitLab__swatch {
  display: inline-block;
  width: 9px;
  height: 9px;
  margin-right: 4px;
  border: 1px solid rgba(0, 0, 0, 0.5);
  border-radius: 2px;
  vertical-align: middle;
}

/* One orbit as a strip of colour, so the state changes are countable at a glance. */
.orbitLab__strip {
  display: flex;
  height: 12px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 2px;
}

/* A state that happens at all is never invisible.
   A penumbra crossing is 10–20 s of a ~96 minute orbit, so proportionally it is a
   third of a pixel — and "0.3% penumbra" printed under a strip with no blue in it
   reads as a bug. Two pixels overstates a sliver's width and understates nothing
   else; the percentages beside the strip are what carry the real proportions. */
.orbitLab__strip > span {
  flex-basis: 0;
  min-width: 2px;
}
</style>
