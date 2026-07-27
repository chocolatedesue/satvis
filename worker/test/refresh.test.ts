import { describe, expect, it, vi } from "vitest";

import type { FetchImpl } from "../src/gp/evaluate.ts";
import { refreshGroups } from "../src/gp/refresh.ts";
import type { GroupStore, GroupWriteMetadata } from "../src/gp/store.ts";
import type { GpRecord, GroupsConfig, GroupsIndex, OmmRecord } from "../src/gp/types.ts";

// The refresh pipeline against an in-memory GroupStore adapter — the same
// contract the KV and disk adapters implement, without either runtime.
function memoryStore(previous: GroupsIndex = { updated: "", groups: [] }) {
  const groups = new Map<string, { records: GpRecord[]; metadata: GroupWriteMetadata }>();
  let index: GroupsIndex | undefined;
  const store: GroupStore = {
    async readIndex() {
      return previous;
    },
    async writeGroup(name, records, metadata) {
      groups.set(name, { records, metadata });
    },
    async writeIndex(newIndex) {
      index = newIndex;
    },
  };
  return { store, groups, index: () => index };
}

const CONFIG: GroupsConfig = { groups: [{ name: "stations", sources: [{ celestrak: "stations" }] }] };

function okFetch(records: unknown[]): FetchImpl {
  return async () => ({ status: 200, text: async () => JSON.stringify(records) });
}

const failingFetch: FetchImpl = async () => ({ status: 500, text: async () => "upstream error" });

describe("refreshGroups", () => {
  it("writes evaluated groups and the rebuilt index through the store", async () => {
    const { store, groups, index } = memoryStore();
    const report = await refreshGroups(CONFIG, store, okFetch([{ OBJECT_NAME: "ISS (ZARYA)", NORAD_CAT_ID: 25544 }]));

    expect(report.written).toBe(1);
    expect(report.skipped).toBe(0);

    const written = groups.get("stations");
    expect(written).toBeDefined();
    expect(written!.records).toHaveLength(1);
    expect(written!.metadata.count).toBe(1);
    expect(written!.metadata.updated).toBe(report.index.updated);

    expect(index()).toEqual(report.index);
    expect(report.index.groups).toEqual([expect.objectContaining({ name: "stations", count: 1, updated: report.index.updated })]);
  });

  it("keeps last-known-good when a source fails: no write, index carries the old status", async () => {
    const previous: GroupsIndex = {
      updated: "2026-07-01T00:00:00.000Z",
      groups: [{ name: "stations", updated: "2026-07-01T00:00:00.000Z", count: 5 }],
    };
    const { store, groups, index } = memoryStore(previous);
    const report = await refreshGroups(CONFIG, store, failingFetch);

    expect(report.written).toBe(0);
    expect(report.skipped).toBe(1);
    expect(groups.size).toBe(0);

    const status = index()!.groups[0]!;
    expect(status.name).toBe("stations");
    expect(status.updated).toBe("2026-07-01T00:00:00.000Z");
    expect(status.count).toBe(5);
    expect(status.lastError).toBeTruthy();
  });

  it("attaches satellite-table metadata to the records it writes", async () => {
    const config: GroupsConfig = {
      ...CONFIG,
      satellites: [{ noradId: 25544, name: "ISS", metadata: { swathStarboardKm: 205, swathPortKm: 205 } }],
    };
    const { store, groups } = memoryStore();
    await refreshGroups(
      config,
      store,
      okFetch([
        { OBJECT_NAME: "ISS (ZARYA)", NORAD_CAT_ID: 25544 },
        { OBJECT_NAME: "CSS (TIANHE)", NORAD_CAT_ID: 48274 },
      ]),
    );

    const written = groups.get("stations")!.records as OmmRecord[];
    expect(written[0]!.metadata).toEqual({ swathStarboardKm: 205, swathPortKm: 205 });
    // Unlisted satellites carry no metadata key at all — the frontend defaults
    // them, so a default bag on every record would be pure payload weight.
    expect(written[1]).not.toHaveProperty("metadata");
  });

  it("warns about a table entry that matched no record, but not about a decayed one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config: GroupsConfig = {
      ...CONFIG,
      satellites: [
        { noradId: 99999, name: "GONE", metadata: { coneFovDeg: 12 } },
        { noradId: 51036, name: "FOREST-1", decayed: true, metadata: { coneFovDeg: 12 } },
      ],
    };
    const { store } = memoryStore();
    await refreshGroups(config, store, okFetch([{ OBJECT_NAME: "ISS (ZARYA)", NORAD_CAT_ID: 25544 }]));

    const messages = warn.mock.calls.map((call) => String(call[0]));
    expect(messages.some((m) => m.includes("99999") && m.includes("matched no record in any group"))).toBe(true);
    expect(messages.some((m) => m.includes("51036"))).toBe(false);
    warn.mockRestore();
  });
});
