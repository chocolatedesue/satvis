<template>
  <div v-if="params" class="formation">
    <div class="toolbarTitle">Formation view</div>
    <canvas ref="canvas" class="formation__canvas" :width="SIZE" :height="SIZE" />
    <div class="formation__frames">
      <button type="button" class="formation__button" :class="{ 'formation__button--on': !rotating }" @click="useEpochFrame">Non-rotating</button>
      <button type="button" class="formation__button" :class="{ 'formation__button--on': rotating }" @click="rotating = true">Rotating</button>
    </div>
    <p class="formation__note">
      {{ params.rings }} rings at {{ params.pitchM }} m — {{ memberCount }} members inside R = {{ Math.round(radiusKm) }} km, drawn from the reference satellite rather than from
      the globe, where the whole formation is a few pixels wide.
      <template v-if="rotating">
        In the <strong>rotating</strong> frame the formation sits still inside its ellipse — twice as wide along-track as it is tall — and never leaves it. That is what
        <em>bounded</em> means, and it is why this frame shows no deformation at all.
      </template>
      <template v-else>
        In the <strong>non-rotating</strong> frame — the reference's axes captured once and held while it flies on — the ellipse turns with the orbit and the formation is seen to
        deform, flat to upright to flat, <strong>twice per orbit</strong>. Same motion, different frame; this is the one Google's figure is drawn in.
      </template>
      Run the clock to watch it.
    </p>
  </div>
</template>

<script setup lang="ts">
import { JulianDate } from "@cesium/engine";
import { computed, onUnmounted, ref, shallowRef, watch } from "vue";

import { useController } from "../composables/useController";
import { CLUSTER_EPOCH_ISO, decodeCluster } from "../modules/util/clusterFormation";
import { formationBasis, formationSatrecs, formationSnapshot, meanMotionRadPerSec, type FormationSnapshot } from "../modules/util/formationSnapshot";
import { useSatStore } from "../stores/sat";

/** Square, because the axes are the same span and a formation is not wider than it is tall. */
const SIZE = 256;

/**
 * How often the canvas is redrawn.
 *
 * The clock ticks at render rate and a formation moves at orbital rate; at the
 * demo's 120x a shape cycle takes 24 s, so twenty frames a second is far more
 * than the picture can show and already more than it needs.
 */
const REDRAW_MS = 50;

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

  context.fillStyle = "#8091b8";
  context.font = "10px system-ui, sans-serif";
  context.fillText(`±${Math.round(current.radiusM / 1000)} km`, 6, SIZE - 6);
  context.fillText(rotating.value ? "rotating" : "non-rotating", 6, 14);
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

.formation__button--on {
  color: #fff;
  background: #2f3f70;
  border-color: #4d5f9c;
}
</style>
