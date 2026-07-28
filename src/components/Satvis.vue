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
            <UIcon name="fa6-solid:layer-group" />
          </button>
        </UTooltip>
        <UTooltip text="Ground station">
          <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('gs')">
            <i class="icon svg-groundstation"></i>
          </button>
        </UTooltip>
        <UTooltip text="Map">
          <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('map')">
            <UIcon name="fa6-solid:earth-africa" />
          </button>
        </UTooltip>
        <UTooltip v-if="cc.minimalUI" text="Mobile">
          <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('ios')">
            <UIcon name="fa6-solid:mobile-screen-button" />
          </button>
        </UTooltip>
        <UTooltip text="Debug">
          <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('dbg')">
            <UIcon name="fa6-solid:hammer" />
          </button>
        </UTooltip>
      </div>
      <!-- v-if (not v-show like the other panels): the virtualized list inside
           measures its scroll element on mount, and mounting hidden (display:none)
           yields a 0-height measurement that only a later ResizeObserver tick would
           fix. Mounting on open guarantees a correct first paint; browser state
           (search, expansion) is module-scoped in useSatelliteBrowser and survives
           remounts. -->
      <div v-if="menu.cat" class="toolbarSwitches toolbarSwitches--catalog">
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
          <input type="button" @click="void cc.setGroundStationFromGeolocation()" />
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
          <input v-model="layerSelection" type="checkbox" :value="name" />
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
          <UIcon name="fa6-brands:github" />
        </a>
      </UTooltip>
      <UTooltip text="Toggle UI">
        <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleUI">
          <UIcon name="fa6-solid:eye" />
        </button>
      </UTooltip>
    </div>
    <!-- Deliberately outside the showUI toggle: the entity info replaces the
         Cesium InfoBox, which was visible with hidden UI and in minimalUI. -->
    <entity-info-panel />
    <sky-hud />
  </div>
</template>

<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed, onMounted, reactive, ref } from "vue";

import { DeviceDetect } from "../modules/util/DeviceDetect";
import { useCesiumStore } from "../stores/cesium";
import { useSatStore } from "../stores/sat";
import EntityInfoPanel from "./EntityInfoPanel.vue";
import SatelliteBrowser from "./SatelliteBrowser.vue";
import SkyHud from "./SkyHud.vue";

type MenuKey = "cat" | "sat" | "gs" | "map" | "ios" | "dbg";

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
const { layers, terrainProvider, sceneMode, cameraMode, qualityPreset, showFps, pickMode } = storeToRefs(cesiumStore);

// The checkbox list writes the whole array back. layers is read-only because
// "at most one base layer" is an invariant of the list, so the write is routed
// through the action that enforces it.
const layerSelection = computed({
  get: () => layers.value,
  set: (next: string[]) => cesiumStore.setLayers(next),
});

const satStore = useSatStore();
const { enabledComponents, overpassMode } = storeToRefs(satStore);

onMounted(() => {
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
