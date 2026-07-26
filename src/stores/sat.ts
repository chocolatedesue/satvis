import { defineStore } from "pinia";
import { ref } from "vue";

import { SATELLITE_COMPONENTS } from "../config/components";
import { closedStringList, enumString, groundStationList, plainString, stringList, tildeEscapedStringList } from "../modules/util/urlCodec";

export interface SerializedGroundStation {
  lat: number;
  lon: number;
  name?: string;
}

export const useSatStore = defineStore(
  "sat",
  () => {
    const enabledComponents = ref<string[]>(["Point", "Label"]);
    // Bumped whenever the catalog changes so the UI can recompute catalog
    // queries reactively without putting the ~10k entries into Pinia. Not URL-synced.
    const catalogRevision = ref(0);
    const enabledSatellites = ref<string[]>([]);
    const enabledTags = ref<string[]>([]);
    // Names opted out of tag-activation (a satellite unchecked inside an
    // enabled group). Only meaningful while a covering group is enabled.
    const disabledSatellites = ref<string[]>([]);
    const groundStations = ref<SerializedGroundStation[]>([]);
    const trackedSatellite = ref("");
    const overpassMode = ref("elevation");

    return {
      enabledComponents,
      catalogRevision,
      enabledSatellites,
      enabledTags,
      disabledSatellites,
      groundStations,
      trackedSatellite,
      overpassMode,
    };
  },
  {
    // Wire format: docs/adr/0001-url-parameter-specification.md.
    urlsync: {
      enabled: true,
      config: [
        { name: "enabledComponents", url: "elements", kind: closedStringList(() => SATELLITE_COMPONENTS) },
        { name: "enabledSatellites", url: "sats", kind: tildeEscapedStringList() },
        { name: "disabledSatellites", url: "xsats", kind: tildeEscapedStringList() },
        { name: "enabledTags", url: "tags", kind: stringList() },
        { name: "groundStations", url: "gs", kind: groundStationList() },
        { name: "trackedSatellite", url: "track", kind: plainString() },
        { name: "overpassMode", url: "overpass", kind: enumString(["elevation", "swath"]) },
      ],
    },
  },
);
