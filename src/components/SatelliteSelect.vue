<template>
  <div class="satellite-select">
    <div class="toolbarTitle">Enabled satellite groups</div>
    <div class="toolbarContent">
      <vue-multiselect v-model="enabledTags" :options="availableTags" :multiple="true" :searchable="false" placeholder="0 satellite groups selected" />
    </div>
    <div class="toolbarTitle">Enabled satellites</div>
    <div class="toolbarContent">
      <vue-multiselect
        v-model="allEnabledSatellites"
        :options="availableSatellites"
        :multiple="true"
        group-values="sats"
        group-label="tag"
        :group-select="true"
        placeholder="Type to search"
        :close-on-select="false"
        :limit="0"
        :limit-text="(count) => `${count} satellite${count > 1 ? 's' : ''} selected`"
        :options-limit="100000"
      >
        <template #noResult> No matching satellites </template>
      </vue-multiselect>
    </div>
  </div>
</template>

<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed, watch } from "vue";
import VueMultiselect from "vue-multiselect";

import { useSatStore } from "../stores/sat";

const satStore = useSatStore();
const { availableSatellitesByTag, availableTags, enabledSatellites, enabledTags, trackedSatellite } = storeToRefs(satStore);

const availableSatellites = computed<{ tag: string; sats: string[] }[]>(() => {
  let satlist = Object.keys(availableSatellitesByTag.value).map((tag) => ({
    tag,
    sats: availableSatellitesByTag.value[tag] ?? [],
  }));
  if (satlist.length === 0) {
    satlist = [];
  }
  return satlist;
});

function getSatellitesFromTags(taglist: string[]): string[] {
  return taglist.flatMap((tag) => availableSatellitesByTag.value[tag] || []);
}

const satellitesEnabledByTag = computed<string[]>(() => getSatellitesFromTags(enabledTags.value));

const allEnabledSatellites = computed<string[]>({
  get() {
    return satellitesEnabledByTag.value.concat(enabledSatellites.value ?? []);
  },
  set(sats: string[]) {
    const newEnabledTags = availableTags.value.filter((tag) => !(availableSatellitesByTag.value[tag] ?? []).some((sat) => !sats.includes(sat)));
    const satellitesInEnabledTags = getSatellitesFromTags(newEnabledTags);
    const newEnabledSatellites = sats.filter((sat) => !satellitesInEnabledTags.includes(sat));
    cc.sats.enabledSatellites = newEnabledSatellites;
    cc.sats.enabledTags = newEnabledTags;
  },
});

watch(enabledSatellites, (sats: string[]) => {
  cc.sats.enabledSatellites = sats;
});
watch(enabledTags, (tags: string[]) => {
  cc.sats.enabledTags = tags;
});
watch(trackedSatellite, (satellite: string) => {
  cc.sats.trackedSatellite = satellite;
});
</script>

<style scoped>
.satellite-select {
  width: 300px;
}
</style>

<style>
@import "vue-multiselect/dist/vue-multiselect.css";

.multiselect__single {
  display: none;
}
</style>
