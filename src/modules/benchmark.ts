// Paste into browser console in a clean session without satellites visible
// This file is not bundled; it is intended to be pasted into the browser console.
declare global {
  interface Performance {
    memory?: { usedJSHeapSize: number };
  }
}

cc.enablePerformanceStats();
const satelliteTag = "Active";
const satelliteCounts = [0, 10, 50, 100, 500, 1000, 5000];
const componentTests = [
  ["Point"],
  ["Point", "Label"],
  ["Point", "Label", "Orbit"],
  ["Point", "Orbit"],
  // ["Point", "Label", "Orbit", "Orbit track"],
  // ["Point", "Label", "Orbit", "Orbit track", "Ground track", "Sensor cone"],
];

function sleep(s: number): Promise<void> {
  return new Promise((r) => {
    setTimeout(r, s * 1000);
  });
}

async function logPerformance(): Promise<void> {
  cc.performanceStats!.reset();
  // Wait for performance to settle and stats to be updated
  while (cc.performanceStats!.getStats().avgFps === 0) {
    // eslint-disable-next-line no-await-in-loop
    await sleep(1);
  }
  console.log(
    cc.performanceStats!.formatStats(),
    `Satellites: ${cc.sats.visibleSatellites.length.toString().padStart(5)}; Components: ${cc.sats.enabledComponents};`,
    `Memory: ${((performance.memory?.usedJSHeapSize || 0) / 1024 / 1024).toFixed(2)};`,
  );
}

async function test(): Promise<void> {
  for (const components of componentTests) {
    for (const satelliteCount of satelliteCounts) {
      // This file is pasted into the console, so it cannot import the store.
      // It drives the manager directly instead, which means it deliberately
      // bypasses the store — the next store change will overwrite the scene.
      const satellites = cc.sats.catalog
        .entriesWithTag(satelliteTag)
        .slice(0, satelliteCount)
        .map((entry) => entry.name);
      cc.sats.reconcile({
        enabledTags: [],
        enabledSatellites: satellites,
        disabledSatellites: [],
        components,
        groundStations: [],
        overpassMode: "elevation",
        trackedSatellite: "",
      });
      console.log(satellites, cc.sats.catalog.entriesWithTag(satelliteTag));

      // eslint-disable-next-line no-await-in-loop
      await logPerformance();
    }
    cc.sats.reconcile({ enabledTags: [], enabledSatellites: [], disabledSatellites: [], components: [], groundStations: [], overpassMode: "elevation", trackedSatellite: "" });
  }
}
test();
