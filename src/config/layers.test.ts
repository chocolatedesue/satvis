import { describe, expect, test } from "vitest";

import { type LayerAvailability, substituteUnavailable } from "./layers";

const availabilityOf =
  (present: boolean, fallback = "Offline") =>
  (provider: string): LayerAvailability | undefined =>
    provider === "OfflineHighres" ? { available: () => Promise.resolve(present), fallback } : undefined;

describe("substituteUnavailable", () => {
  test("leaves a usable stack alone", async () => {
    expect(await substituteUnavailable(["OfflineHighres", "Nextrad"], availabilityOf(true))).toBeUndefined();
  });

  test("providers that cannot be missing are never asked", async () => {
    expect(await substituteUnavailable(["ArcGis", "Tiles"], availabilityOf(false))).toBeUndefined();
  });

  test("replaces a missing provider and names it", async () => {
    expect(await substituteUnavailable(["OfflineHighres", "Nextrad"], availabilityOf(false))).toEqual({
      layers: ["Offline", "Nextrad"],
      replaced: ["OfflineHighres"],
    });
  });

  test("carries the opacity across the substitution", async () => {
    expect(await substituteUnavailable(["OfflineHighres_0.5"], availabilityOf(false))).toEqual({
      layers: ["Offline_0.5"],
      replaced: ["OfflineHighres"],
    });
  });

  test("an unusable token is left for the store to drop", async () => {
    expect(await substituteUnavailable(["", "OfflineHighres"], availabilityOf(false))).toEqual({
      layers: ["", "Offline"],
      replaced: ["OfflineHighres"],
    });
  });
});
