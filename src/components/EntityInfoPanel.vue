<template>
  <div v-if="selection" class="entity-info-panel">
    <UCard :ui="{ root: 'bg-[#303336]/95 text-[#edffff] divide-neutral-600', header: 'p-2 sm:px-3', body: 'p-3 sm:p-3 info-body' }">
      <template #header>
        <div class="flex items-center gap-1">
          <span class="grow truncate text-base font-semibold">{{ name }}</span>
          <UTooltip text="Notify for upcoming passes">
            <UButton icon="i-lucide-bell" variant="ghost" color="neutral" size="xs" aria-label="Notify for upcoming passes" @click="notifyPasses" />
          </UTooltip>
          <UTooltip v-if="selection.kind === 'satellite'" text="Show satellite info on n2yo.com">
            <UButton icon="i-lucide-info" variant="ghost" color="neutral" size="xs" aria-label="Show satellite info on n2yo.com" @click="openExternalInfo" />
          </UTooltip>
          <!-- Hidden rather than disabled in the sky view, which owns the camera:
               tracking there has no meaning to convey, and a button that silently
               did nothing would read as broken. -->
          <UTooltip v-if="!inSkyView" :text="isTracked ? 'Stop tracking' : 'Track entity'">
            <UButton icon="i-lucide-video" variant="ghost" :color="isTracked ? 'primary' : 'neutral'" size="xs" aria-label="Track entity" @click="toggleTrack" />
          </UTooltip>
          <UButton icon="i-lucide-x" variant="ghost" color="neutral" size="xs" aria-label="Close" @click="deselect" />
        </div>
      </template>

      <template v-if="position.length > 0">
        <h3>Position</h3>
        <table class="info-table">
          <thead>
            <tr>
              <th v-for="row in position" :key="row.label">{{ row.label }}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td v-for="row in position" :key="row.label">{{ row.value }}</td>
            </tr>
          </tbody>
        </table>
      </template>

      <template v-if="satelliteInfo.length > 0">
        <h3>Satellite</h3>
        <table class="info-table">
          <tbody>
            <tr v-for="[label, value] in satelliteInfo" :key="label">
              <td>{{ label }}</td>
              <td class="text-right!">{{ value }}</td>
            </tr>
          </tbody>
        </table>
      </template>

      <template v-if="!hasAnyPasses">
        <h3>Passes</h3>
        <div class="text-center">{{ selection.kind === "groundstation" ? "No passes available" : "No ground station set" }}</div>
      </template>
      <template v-else>
        <h3>Passes ({{ modeLabel }})</h3>
        <div class="mb-2 flex justify-end">
          <USwitch v-model="showPastPasses" label="Show past passes" size="xs" />
        </div>
        <div v-if="passRows.length === 0" class="text-center">No upcoming passes</div>
        <table v-else class="info-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Countdown</th>
              <th>Start</th>
              <th>End</th>
              <th>{{ overpassMode === "swath" ? "Dist" : "El" }}</th>
              <th>{{ overpassMode === "swath" ? "Swath" : "Az" }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in passRows" :key="row.key">
              <td>{{ row.name }}</td>
              <td>{{ row.countdown }}</td>
              <td>
                <a class="cursor-pointer underline decoration-dotted underline-offset-2" @click="cc.setTime(row.startMs)">{{ row.startLabel }}</a>
              </td>
              <td>{{ row.endLabel }}</td>
              <td class="text-right!">{{ row.primary }}</td>
              <td class="text-right!">{{ row.secondary }}</td>
            </tr>
          </tbody>
        </table>
      </template>

      <template v-if="elements">
        <template v-if="elements.kind === 'tle'">
          <h3>TLE (Epoch {{ elements.epoch }})</h3>
          <pre class="info-code"><code>{{ elements.lines }}</code></pre>
        </template>
        <template v-else>
          <h3>Elements (Epoch {{ elements.epoch }})</h3>
          <table class="info-table">
            <tbody>
              <tr v-for="[label, value] in elements.rows" :key="label">
                <td>{{ label }}</td>
                <td class="text-right!">{{ value }}</td>
              </tr>
            </tbody>
          </table>
        </template>
      </template>
    </UCard>
  </div>
</template>

<script setup lang="ts">
import { useToast } from "@nuxt/ui/composables/useToast";
import dayjs from "dayjs";
import { storeToRefs } from "pinia";
import { computed } from "vue";

import { useController } from "../composables/useController";
import { useSelectedEntity } from "../composables/useSelectedEntity";
import { SKY_MODE } from "../config/viewModes";
import type { Pass } from "../modules/PassPredictor";
import { useCesiumStore } from "../stores/cesium";
import { useSatStore } from "../stores/sat";

const cc = useController();
const toast = useToast();

const { selection, isTracked, name, position, passRows, hasAnyPasses, showPastPasses, elements, satelliteInfo, deselect, toggleTrack } = useSelectedEntity(cc);

const { overpassMode } = storeToRefs(useSatStore());

const { sceneMode } = storeToRefs(useCesiumStore());
const inSkyView = computed(() => sceneMode.value === SKY_MODE);
const modeLabel = computed(() => overpassMode.value.charAt(0).toUpperCase() + overpassMode.value.slice(1));

function notifyForPass(pass: Pass, aheadMin = 5): void {
  const start = dayjs(pass.start).startOf("second");
  cc.pm.notifyAtDate(start.subtract(aheadMin, "minute").toDate(), `${pass.name} pass in ${aheadMin} minutes`);
  cc.pm.notifyAtDate(start.toDate(), `${pass.name} pass starting now`);
}

function notifyPasses(): void {
  if (!cc.sats.groundStationAvailable) {
    toast.add({
      color: "warning",
      title: "Warning",
      description: "Ground station required to notify for passes",
      duration: 3000,
    });
    return;
  }
  let passes: Pass[] = [];
  if (selection.value?.kind === "satellite") {
    passes = selection.value.sat.props.passPredictor.passes(cc.viewer.clock.currentTime);
  } else if (selection.value?.kind === "groundstation") {
    passes = selection.value.gs.passes(cc.viewer.clock.currentTime);
  }
  if (passes.length === 0) {
    toast.add({
      color: "info",
      title: "Info",
      description: "No passes available",
      duration: 3000,
    });
    return;
  }
  passes.forEach((pass) => notifyForPass(pass));
  toast.add({
    color: "success",
    title: "Success",
    description: `Notifying for ${passes.length} passes`,
    duration: 3000,
  });
}

function openExternalInfo(): void {
  if (selection.value?.kind !== "satellite") {
    return;
  }
  const { satnum } = selection.value.sat.props;
  window.open(`https://www.n2yo.com/satellite/?s=${satnum}`, "_blank", "noopener");
}
</script>

<style scoped>
.entity-info-panel {
  position: absolute;
  top: 50px;
  right: 5px;
  width: calc(100% - 10px);
  max-width: 540px;
  z-index: 5;
  font-size: 14px;
}

/* Scroll long content (many passes) inside the card like the old InfoBox did. */
.entity-info-panel :deep(.info-body) {
  max-height: 500px;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

h3 {
  text-align: center;
  font-weight: 600;
  margin-block-start: 10px;
  margin-block-end: 10px;
}

h3:first-child {
  margin-block-start: 0;
}

.info-table {
  border-collapse: collapse;
  width: 100%;
}

.info-table th,
.info-table td {
  border: 1px solid #6d6d6d;
}

.info-table th {
  background-color: #4caf50;
  padding: 6px;
}

.info-table td {
  text-align: center;
  padding: 4px;
}

.info-table td:first-child,
.info-table th:first-child {
  text-align: left;
}

.info-code {
  background: #26262699;
  font-size: 12px;
  line-height: 1.5;
  margin: 0;
  padding: 4px;
  white-space: pre-wrap;
  overflow-x: auto;
}
</style>
