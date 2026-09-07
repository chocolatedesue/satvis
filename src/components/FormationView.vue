<template>
  <div v-if="params" class="formation">
    <div class="toolbarTitle">{{ $t("formation.title") }}</div>
    <canvas ref="canvas" class="formation__canvas" :width="SIZE" :height="SIZE" />
    <div class="formation__frames">
      <button type="button" class="formation__button" :class="{ 'formation__button--on': !rotating }" @click="useEpochFrame">{{ $t("formation.nonRotating") }}</button>
      <button type="button" class="formation__button" :class="{ 'formation__button--on': rotating }" @click="rotating = true">{{ $t("formation.rotating") }}</button>
    </div>
    <p class="formation__note">
      {{
        $t("formation.summary", {
          rings: params.rings,
          pitch: params.pitchM,
          members: memberCount,
          radius: formatMetres(radiusKm * 1000),
        })
      }}
      <span v-if="rotating" v-html="$t('formation.rotatingNote')"></span>
      <span v-else v-html="$t('formation.nonRotatingNote')"></span>
      {{ $t("formation.runClock") }}
    </p>
    <!-- The numbers behind the picture. A shape breathing twice an orbit is
         visible; how much it breathes is not measurable off 512 pixels, and the
         ellipse angle is the deformation stated outright. -->
    <p v-if="spacing" class="formation__readout">
      {{ $t("formation.spacing", { nearest: formatMetres(spacing.nearest), furthest: formatMetres(spacing.furthest) }) }}
      <template v-if="!rotating"> · {{ $t("formation.turned", { degrees: ellipseDeg.toFixed(0) }) }}</template>
    </p>
  </div>
</template>

<script setup lang="ts">
import { JulianDate } from "@cesium/engine";
import { computed, onUnmounted, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";

import { useController } from "../composables/useController";
import { CLUSTER_EPOCH_ISO, decodeCluster } from "../modules/util/clusterFormation";
import { formationBasis, formationSatrecs, formationSnapshot, meanMotionRadPerSec, type FormationSnapshot } from "../modules/util/formationSnapshot";
import { useSatStore } from "../stores/sat";

/** Square, because the axes are the same span and a formation is not wider than it is tall. */
const SIZE = 512;

/**
 * How often the canvas is redrawn.
 *
 * The clock ticks at render rate and a formation moves at orbital rate; at the
 * demo's 120x a shape cycle takes 24 s, so twenty frames a second is far more
 * than the picture can show and already more than it needs.
 */
const REDRAW_MS = 50;

const { t } = useI18n();

const cc = useController();
const satStore = useSatStore();

const canvas = ref<HTMLCanvasElement>();
const rotating = ref(false);
const snapshot = shallowRef<FormationSnapshot>();
/** The instant the held frame was captured at. Reset moves it to now. */
const frameEpoch = shallowRef(new Date(CLUSTER_EPOCH_ISO));

// The first formation on screen. One rather than a list: two formations do not
// share a reference satellite, so there is no frame that draws both.
const params = computed(() => {
  for (const wire of satStore.cluster) {
    const decoded = decodeCluster(wire);
    if (decoded) {
      return decoded;
    }
  }
  return undefined;
});

const radiusKm = computed(() => (snapshot.value?.radiusM ?? 0) / 1000);
const memberCount = computed(() => snapshot.value?.members.length ?? 0);

// Built once per formation: parsing 81 element sets on every frame would be the
// only expensive thing here.
const satrecs = computed(() => (params.value ? formationSatrecs(params.value, new Date(CLUSTER_EPOCH_ISO)) : []));

function useEpochFrame(): void {
  rotating.value = false;
  frameEpoch.value = JulianDate.toDate(cc.viewer.clock.currentTime);
  draw();
}

function sample(): void {
  const shape = params.value;
  if (!shape || satrecs.value.length === 0) {
    snapshot.value = undefined;
    return;
  }
  const at = JulianDate.toDate(cc.viewer.clock.currentTime);
  const epoch = rotating.value ? at : frameEpoch.value;
  const basis = formationBasis(satrecs.value, epoch);
  if (!basis) {
    snapshot.value = undefined;
    return;
  }
  snapshot.value = formationSnapshot(shape, satrecs.value, at, basis, epoch, meanMotionRadPerSec(shape));
}

/**
 * Which of the four kinds of point a member is, in the colours Google's figure
 * uses: the reference red, its eight lattice neighbours magenta, the member
 * furthest along-track navy, and everything else periwinkle.
 */
function colourOf(member: { i: number; j: number }, rings: number): string {
  if (member.i === 0 && member.j === 0) {
    return "#ff2d2d";
  }
  if (member.i === 0 && member.j === rings) {
    return "#22308c";
  }
  if (Math.abs(member.i) <= 1 && Math.abs(member.j) <= 1) {
    return "#c000c0";
  }
  return "#8f9cf0";
}

/**
 * How far each member is from its own nearest neighbour, as a min and max over
 * the lattice — in metres.
 *
 * This is the number that breathes. The picture shows the shape; this says how
 * much, and it is what makes the 2:1 deformation legible on a canvas too small
 * to measure: for Suncatcher's lattice the range runs 100–200 m over an orbit.
 */
const spacing = computed(() => {
  const members = snapshot.value?.members ?? [];
  let nearest = Number.POSITIVE_INFINITY;
  let furthest = 0;
  for (const member of members) {
    let own = Number.POSITIVE_INFINITY;
    for (const other of members) {
      if (other === member) {
        continue;
      }
      own = Math.min(own, Math.hypot(member.alongTrack - other.alongTrack, member.radial - other.radial));
    }
    if (Number.isFinite(own)) {
      nearest = Math.min(nearest, own);
      furthest = Math.max(furthest, own);
    }
  }
  return Number.isFinite(nearest) ? { nearest, furthest } : undefined;
});

/** How far the bounding ellipse has turned in this frame — the whole of the deformation. */
const ellipseDeg = computed(() => ((snapshot.value?.ellipseAngleRad ?? 0) * 180) / Math.PI);

function draw(): void {
  const element = canvas.value;
  const shape = params.value;
  const current = snapshot.value;
  const context = element?.getContext("2d");
  if (!element || !context || !shape || !current) {
    return;
  }
  // The axes span the formation's own radius with a margin, so the drawing is
  // scaled to the design rather than to whatever the data happens to reach — a
  // formation that grew past its bound should look like it did, not be rescaled
  // until it fits.
  const span = current.radiusM * 1.15;
  const scale = SIZE / 2 / span;
  const centre = SIZE / 2;
  // Along-track runs right, radial runs up: the orientation of the paper figure.
  const x = (metres: number) => centre + metres * scale;
  const y = (metres: number) => centre - metres * scale;

  context.clearRect(0, 0, SIZE, SIZE);
  context.fillStyle = "#0b1020";
  context.fillRect(0, 0, SIZE, SIZE);

  context.strokeStyle = "#243050";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(0, centre);
  context.lineTo(SIZE, centre);
  context.moveTo(centre, 0);
  context.lineTo(centre, SIZE);
  context.stroke();

  // The circle of radius R: how far the formation may reach in any direction.
  context.strokeStyle = "#39476e";
  context.setLineDash([3, 3]);
  context.beginPath();
  context.arc(centre, centre, current.radiusM * scale, 0, 2 * Math.PI);
  context.stroke();

  // The bounding ellipse: R along-track by R/2 radial, turning with the frame.
  context.strokeStyle = "#7c8bbf";
  context.beginPath();
  context.ellipse(centre, centre, current.radiusM * scale, (current.radiusM / 2) * scale, -current.ellipseAngleRad, 0, 2 * Math.PI);
  context.stroke();
  context.setLineDash([]);

  // To Earth, so up and down are not a guess. It turns with the ellipse.
  const toEarth = -Math.PI / 2 - current.ellipseAngleRad;
  const arrow = current.radiusM * 1.08 * scale;
  context.strokeStyle = "#9fb0d8";
  context.beginPath();
  context.moveTo(centre + Math.cos(toEarth) * arrow * 0.86, centre + Math.sin(toEarth) * arrow * 0.86);
  context.lineTo(centre + Math.cos(toEarth) * arrow, centre + Math.sin(toEarth) * arrow);
  context.stroke();

  for (const member of current.members) {
    context.fillStyle = colourOf(member, shape.rings);
    context.beginPath();
    context.arc(x(member.alongTrack), y(member.radial), 3, 0, 2 * Math.PI);
    context.fill();
  }

  // On the canvas rather than translated: it is a drawing, and the language of
  // the panel's own labels is already the reader's.
  context.fillText(`±${formatMetres(current.radiusM)}`, 6, SIZE - 6);
  context.fillText(rotating.value ? t("formation.rotating") : t("formation.nonRotating"), 6, 16);
}

/** Metres below a kilometre, kilometres above — a 1 km lattice and a 120 km one share this view. */
function formatMetres(metres: number): string {
  return metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(metres < 10000 ? 2 : 0)} km`;
}

let timer: number | undefined;
function tick(): void {
  sample();
  draw();
}

watch(
  params,
  (shape) => {
    window.clearInterval(timer);
    timer = undefined;
    if (!shape) {
      snapshot.value = undefined;
      return;
    }
    // Held from the moment a formation appears, so the first thing on screen is
    // the lattice it was asked for and the deformation happens while watched.
    frameEpoch.value = JulianDate.toDate(cc.viewer.clock.currentTime);
    tick();
    timer = window.setInterval(tick, REDRAW_MS);
  },
  { immediate: true },
);

watch(rotating, tick);

onUnmounted(() => window.clearInterval(timer));
</script>

<style scoped>
.formation__canvas {
  display: block;
  width: 100%;
  height: auto;
  border-radius: 4px;
  margin-bottom: 4px;
}

.formation__frames {
  display: flex;
  gap: 4px;
}

.formation__button {
  flex: 1;
  padding: 4px 6px;
  font-size: 11px;
  color: #cfd8ef;
  background: #1b2440;
  border: 1px solid #2c3860;
  border-radius: 4px;
  cursor: pointer;
}

.formation__note {
  margin: 6px 0 0;
  font-size: 11px;
  line-height: 1.45;
  color: #98a6c6;
}

/* Monospace, because these are measurements rather than prose: a reader is
   comparing two numbers that change every frame, and proportional digits make
   that a fight. */
.formation__readout {
  margin: 4px 0 0;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 11px;
  color: #cbd5f5;
}

.formation__button--on {
  color: #fff;
  background: #2f3f70;
  border-color: #4d5f9c;
}
</style>
