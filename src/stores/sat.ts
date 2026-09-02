import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { POINT_SIZES, SATELLITE_COMPONENTS, type PointSize } from "../config/components";
import { DEFAULT_POINT_PAINT, PANEL_AXES, POINT_COLOR_MODES, type PanelAxis, type PointColorMode } from "../config/illumination";
import { DEFAULT_PIPELINE_STAGES, PIPELINE_STAGE_CHOICES } from "../config/migration";
import { sameValue } from "../modules/util/equality";
import { boolean, closedStringList, enumString, groundStationList, numberChoice, plainString, stringList, tildeEscapedStringList } from "../modules/util/urlCodec";

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

export const useSatStore = defineStore(
  "sat",
  () => {
    const enabledComponents = ref<string[]>(["Point", "Label"]);
    // Bumped whenever the catalog changes so the UI can recompute catalog
    // queries reactively without putting the ~10k entries into Pinia. Not URL-synced.
    const catalogRevision = ref(0);
    const trackedSatellite = ref("");
    const overpassMode = ref("elevation");

    // The orbit lab: how points are coloured, under which solar-panel model, and
    // which Walker pattern is generated. Three free values rather than an
    // invariant cluster — each is meaningful on its own, and a paint mode with no
    // constellation to paint is a perfectly good state.
    //
    // `walker` is a *list* of whole patterns, each in Walker's own `i:T/P/F@alt`
    // notation (see modules/util/walkerDelta.ts). One string per pattern rather
    // than five numbers because five can arrive inconsistent with each other — a T
    // that does not fill P planes is not a constellation, and the url should not be
    // able to say it. A list rather than one, so a link can carry several
    // constellations at once and generating a second does not cost the first; the
    // wire form contains no comma, which is what lets the list be comma-joined.
    const pointColorMode = ref<PointColorMode>(DEFAULT_POINT_PAINT.mode);
    const pointSize = ref<PointSize>(DEFAULT_POINT_PAINT.size);
    const panelAxis = ref<PanelAxis>(DEFAULT_POINT_PAINT.panelAxis);
    const walker = ref<string[]>([]);

    // The naive KV-cache live-migration overlay: one workload hopping between
    // satellites as its host loses power. A free boolean rather than a satellite
    // component, because a migration is a relation between two satellites and
    // belongs to neither — see modules/MigrationLayer.ts. URL-synced so a link
    // can open straight into the migration demo.
    const migration = ref(false);

    // How many stages the migration demo's pipeline is cut into. URL-synced beside
    // `mig` because the stage count is the knob that changes what the demo argues:
    // one stage restates the fleet's dark fraction, four make the pipeline's
    // all-stages-at-once serving condition the thing you watch fail.
    const migrationStages = ref<number>(DEFAULT_PIPELINE_STAGES);

    // The stable-constellation link overlay: every generated Walker satellite
    // wired into the topology scripts/derive-isl-topology.mjs derived — rings
    // inside each plane, same-slot links between same-rotating planes, the
    // Walker Star seam dropped, nothing across shells. On by default: a
    // constellation without its topology is just points, and the whole reason
    // the patterns are drawn is to read how they hold together. `links=false`
    // in the url turns it off.
    const links = ref(true);

    // Marked satellites, as `<plane>-<slot>@<wire>` tokens (see
    // parseMarkToken). A marked cluster is the small fleet a viewer wants to
    // watch as a unit: each member gets a halo and its slot label, and every
    // pair is bonded with an amber link - including pairs the auto-topology
    // would never link, which is what makes a cross-shell cluster observable.
    const marks = ref<string[]>([]);

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

      if (!sameValue(nextTags, tags.value)) {
        tags.value = nextTags;
      }
      if (!sameValue(nextSatellites, satellites.value)) {
        satellites.value = nextSatellites;
      }
      if (!sameValue(nextExcluded, excluded.value)) {
        excluded.value = nextExcluded;
      }
    }

    /**
     * Which ground station the sky view stands at, by position in the list.
     *
     * A designation rather than a rule about the order. Entering the sky view from a
     * particular station then does not have to rearrange the list to say so.
     * Defaults to 0, which is what every existing link means and what the app did
     * when the first station was the observer by definition.
     *
     * Not url-synced: a link carries the stations and the view mode, and the
     * observer among them stays the first one. Adding a parameter for it would
     * extend the contract in docs/adr/0001, which is a separate decision.
     */
    const observer = ref(0);
    const observerStation = computed(() => Math.min(observer.value, Math.max(0, stations.value.length - 1)));

    /** Designate a station as the observer. An index past the end is ignored. */
    function setObserverStation(index: number): void {
      if (!Number.isInteger(index) || index < 0 || index >= stations.value.length) {
        return;
      }
      observer.value = index;
    }

    /**
     * A name the `gs` wire format can carry back.
     *
     * Stations are `_`-joined and their fields `,`-separated (ADR 0001), so either
     * character in a name breaks the round trip — and breaks it destructively: the
     * parser drops an entry with more than three fields, so "Munich, DE" does not come
     * back mis-parsed, it does not come back at all. Replaced rather than rejected,
     * because losing a comma is a smaller surprise than losing the station.
     */
    function wireSafeName(name: string | undefined): string | undefined {
      if (name === undefined) {
        return undefined;
      }
      const safe = name.replace(/[,_]/g, " ").replace(/\s+/g, " ").trim();
      return safe === "" ? undefined : safe;
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
        const name = wireSafeName(station.name);
        const key = `${lat}|${lon}|${name ?? ""}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        valid.push(name === undefined ? { lat, lon } : { lat, lon, name });
      }
      if (!sameValue(valid, stations.value)) {
        stations.value = valid;
      }
    }

    return {
      enabledComponents,
      catalogRevision,
      trackedSatellite,
      overpassMode,
      pointColorMode,
      pointSize,
      panelAxis,
      walker,
      migration,
      links,
      marks,
      migrationStages,
      enabledTags,
      enabledSatellites,
      disabledSatellites,
      groundStations,
      observerStation,
      setActivation,
      setGroundStations,
      setObserverStation,
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
        { name: "pointColorMode", url: "paint", kind: enumString(POINT_COLOR_MODES) },
        { name: "pointSize", url: "psize", kind: enumString(POINT_SIZES) },
        { name: "panelAxis", url: "panel", kind: enumString(PANEL_AXES) },
        { name: "walker", url: "walker", kind: stringList() },
        { name: "migration", url: "mig", kind: boolean() },
        { name: "migrationStages", url: "migst", kind: numberChoice(PIPELINE_STAGE_CHOICES) },
        { name: "links", url: "links", kind: boolean() },
        { name: "marks", url: "mark", kind: stringList() },
      ],
      // Guarded keys are read-only, so the url goes through the same actions as
      // every other writer; the triple is applied in one call to keep it
      // atomic. Naming only the guarded keys means adding a free parameter
      // needs no change here.
      apply(store, patch) {
        const { enabledTags, enabledSatellites, disabledSatellites, groundStations, ...free } = patch;
        Object.assign(store, free);
        store.setActivation({
          enabledTags: enabledTags as string[],
          enabledSatellites: enabledSatellites as string[],
          disabledSatellites: disabledSatellites as string[],
        });
        store.setGroundStations(groundStations as SerializedGroundStation[]);
      },
    },
  },
);
