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

<script lang="ts">
import { mapWritableState } from "pinia";
import VueMultiselect from "vue-multiselect";

import { useSatStore } from "../stores/sat";

export default {
  components: {
    VueMultiselect,
  },
  data() {
    return {};
  },
  computed: {
    ...mapWritableState(useSatStore, ["availableSatellitesByTag", "availableTags", "enabledSatellites", "enabledTags", "trackedSatellite"]),
    availableSatellites(): { tag: string; sats: string[] }[] {
      let satlist = Object.keys(this.availableSatellitesByTag).map((tag) => ({
        tag,
        sats: this.availableSatellitesByTag[tag] ?? [],
      }));
      if (satlist.length === 0) {
        satlist = [];
      }
      return satlist;
    },
    satellitesEnabledByTag(): string[] {
      return this.getSatellitesFromTags(this.enabledTags);
    },
    allEnabledSatellites: {
      get(): string[] {
        return this.satellitesEnabledByTag.concat(this.enabledSatellites ?? []);
      },
      set(sats: string[]) {
        const enabledTags = this.availableTags.filter((tag) => !(this.availableSatellitesByTag[tag] ?? []).some((sat) => !sats.includes(sat)));
        const satellitesInEnabledTags = this.getSatellitesFromTags(enabledTags);
        const enabledSatellites = sats.filter((sat) => !satellitesInEnabledTags.includes(sat));
        cc.sats.enabledSatellites = enabledSatellites;
        cc.sats.enabledTags = enabledTags;
      },
    },
  },
  watch: {
    enabledSatellites(sats: string[]) {
      cc.sats.enabledSatellites = sats;
    },
    enabledTags(tags: string[]) {
      cc.sats.enabledTags = tags;
    },
    trackedSatellite(satellite: string) {
      cc.sats.trackedSatellite = satellite;
    },
  },
  methods: {
    getSatellitesFromTags(taglist: string[]): string[] {
      return taglist.flatMap((tag) => this.availableSatellitesByTag[tag] || []);
    },
  },
};
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
