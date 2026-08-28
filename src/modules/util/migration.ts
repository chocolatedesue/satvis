// A naive KV-cache live-migration model, free of Cesium and of satellite.js for
// the same reason src/modules/util/illumination.ts is: the physics answers a
// question (where should this pipeline stage's KV cache live, and what does moving
// it cost), the globe draws by that answer (src/modules/MigrationLayer.ts), and
// the panel reads it out — and none of the three should own the arithmetic.
//
// "Naive" is a deliberate scope, matching what LAB-47 asked for as its baseline: a
// single pipeline stage holds a KV cache on one satellite; the moment that host
// stops being able to power its compute (it enters the Earth's shadow, or its
// panel turns away from the sun — the `sunlit_back` state this whole fork exists
// to name), the stage is live-migrated to the nearest satellite that still has
// power, over one inter-satellite link. No handshake overlap, no incremental KV
// patching, no multi-hop routing, no contention for the link — those are the
// improvements the algorithm line (LAB-47/70) is for. This is the floor they
// improve on, and the thing the visual makes watchable.
//
// The unit here is metres and seconds, and the only frame assumption is that the
// two positions handed to `distanceKm` are in the *same* frame — the caller reads
// both from the same trajectory sampler at the same instant, so a fixed-frame pair
// and an inertial-frame pair both give the true chord between the satellites.

/** A position in whatever frame the caller is working in, in metres. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * A satellite that could host or receive the workload, at one instant.
 *
 * `hasPower` is the illumination question already answered: `sunlit_on` and
 * `sunlit_edge` are powered, everything else (umbra, penumbra, panel facing away)
 * is not. Folding it to a boolean here keeps this module free of the illumination
 * vocabulary — the caller maps the state, `noPower` is the shared definition.
 */
export interface MigrationHost {
  name: string;
  position: Vec3;
  hasPower: boolean;
}

/** km/s. Light in vacuum — the ISL propagation floor. */
export const SPEED_OF_LIGHT_KM_S = 299792.458;

/**
 * Whether an illumination state means the compute node cannot be powered.
 *
 * The one definition of "dark" shared with the panel's census: a node is powered
 * only when its panel is actually receiving sunlight (`sunlit_on` / `sunlit_edge`).
 * `sunlit_back` looks lit to an eclipse-only model and still has no power, which is
 * exactly the case a migration has to react to.
 */
export function noPower(state: string): boolean {
  return state !== "sunlit_on" && state !== "sunlit_edge";
}

/** The straight-line chord between two satellites, in km. */
export function distanceKm(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) / 1000;
}

/**
 * A point a fraction of the way from `a` to `b`, clamped to the segment.
 *
 * The packet's position while it is in flight. Clamped rather than extrapolated so
 * a fraction that overshoots by a frame draws the packet arrived, not past the
 * target.
 */
export function lerp(a: Vec3, b: Vec3, fraction: number): Vec3 {
  const t = Math.min(1, Math.max(0, fraction));
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

/** What a single transfer costs, broken into the two terms that make it up. */
export interface TransferCost {
  /** Time to push the bytes onto the link: KV size / bandwidth. */
  serializeSeconds: number;
  /** One-way light travel over the link's length. */
  propagationSeconds: number;
  /** The naive total — the two in series, no overlap. */
  totalSeconds: number;
}

/**
 * The cost of moving `kvGigabytes` over one `islGbps` link that is `linkKm` long.
 *
 * Naive on purpose: serialisation and propagation in series, once, with no
 * acknowledgement round trips and no overlap between sending and computing. For a
 * few GB over 100 Gbps the serialisation term dominates by orders of magnitude
 * (2 GB is 160 ms; 2000 km of propagation is 6.7 ms), which is itself the point —
 * the bottleneck is the KV cache size against the link, not the distance, and that
 * is what the algorithm work gets to attack.
 *
 * GB are gibi-agnostic here: 1 GB is taken as 8 gigabits, so GB × 8 / Gbps is
 * seconds directly. Close enough for a figure whose job is to show the order of
 * magnitude next to a moving dot.
 */
export function transferCost(kvGigabytes: number, islGbps: number, linkKm: number): TransferCost {
  const serializeSeconds = islGbps > 0 ? (kvGigabytes * 8) / islGbps : Infinity;
  const propagationSeconds = Math.max(0, linkKm) / SPEED_OF_LIGHT_KM_S;
  return { serializeSeconds, propagationSeconds, totalSeconds: serializeSeconds + propagationSeconds };
}

/**
 * The nearest powered satellite other than the source, or undefined if none is
 * lit.
 *
 * Nearest, because over one link the only thing the naive model can prefer is a
 * shorter transfer — and the chord is a stand-in for the real ISL, which does not
 * exist in this element set. A tie keeps the first seen, so the choice is
 * deterministic for a fixed candidate order.
 */
export function chooseTarget(source: MigrationHost, candidates: readonly MigrationHost[]): MigrationHost | undefined {
  let best: MigrationHost | undefined;
  let bestKm = Infinity;
  for (const candidate of candidates) {
    if (candidate.name === source.name || !candidate.hasPower) {
      continue;
    }
    const km = distanceKm(source.position, candidate.position);
    if (km < bestKm) {
      bestKm = km;
      best = candidate;
    }
  }
  return best;
}

/** What the model wants to happen to the workload right now. */
export interface MigrationDecision {
  action: "hold" | "migrate" | "stranded";
  /** Where to migrate, when `action` is `migrate`. */
  target?: MigrationHost;
  /** One line for the readout: why. */
  reason: string;
}

/**
 * Decide the fate of a workload currently hosted on `host`, given every satellite
 * that could take it.
 *
 * Three answers:
 * - `hold` — the host still has power; nothing to do.
 * - `migrate` — the host has gone dark and a lit neighbour exists; move there.
 * - `stranded` — the host has gone dark and *no* neighbour is lit either. The naive
 *   model has nowhere to go; the algorithm line's whole reason to exist. Named
 *   rather than folded into `hold` so the visual can say the workload is stuck
 *   rather than fine.
 *
 * The host is looked up by name in `hosts` so a caller can pass the live list and
 * a stale host name resolves to "gone" (stranded with no candidates) rather than a
 * crash.
 */
export function decideMigration(hostName: string | undefined, hosts: readonly MigrationHost[]): MigrationDecision {
  const host = hosts.find((candidate) => candidate.name === hostName);
  if (!host) {
    return { action: "stranded", reason: "No host holds the workload yet." };
  }
  if (host.hasPower) {
    return { action: "hold", reason: `${host.name} is powered — no migration needed.` };
  }
  const target = chooseTarget(host, hosts);
  if (!target) {
    return { action: "stranded", reason: `${host.name} lost power and no neighbour is lit — workload stranded.` };
  }
  return { action: "migrate", target, reason: `${host.name} lost power — migrating to ${target.name}.` };
}

/**
 * Which satellite should hold the workload when the demo starts.
 *
 * The powered satellite nearest the centre of the powered set is not worth
 * computing; the first powered one in the list is enough, and falls back to the
 * first host of all so the demo always has somewhere to begin. Deterministic for a
 * fixed order, which is what the browser check relies on.
 */
export function initialHost(hosts: readonly MigrationHost[]): MigrationHost | undefined {
  return hosts.find((host) => host.hasPower) ?? hosts[0];
}
