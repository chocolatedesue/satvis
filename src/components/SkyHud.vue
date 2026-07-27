<template>
  <div v-if="visible" class="sky-hud">
    <svg class="sky-hud__svg">
      <path v-if="trace" class="sky-hud__trace" :d="trace" />

      <!-- Compass tape. The band sits at a fixed height, but each tick's
           horizontal position is projected, not derived from the heading. -->
      <g class="sky-hud__tape">
        <line :x1="0" :y1="COMPASS_Y + TAPE_LENGTH" :x2="'100%'" :y2="COMPASS_Y + TAPE_LENGTH" class="sky-hud__tape-rule" />
        <g v-for="tick in compass" :key="`az${tick.value}`">
          <line :x1="tick.offset" :y1="COMPASS_Y + (tick.major ? 0 : TAPE_LENGTH / 2)" :x2="tick.offset" :y2="COMPASS_Y + TAPE_LENGTH" :class="tickClass(tick)" />
          <text v-if="tick.label" :x="tick.offset" :y="COMPASS_Y - 4" class="sky-hud__label" text-anchor="middle">{{ tick.label }}</text>
        </g>
        <polygon :points="pointerPoints" class="sky-hud__pointer" />
      </g>

      <!-- Elevation tape, projected the same way, along the current azimuth. -->
      <g class="sky-hud__tape">
        <line :x1="ELEVATION_X + TAPE_LENGTH" :y1="0" :x2="ELEVATION_X + TAPE_LENGTH" :y2="'100%'" class="sky-hud__tape-rule" />
        <g v-for="tick in elevation" :key="`el${tick.value}`">
          <line :x1="ELEVATION_X + (tick.major ? 0 : TAPE_LENGTH / 2)" :y1="tick.offset" :x2="ELEVATION_X + TAPE_LENGTH" :y2="tick.offset" :class="tickClass(tick)" />
          <text v-if="tick.major" :x="ELEVATION_X + TAPE_LENGTH + 5" :y="tick.offset + 4" class="sky-hud__label">{{ tick.label }}</text>
        </g>
      </g>
    </svg>

    <div class="sky-hud__reticle" :class="{ 'sky-hud__reticle--locked': locked }">
      <svg viewBox="-30 -30 60 60" class="h-full w-full">
        <circle r="10" />
        <line x1="-26" y1="0" x2="-14" y2="0" />
        <line x1="14" y1="0" x2="26" y2="0" />
        <line x1="0" y1="-26" x2="0" y2="-14" />
        <line x1="0" y1="14" x2="0" y2="26" />
      </svg>
    </div>

    <div v-if="locked" class="sky-hud__card">
      <div class="sky-hud__name">{{ locked.name }}</div>
      <dl class="sky-hud__facts">
        <template v-for="fact in facts" :key="fact[0]">
          <dt>{{ fact[0] }}</dt>
          <dd>{{ fact[1] }}</dd>
        </template>
      </dl>
      <div class="sky-hud__hint">Tap to open</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed, onUnmounted, watch } from "vue";

import { createSkyHud, type TapeTick } from "../composables/useSkyHud";
import { SKY_MODE } from "../config/viewModes";
import { compassPoint } from "../modules/SkyTargets";
import { useCesiumStore } from "../stores/cesium";

// Geometry that the template needs as numbers. It cannot go through Tailwind:
// classes are extracted by scanning source text, so a class built at runtime
// (`bottom-[${x}px]`) never has any CSS emitted for it.
const COMPASS_Y = 46;
const ELEVATION_X = 8;
const TAPE_LENGTH = 12;

const { compass, elevation, locked, trace, start, stop } = createSkyHud();

const { sceneMode } = storeToRefs(useCesiumStore());
const visible = computed(() => sceneMode.value === SKY_MODE);

const pointerPoints = computed(() => {
  // Centre pointer, drawn against the same band the ticks hang from.
  const y = COMPASS_Y + TAPE_LENGTH;
  return `-7,${y + 9} 7,${y + 9} 0,${y}`;
});

const facts = computed<[string, string][]>(() => {
  const target = locked.value;
  if (!target) {
    return [];
  }
  return [
    ["Elevation", `${target.elevation.toFixed(1)}°`],
    ["Azimuth", `${target.azimuth.toFixed(1)}° ${compassPoint(target.azimuth)}`],
    ["Range", `${Math.round(target.rangeKm).toLocaleString()} km`],
    ["Altitude", `${Math.round(target.altitudeKm).toLocaleString()} km`],
  ];
});

const tickClass = (tick: TapeTick): string => (tick.major ? "sky-hud__tick sky-hud__tick--major" : "sky-hud__tick");

watch(visible, (on) => (on ? start() : stop()), { immediate: true });
onUnmounted(stop);
</script>

<style scoped>
/* z-4 with no pointer events anywhere: Cesium's clock, timeline and credits sit
   in a sibling container before #app, and #app isolates its stacking context, so
   nothing here can ever be raised above them — a surface that swallowed clicks
   would have no z-index fix. Look-around listens on the Cesium canvas instead. */
.sky-hud {
  position: absolute;
  inset: 0;
  z-index: 4;
  pointer-events: none;
  color: #edffff;
  font-variant-numeric: tabular-nums;
}

.sky-hud__svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
}

.sky-hud__trace {
  fill: none;
  stroke: #7dd3fc;
  stroke-width: 1.5;
  stroke-dasharray: 5 4;
  opacity: 0.85;
}

.sky-hud__tape-rule {
  stroke: #edffff;
  stroke-width: 1;
  opacity: 0.25;
}

.sky-hud__tick {
  stroke: #edffff;
  stroke-width: 1;
  opacity: 0.5;
}

.sky-hud__tick--major {
  stroke-width: 1.5;
  opacity: 0.9;
}

.sky-hud__label {
  fill: #edffff;
  font-size: 11px;
  opacity: 0.9;
  paint-order: stroke;
  stroke: #000;
  stroke-width: 2.5px;
}

.sky-hud__pointer {
  fill: #4ade80;
}

.sky-hud__reticle {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 60px;
  height: 60px;
  transform: translate(-50%, -50%);
}

.sky-hud__reticle :deep(circle),
.sky-hud__reticle :deep(line) {
  fill: none;
  stroke: #edffff;
  stroke-width: 2;
  opacity: 0.55;
}

.sky-hud__reticle--locked :deep(circle),
.sky-hud__reticle--locked :deep(line) {
  stroke: #4ade80;
  opacity: 1;
}

.sky-hud__card {
  position: absolute;
  left: 50%;
  bottom: 64px;
  transform: translateX(-50%);
  min-width: 220px;
  padding: 8px 12px;
  border-radius: 8px;
  background-color: #303336d9;
  font-size: 13px;
  text-align: center;
}

.sky-hud__name {
  font-weight: 600;
  margin-bottom: 4px;
}

.sky-hud__facts {
  display: grid;
  grid-template-columns: auto auto;
  gap: 1px 12px;
  text-align: left;
}

.sky-hud__facts dd {
  text-align: right;
}

.sky-hud__hint {
  margin-top: 4px;
  opacity: 0.7;
  font-size: 11px;
}
</style>
