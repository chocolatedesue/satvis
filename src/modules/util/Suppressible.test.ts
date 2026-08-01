// The suppression rule, pinned once.
//
// It was written three times — the terrain a surface model imposes, the camera
// mode the sky view takes over, and the components a morph hides — and tested
// none of them, because all three lived on classes that needed a live Viewer.
// Nothing here does.

import { describe, expect, test } from "vitest";

import { Suppressible, SuppressibleSet } from "./Suppressible";

function recorder() {
  const applied: string[] = [];
  return { applied, apply: (value: string) => void applied.push(value) };
}

describe("Suppressible", () => {
  test("the initial value is not applied — it is what the world already shows", () => {
    const { applied } = recorder();
    const setting = new Suppressible<string>("None", () => {});

    expect(setting.chosen).toBe("None");
    expect(setting.inForce).toBe("None");
    expect(applied).toEqual([]);
  });

  test("choosing applies, and choosing the same value again does not", () => {
    const { applied, apply } = recorder();
    const setting = new Suppressible<string>("None", apply);

    expect(setting.choose("Maptiler")).toBe(true);
    expect(setting.choose("Maptiler")).toBe(false);

    expect(applied).toEqual(["Maptiler"]);
  });

  test("a suppression wins without touching the choice underneath", () => {
    const { applied, apply } = recorder();
    const setting = new Suppressible<string>("None", apply);
    setting.choose("Maptiler");

    setting.suppress("CesiumWorldTerrain");

    // What the toolbar says, and what is drawn.
    expect(setting.chosen).toBe("Maptiler");
    expect(setting.inForce).toBe("CesiumWorldTerrain");
    expect(setting.suppressed).toBe(true);
    expect(applied).toEqual(["Maptiler", "CesiumWorldTerrain"]);
  });

  test("choosing under a suppression records but does not apply", () => {
    const { applied, apply } = recorder();
    const setting = new Suppressible<string>("None", apply);
    setting.suppress("CesiumWorldTerrain");

    expect(setting.choose("ReEarth")).toBe(false);

    expect(setting.chosen).toBe("ReEarth");
    expect(setting.inForce).toBe("CesiumWorldTerrain");
    // No fetch for a provider nothing is going to show.
    expect(applied).toEqual(["CesiumWorldTerrain"]);
  });

  test("release brings back the choice made during the suppression", () => {
    const { applied, apply } = recorder();
    const setting = new Suppressible<string>("None", apply);
    setting.suppress("CesiumWorldTerrain");
    setting.choose("ReEarth");

    expect(setting.release()).toBe(true);

    expect(setting.inForce).toBe("ReEarth");
    expect(applied).toEqual(["CesiumWorldTerrain", "ReEarth"]);
  });

  test("releasing when nothing is suppressed changes nothing", () => {
    const { applied, apply } = recorder();
    const setting = new Suppressible<string>("None", apply);

    expect(setting.release()).toBe(false);
    expect(applied).toEqual([]);
  });

  test("suppressing with the value already in force still applies nothing", () => {
    const { applied, apply } = recorder();
    const setting = new Suppressible<string>("None", apply);

    // The override equals the choice, so nothing on screen changes — but the
    // setting is suppressed, and a later choose must not take effect.
    expect(setting.suppress("None")).toBe(false);
    expect(setting.suppressed).toBe(true);
    expect(setting.choose("Maptiler")).toBe(false);
    expect(applied).toEqual([]);

    expect(setting.release()).toBe(true);
    expect(applied).toEqual(["Maptiler"]);
  });

  test("a slow apply that resolves after a newer one knows it is stale", async () => {
    const landed: string[] = [];
    const gates: Array<() => void> = [];
    const setting = new Suppressible<string>("None", async (value, isCurrent) => {
      await new Promise<void>((resolve) => gates.push(resolve));
      if (!isCurrent()) {
        return;
      }
      landed.push(value);
    });

    setting.choose("Maptiler");
    setting.choose("ReEarth");

    // The first apply resolves last — the out-of-order case that selecting a
    // surface model creates, since it overrides the terrain in the same tick.
    gates[1]?.();
    gates[0]?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(landed).toEqual(["ReEarth"]);
  });

  test("the camera mode's shape: suppression is an override with Fixed", () => {
    const { applied, apply } = recorder();
    const camera = new Suppressible<string>("Fixed", apply);
    camera.choose("Inertial");

    camera.suppress("Fixed");
    expect(camera.inForce).toBe("Fixed");
    // `?camera=Inertial` has to survive the round trip.
    expect(camera.chosen).toBe("Inertial");

    camera.release();
    expect(camera.inForce).toBe("Inertial");
    expect(applied).toEqual(["Inertial", "Fixed", "Inertial"]);
  });
});

describe("SuppressibleSet", () => {
  function setRecorder() {
    const shown: string[] = [];
    const hidden: string[] = [];
    return {
      shown,
      hidden,
      apply: ({ show, hide }: { show: string[]; hide: string[] }) => {
        shown.push(...show);
        hidden.push(...hide);
      },
    };
  }

  test("choosing shows only what is new and hides only what went away", () => {
    const { shown, hidden, apply } = setRecorder();
    const components = new SuppressibleSet(apply);

    components.choose(["Point", "Label"]);
    expect(shown).toEqual(["Point", "Label"]);

    shown.length = 0;
    components.choose(["Point", "Orbit"]);

    // Point was already on and is left alone; only the difference is enacted.
    expect(shown).toEqual(["Orbit"]);
    expect(hidden).toEqual(["Label"]);
  });

  test("suppressing hides a member without removing the user's choice", () => {
    const { hidden, apply } = setRecorder();
    const components = new SuppressibleSet(apply);
    components.choose(["Point", "Orbit"]);

    expect(components.suppress("Orbit")).toBe(true);

    expect(hidden).toEqual(["Orbit"]);
    expect(components.inForce).toEqual(["Point"]);
    // The toolbar still shows Orbit switched on.
    expect(components.chosen).toEqual(["Point", "Orbit"]);
  });

  test("suppressing something the user does not have on does nothing", () => {
    const { hidden, apply } = setRecorder();
    const components = new SuppressibleSet(apply);
    components.choose(["Point"]);

    // The morph asks whether it actually suppressed anything, and only waits for
    // the batch if it did.
    expect(components.suppress("Orbit")).toBe(false);
    expect(hidden).toEqual([]);
  });

  test("release brings a member back", () => {
    const { shown, apply } = setRecorder();
    const components = new SuppressibleSet(apply);
    components.choose(["Point", "Orbit"]);
    components.suppress("Orbit");
    shown.length = 0;

    expect(components.release("Orbit")).toBe(true);
    expect(shown).toEqual(["Orbit"]);
  });

  test("a member switched off while suppressed does not come back on release", () => {
    const { shown, apply } = setRecorder();
    const components = new SuppressibleSet(apply);
    components.choose(["Point", "Orbit"]);
    components.suppress("Orbit");
    components.choose(["Point"]);
    shown.length = 0;

    components.release("Orbit");

    expect(shown).toEqual([]);
    expect(components.inForce).toEqual(["Point"]);
  });

  test("a member switched on while suppressed stays hidden until release", () => {
    const { shown, apply } = setRecorder();
    const components = new SuppressibleSet(apply);
    components.choose(["Point"]);
    components.suppress("Point");
    components.choose(["Point", "Orbit"]);

    expect(components.inForce).toEqual(["Orbit"]);

    shown.length = 0;
    components.release("Point");
    expect(shown).toEqual(["Point"]);
  });
});
