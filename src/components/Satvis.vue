<template>
  <div class="cesium">
    <div v-show="showUI" id="toolbarLeft">
      <div class="toolbarButtons">
        <UTooltip text="Satellite selection">
          <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('cat')">
            <i class="icon svg-sat"></i>
          </button>
        </UTooltip>
        <UTooltip text="Satellite elements">
          <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('sat')">
            <font-awesome-icon icon="fas fa-layer-group" />
          </button>
        </UTooltip>
        <UTooltip text="Ground station">
          <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('gs')">
            <i class="icon svg-groundstation"></i>
          </button>
        </UTooltip>
        <UTooltip text="Map">
          <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('map')">
            <font-awesome-icon icon="fas fa-globe-africa" />
          </button>
        </UTooltip>
        <UTooltip v-if="cc.minimalUI" text="Mobile">
          <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('ios')">
            <font-awesome-icon icon="fas fa-mobile-alt" />
          </button>
        </UTooltip>
        <UTooltip text="Debug">
          <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('dbg')">
            <font-awesome-icon icon="fas fa-hammer" />
          </button>
        </UTooltip>
      </div>
      <!-- v-if (not v-show like the other panels): the virtualized list inside
           measures its scroll element on mount, and mounting hidden (display:none)
           yields a 0-height measurement that only a later ResizeObserver tick would
           fix. Mounting on open guarantees a correct first paint; browser state
           (search, expansion) is module-scoped in useSatelliteBrowser and survives
           remounts. -->
      <div v-if="menu.cat" class="toolbarSwitches">
        <satellite-browser />
      </div>
      <div v-show="menu.sat" class="toolbarSwitches">
        <div class="toolbarTitle">Satellite elements</div>
        <label v-for="componentName in cc.sats.availableComponents" :key="componentName" class="toolbarSwitch">
          <input v-model="enabledComponents" type="checkbox" :value="componentName" />
          <span class="slider"></span>
          {{ componentName }}
        </label>
        <!--
        <label class="toolbarSwitch">
          <input type="button" @click="cc.viewer.trackedEntity = undefined">
          Untrack Entity
        </label>
        -->
      </div>
      <div v-show="menu.gs" class="toolbarSwitches">
        <div class="toolbarTitle">Ground station</div>
        <label class="toolbarSwitch">
          <input v-model="pickMode" type="checkbox" />
          <span class="slider"></span>
          Pick on globe
        </label>
        <label class="toolbarSwitch">
          <input type="button" @click="cc.setGroundStationFromGeolocation()" />
          Set from geolocation
        </label>
        <label class="toolbarSwitch">
          <input type="button" @click="cc.sats.focusGroundStation()" />
          Focus
        </label>
        <div class="toolbarTitle">Overpass calculation</div>
        <label class="toolbarSwitch">
          <input v-model="overpassMode" type="radio" value="elevation" />
          <span class="slider"></span>
          Elevation
        </label>
        <label class="toolbarSwitch">
          <input v-model="overpassMode" type="radio" value="swath" />
          <span class="slider"></span>
          Swath
        </label>
      </div>
      <div v-show="menu.map" class="toolbarSwitches">
        <div class="toolbarTitle">Layers</div>
        <label v-for="name in cc.imageryProviderNames" :key="name" class="toolbarSwitch">
          <input v-model="layers" type="checkbox" :value="name" />
          <span class="slider"></span>
          {{ name }}
        </label>
        <div class="toolbarTitle">Terrain</div>
        <label v-for="name in cc.terrainProviderNames" :key="name" class="toolbarSwitch">
          <input v-model="terrainProvider" type="radio" :value="name" />
          <span class="slider"></span>
          {{ name }}
        </label>
        <div class="toolbarTitle">View</div>
        <label v-for="name in cc.sceneModes" :key="name" class="toolbarSwitch">
          <input v-model="sceneMode" type="radio" :value="name" />
          <span class="slider"></span>
          {{ name }}
        </label>
        <div class="toolbarTitle">Camera</div>
        <label v-for="name in cc.cameraModes" :key="name" class="toolbarSwitch">
          <input v-model="cameraMode" type="radio" :value="name" />
          <span class="slider"></span>
          {{ name }}
        </label>
      </div>
      <div v-show="menu.ios" class="toolbarSwitches">
        <div class="toolbarTitle">Mobile</div>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.scene.useWebVR" type="checkbox" />
          <span class="slider"></span>
          VR
        </label>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.clock.shouldAnimate" type="checkbox" />
          <span class="slider"></span>
          Play
        </label>
        <label class="toolbarSwitch">
          <input type="button" @click="cc.viewer.clockViewModel.multiplier *= 2" />
          Increase play speed
        </label>
        <label class="toolbarSwitch">
          <input type="button" @click="cc.viewer.clockViewModel.multiplier /= 2" />
          Decrease play speed
        </label>
        <label class="toolbarSwitch">
          <input type="button" @click="reload" />
          Reload
        </label>
      </div>
      <div v-show="menu.dbg" class="toolbarSwitches">
        <div class="toolbarTitle">Debug</div>
        <label class="toolbarSwitch">
          <input v-model="showFps" type="checkbox" />
          <span class="slider"></span>
          FPS
        </label>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.scene.requestRenderMode" type="checkbox" />
          <span class="slider"></span>
          RequestRender
        </label>
        <label class="toolbarSwitch">
          <input v-model="qualityPreset" true-value="high" false-value="low" type="checkbox" />
          <span class="slider"></span>
          High Quality
        </label>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.scene.fog.enabled" type="checkbox" />
          <span class="slider"></span>
          Fog
        </label>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.scene.globe.enableLighting" type="checkbox" />
          <span class="slider"></span>
          Lighting
        </label>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.scene.highDynamicRange" type="checkbox" />
          <span class="slider"></span>
          HDR
        </label>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.scene.globe.showGroundAtmosphere" type="checkbox" />
          <span class="slider"></span>
          Atmosphere
        </label>
        <label class="toolbarSwitch">
          <input type="button" @click="cc.jumpTo('Everest')" />
          Jump to Everest
        </label>
        <label class="toolbarSwitch">
          <input type="button" @click="cc.jumpTo('HalfDome')" />
          Jump to HalfDome
        </label>
      </div>
    </div>
    <div id="toolbarRight">
      <UTooltip v-if="showUI" text="Github">
        <a class="cesium-button cesium-toolbar-button" href="https://github.com/Flowm/satvis/" target="_blank" rel="noopener">
          <font-awesome-icon icon="fab fa-github" />
        </a>
      </UTooltip>
      <UTooltip text="Toggle UI">
        <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleUI">
          <font-awesome-icon icon="fas fa-eye" />
        </button>
      </UTooltip>
    </div>
  </div>
</template>

<script setup lang="ts">
import { storeToRefs } from "pinia";
import { onMounted, reactive, ref, watch } from "vue";
import { useRoute } from "vue-router";

import { DeviceDetect } from "../modules/util/DeviceDetect";
import { useCesiumStore } from "../stores/cesium";
import type { SerializedGroundStation } from "../stores/sat";
import { useSatStore } from "../stores/sat";
import SatelliteBrowser from "./SatelliteBrowser.vue";

type MenuKey = "cat" | "sat" | "gs" | "map" | "ios" | "dbg";

const route = useRoute();
const cc = globalThis.cc;

const menu = reactive<Record<MenuKey, boolean>>({
  cat: false,
  sat: false,
  gs: false,
  map: false,
  ios: false,
  dbg: false,
});
const showUI = ref(true);

const cesiumStore = useCesiumStore();
const { layers, terrainProvider, sceneMode, cameraMode, qualityPreset, showFps, background, pickMode } = storeToRefs(cesiumStore);

const satStore = useSatStore();
const { enabledComponents, enabledSatellites, enabledTags, groundStations, overpassMode, trackedSatellite } = storeToRefs(satStore);

watch(
  layers,
  (newLayers: string[], oldLayers: string[]) => {
    // Ensure only a single base layer is active
    const newBaseLayers = newLayers.filter((layer) => cc.baseLayers.includes(layer));
    if (newBaseLayers.length > 1) {
      const oldBaseLayers = new Set(oldLayers.filter((layer) => cc.baseLayers.includes(layer)));
      layers.value = newBaseLayers.filter((layer) => !oldBaseLayers.has(layer));
      return;
    }
    cc.imageryLayers = newLayers;
  },
  { deep: true },
);
watch(terrainProvider, (newProvider: string) => {
  cc.terrainProvider = newProvider;
});
watch(sceneMode, (newMode: string) => {
  cc.sceneMode = newMode;
});
watch(cameraMode, (newMode: string) => {
  cc.cameraMode = newMode;
});
watch(
  qualityPreset,
  (value: string) => {
    cc.qualityPreset = value;
  },
  { immediate: true },
);
watch(showFps, (value: boolean) => {
  cc.showFps = value;
});
watch(background, (value: boolean) => {
  cc.background = value;
});
watch(
  enabledComponents,
  (newComponents: string[]) => {
    cc.sats.enabledComponents = newComponents;
  },
  { deep: true },
);
watch(groundStations, (newGroundStations: SerializedGroundStation[], oldGroundStations: SerializedGroundStation[]) => {
  // Ignore if new and old ground stations are identical (also avoids a re-entrant
  // update loop, since setGroundStations writes the same values back to the store)
  const serialize = (stations: SerializedGroundStation[]) => JSON.stringify(stations.map((gs) => [gs.lat, gs.lon, gs.name]));
  if (serialize(newGroundStations) === serialize(oldGroundStations)) {
    return;
  }
  cc.setGroundStations(newGroundStations);
});
watch(overpassMode, (newMode: string) => {
  cc.sats.overpassMode = newMode;
});
// Carry the store's satellite activation state into the SatelliteManager. These
// live here (an always-mounted component) rather than in the catalog panel
// (SatelliteBrowser, mounted behind a v-show) so that URL-hydrated state
// (applied by the url-sync plugin after mount, as a store change) reaches
// Cesium even when the catalog panel is never opened.
// Non-immediate on purpose: the url-sync plugin writes the hydrated values into
// the store after mount, which fires these watchers; the manager starts from
// its own matching defaults.
watch(enabledSatellites, (sats: string[]) => {
  cc.sats.enabledSatellites = sats;
});
watch(enabledTags, (tags: string[]) => {
  cc.sats.enabledTags = tags;
});
watch(trackedSatellite, (satellite: string) => {
  cc.sats.trackedSatellite = satellite;
});

onMounted(() => {
  if (route.query.time) {
    cc.setTime(route.query.time as string);
  }
  showUI.value = !DeviceDetect.inIframe();
});

function toggleMenu(name: MenuKey) {
  const oldState = menu[name];
  (Object.keys(menu) as MenuKey[]).forEach((k) => {
    menu[k] = false;
  });
  menu[name] = !oldState;
}

function toggleUI() {
  showUI.value = !showUI.value;
  if (!cc.minimalUI) {
    cc.showUI = showUI.value;
  }
}

function reload() {
  window.location.reload();
}
</script>
