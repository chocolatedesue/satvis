import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { SATELLITE_COMPONENTS } from "../config/components";
import { closedStringList, enumString, groundStationList, plainString, stringList, tildeEscapedStringList } from "../modules/util/urlCodec";

export interface SerializedGroundStation {
  lat: number;
  lon: number;
  name?: string;
}

/**
 * A change to the activation triple. Omitted lists keep their current value;
 * the three are written together because none can be validated alone.
 */
export interface ActivationPatch {
  enabledTags?: string[];
  enabledSatellites?: string[];
  disabledSatellites?: string[];
}

const unique = (names: readonly string[]): string[] => [...new Set(names)];
// ~11 m. A deliberate size/precision trade, and the reason the store rounds
// rather than leaving it to whatever wrote the value.
const COORDINATE_PRECISION = 4;
const roundCoordinate = (value: number): number => Number(value.toFixed(COORDINATE_PRECISION));
const sameList = (a: readonly unknown[], b: readonly unknown[]): boolean => a.length === b.length && a.every((entry, index) => entry === b[index]);

export const useSatStore = defineStore(
  "sat",
  () => {
    const enabledComponents = ref<string[]>(["Point", "Label"]);
    // Bumped whenever the catalog changes so the UI can recompute catalog
    // queries reactively without putting the ~10k entries into Pinia. Not URL-synced.
    const catalogRevision = ref(0);
    const trackedSatellite = ref("");
    const overpassMode = ref("elevation");

    // Activation is one invariant cluster — see CONTEXT.md. Held privately and
    // exposed read-only so every writer goes through setActivation and the
    // three lists cannot drift out of step with each other.
    const tags = ref<string[]>([]);
    const satellites = ref<string[]>([]);
    // Names opted out of tag-activation (a satellite unchecked inside an
    // enabled group). Only meaningful while a covering group is enabled.
    const excluded = ref<string[]>([]);
    const stations = ref<SerializedGroundStation[]>([]);

    const enabledTags = computed(() => tags.value);
    const enabledSatellites = computed(() => satellites.value);
    const disabledSatellites = computed(() => excluded.value);
    const groundStations = computed(() => stations.value);

    /**
     * Commit a change to the activation triple. Duplicates are dropped and the
     * enabled/excluded lists are kept disjoint; an individual enable wins,
     * matching what clicking an already-excluded satellite means. Callers that
     * care about the other direction pass both lists explicitly.
     */
    function setActivation(patch: ActivationPatch): void {
      const nextTags = unique(patch.enabledTags ?? tags.value);
      const nextSatellites = unique(patch.enabledSatellites ?? satellites.value);
      const enabled = new Set(nextSatellites);
      const nextExcluded = unique(patch.disabledSatellites ?? excluded.value).filter((name) => !enabled.has(name));

      // Assigning an equal list would still fire $subscribe and land a history
      // entry, so compare before committing.
      if (!sameList(nextTags, tags.value)) {
        tags.value = nextTags;
      }
      if (!sameList(nextSatellites, satellites.value)) {
        satellites.value = nextSatellites;
      }
      if (!sameList(nextExcluded, excluded.value)) {
        excluded.value = nextExcluded;
      }
    }

    /** Drop unusable coordinates and duplicates before anything renders them. */
    function setGroundStations(next: readonly SerializedGroundStation[]): void {
      const seen = new Set<string>();
      const valid: SerializedGroundStation[] = [];
      for (const station of next) {
        if (!Number.isFinite(station.lat) || !Number.isFinite(station.lon)) {
          continue;
        }
        const lat = roundCoordinate(station.lat);
        const lon = roundCoordinate(station.lon);
        const key = `${lat}|${lon}|${station.name ?? ""}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        valid.push(station.name === undefined ? { lat, lon } : { lat, lon, name: station.name });
      }
      const unchanged =
        valid.length === stations.value.length &&
        valid.every((station, index) => {
          const current = stations.value[index];
          return current !== undefined && current.lat === station.lat && current.lon === station.lon && current.name === station.name;
        });
      if (!unchanged) {
        stations.value = valid;
      }
    }

    return {
      enabledComponents,
      catalogRevision,
      trackedSatellite,
      overpassMode,
      enabledTags,
      enabledSatellites,
      disabledSatellites,
      groundStations,
      setActivation,
      setGroundStations,
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
      // Guarded keys are read-only, so the url goes through the same actions as
      // every other writer. The triple is applied in one call to keep it atomic.
      apply(store, patch) {
        store.enabledComponents = patch.enabledComponents as string[];
        store.trackedSatellite = patch.trackedSatellite as string;
        store.overpassMode = patch.overpassMode as string;
        store.setActivation({
          enabledTags: patch.enabledTags as string[],
          enabledSatellites: patch.enabledSatellites as string[],
          disabledSatellites: patch.disabledSatellites as string[],
        });
        store.setGroundStations(patch.groundStations as SerializedGroundStation[]);
      },
    },
  },
);
