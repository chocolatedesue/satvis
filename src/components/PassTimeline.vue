<!-- The pass list as a strip: when the passes are, and which of them is worth going
     outside for, without reading a column of thirty elevations.

     Satellite selections only. A ground station's list is every satellite that
     crosses it — around 500 passes in the Munich test case — and the strip becomes
     a forest with no individually hittable bar, so the panel does not render this.

     All the arithmetic is in modules/util/passTimeline.ts, so this file only turns
     percentages into styles. -->
<template>
  <div class="timeline">
    <div class="timeline__track">
      <span v-for="tick in layout.ticks" :key="tick.label" class="timeline__tick" :style="{ left: `${tick.pct}%` }">
        <i />
        <em>{{ tick.label }}</em>
      </span>
      <button
        v-for="block in layout.blocks"
        :key="block.key"
        type="button"
        class="timeline__pass"
        :class="[`timeline__pass--${block.band}`, { 'is-live': block.live, 'is-past': block.past, 'is-picked': block.startMs === picked }]"
        :style="{ left: `${block.leftPct}%`, width: `${block.widthPct}%`, height: `${block.heightPct}%` }"
        :title="titleOf(block.startMs)"
        :aria-label="titleOf(block.startMs)"
        @click="emit('pick', block.startMs)"
      />
      <span class="timeline__now" :style="{ left: `${layout.nowPct}%` }" />
    </div>
    <div class="timeline__legend">
      <span v-for="band in BANDS" :key="band.band"><i :class="`timeline__pass--${band.band}`" />{{ band.label }}</span>
      <span v-if="layout.beyond > 0" class="timeline__more">+{{ layout.beyond }} past {{ layout.horizonLabel }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

import { formatCountdown, passSummary, type Pass } from "../modules/PassPredictor";
import { passTimelineLayout } from "../modules/util/passTimeline";

const props = defineProps<{
  /** The same passes the table shows, in the same order. */
  passes: readonly Pass[];
  nowMs: number;
  /** `elevation` or `swath` — only the legend's wording depends on it. */
  mode: string;
  /** Start time of the pass currently picked, if any. */
  picked: number | null;
}>();

const emit = defineEmits<{ pick: [startMs: number] }>();

const layout = computed(() => passTimelineLayout(props.passes, props.nowMs));

/**
 * The bands, worded for what the current mode actually measures. Elevation degrees
 * beside a swath-mode strip would be labelling the colours with the wrong quantity.
 */
const BANDS = computed(() =>
  props.mode === "swath"
    ? ([
        { band: "high", label: "near centre" },
        { band: "mid", label: "mid" },
        { band: "low", label: "edge" },
      ] as const)
    : ([
        { band: "high", label: "≥45°" },
        { band: "mid", label: "20–45°" },
        { band: "low", label: "<20°" },
      ] as const),
);

const byStart = computed(() => new Map(props.passes.map((pass) => [pass.start, pass])));

/** Everything the block cannot say in its height: who, when, how long, how good. */
function titleOf(startMs: number): string {
  const pass = byStart.value.get(startMs);
  if (!pass) {
    return "";
  }
  const subject = pass.groundStationName ?? pass.name;
  return `${subject ? `${subject} · ` : ""}in ${formatCountdown(props.nowMs, pass)} · ${passSummary(pass)}`;
}
</script>

<style scoped>
.timeline {
  padding-bottom: 4px;
}

.timeline__track {
  position: relative;
  height: 42px;
  border-bottom: 1px solid #ffffff30;
  background: #ffffff08;
}

.timeline__tick {
  position: absolute;
  top: 0;
  bottom: 0;
}

.timeline__tick i {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: #ffffff14;
}

.timeline__tick em {
  position: absolute;
  bottom: -13px;
  left: 2px;
  color: #edffff70;
  font-size: 9px;
  font-style: normal;
}

.timeline__pass {
  position: absolute;
  bottom: 0;
  min-width: 3px;
  border-radius: 1px 1px 0 0;
  cursor: pointer;
}

/* Okabe-Ito blue for the passes worth the trip, and two neutrals below it — the
   same reasoning as ORBIT_CLASS_COLOR, where the common case takes the quiet
   colour so the rare one can carry the emphasis. */
.timeline__pass--high {
  background: #56b4e9;
}

.timeline__pass--mid {
  background: #b8c4c4;
}

.timeline__pass--low {
  background: #8a9494;
}

.timeline__pass:hover {
  outline: 1px solid #ffffffcc;
}

.timeline__pass.is-live {
  box-shadow:
    0 0 0 1px #ffffff,
    0 0 8px #56b4e9;
}

.timeline__pass.is-past {
  opacity: 0.35;
}

/* The picked pass, at both ends of the link: a ring here, a wash and a right edge
   on its row. Deliberately not the green the next-pass marker uses — the two are
   different facts and a pass can be both. */
.timeline__pass.is-picked {
  opacity: 1;
  outline: 2px solid #edffff;
  outline-offset: 1px;
}

.timeline__now {
  position: absolute;
  top: -3px;
  bottom: -3px;
  width: 2px;
  background: #4caf50;
}

.timeline__legend {
  display: flex;
  gap: 10px;
  margin-top: 15px;
  color: #edffff80;
  font-size: 9.5px;
}

.timeline__legend i {
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 3px;
  border-radius: 1px;
}

.timeline__more {
  margin-left: auto;
}
</style>
