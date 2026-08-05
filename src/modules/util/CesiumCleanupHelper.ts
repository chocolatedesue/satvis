import type { Viewer } from "@cesium/widgets";

import { CesiumCallbackHelper } from "./CesiumCallbackHelper";

/**
 * Cesium keeps a label's glyph billboards after the label is gone.
 *
 * `EntityCluster` pools label slots rather than releasing them: removing an
 * entity's label sets `show = false` and `text = ""` and parks the slot for
 * reuse. Blanking the text makes `LabelCollection` unbind every glyph, and
 * unbinding hides each glyph billboard and pushes it onto `_spareBillboards`
 * *without removing it from `_glyphBillboardCollection`*. So that collection is
 * left holding one billboard per glyph the scene ever drew, and pays to update
 * and render all of them every frame however few are shown.
 *
 * Measured: after one benchmark step at 5,000 labelled satellites, returning to
 * 74 satellites left 67,952 spare billboards in a collection of 68,703, and the
 * frame at 250 ms — 4 fps instead of 100, for the rest of the session. Draining
 * the pool put it back to 8.4 ms with nothing else changed.
 *
 * Upstream: https://github.com/CesiumGS/cesium/issues/7184
 */

/**
 * Below this the pool is left alone. Draining forces the glyph collection to
 * rebuild its vertex arrays, which is worth doing for the tens of thousands a
 * constellation leaves behind and not for the handful that selecting a single
 * satellite churns through.
 */
const SPARE_BILLBOARD_THRESHOLD = 100;

/** How deep the primitive tree is walked. The label collection sits three levels down. */
const MAX_DEPTH = 8;

/**
 * The Cesium internals this reaches for. None of them are in the public type
 * definitions and none of them are stable across versions — which is the whole
 * reason `#drain` shouts rather than skipping when one is missing. The previous
 * version of this file read `_billboardCollection`, renamed upstream to
 * `_glyphBillboardCollection`, and silently did nothing from then on.
 */
interface LabelCollectionInternals {
  _labels: unknown[];
  _spareBillboards?: unknown[];
  _glyphBillboardCollection?: { remove(billboard: unknown): boolean };
}

interface PrimitiveNode {
  _primitives?: unknown[];
  _labelCollection?: unknown;
  _labels?: unknown[];
}

/**
 * Every LabelCollection under `node`, found by walking rather than by index.
 *
 * The path used to be hard-coded as `_primitives[0]._primitives[0]._primitives[0]`,
 * which is where the entity cluster's collection happens to sit today. A walk
 * costs nothing at this size and survives the tree being re-nested; it also finds
 * the collections belonging to any additional data source, and draining those is
 * the intent either way.
 */
export function collectLabelCollections(node: unknown, found: LabelCollectionInternals[] = [], depth = 0): LabelCollectionInternals[] {
  if (!node || typeof node !== "object" || depth > MAX_DEPTH) {
    return found;
  }
  const candidate = node as PrimitiveNode;
  if (Array.isArray(candidate._labels)) {
    found.push(candidate as LabelCollectionInternals);
  }
  if (candidate._labelCollection) {
    collectLabelCollections(candidate._labelCollection, found, depth + 1);
  }
  if (Array.isArray(candidate._primitives)) {
    for (const child of candidate._primitives) {
      collectLabelCollections(child, found, depth + 1);
    }
  }
  return found;
}

export class CesiumCleanupHelper {
  /** So a broken assumption is reported once rather than on every reconcile. */
  static #reported = false;

  /**
   * Drain the leftover glyph billboards, on the next tick.
   *
   * Deferring is load-bearing rather than politeness: the labels are not unbound
   * when their entities are removed, they are unbound when `LabelCollection.update`
   * next runs, so there is nothing in the pool to drain until a frame has passed.
   *
   * Safe to call after any teardown — below the threshold it does nothing, which
   * is what makes "whenever the active set shrank" an affordable trigger.
   */
  static cleanup(viewer: Viewer): void {
    const stop = CesiumCallbackHelper.createPeriodicTickCallback(viewer, 1, () => {
      stop();
      CesiumCleanupHelper.drain(viewer);
    });
  }

  /** The drain itself, without the tick deferral. Exported for the unit test. */
  static drain(viewer: Viewer): number {
    const collections = collectLabelCollections(viewer.scene.primitives);
    if (collections.length === 0) {
      // Not a problem, and not evidence of a rename: `EntityCluster` creates its
      // label collection on the first label, so a scene that has only ever drawn
      // points legitimately has none. Reporting it here cried wolf on the
      // commonest scene there is. A collection that exists but cannot be read is
      // the case worth shouting about, and both this and `#trim` still do that.
      return 0;
    }

    let removed = 0;
    for (const collection of collections) {
      const spares = collection._spareBillboards;
      const billboards = collection._glyphBillboardCollection;
      if (!spares || !billboards) {
        CesiumCleanupHelper.#report("LabelCollection has no _spareBillboards / _glyphBillboardCollection");
        continue;
      }
      if (spares.length < SPARE_BILLBOARD_THRESHOLD) {
        continue;
      }
      // Removing a billboard destroys it, so the pool has to be emptied in the
      // same breath — a destroyed billboard handed back out to a new glyph is
      // worse than the leak.
      spares.forEach((billboard) => billboards.remove(billboard));
      removed += spares.length;
      spares.length = 0;
    }

    if (removed > 0) {
      // Says how many, because the version that logged unconditionally read as
      // working for as long as it was doing nothing at all.
      console.info(`Removed ${removed} leftover Cesium glyph billboards`);
      viewer.scene.requestRender();
    }
    return removed;
  }

  /**
   * Loud, because the failure this guards against is invisible: a renamed
   * internal turns the drain into a no-op, and the only symptom is that the app
   * gets slower after having shown a lot of labels.
   */
  static #report(problem: string): void {
    if (CesiumCleanupHelper.#reported) {
      return;
    }
    CesiumCleanupHelper.#reported = true;
    console.error(`Cannot drain leftover Cesium glyph billboards: ${problem}. Cesium internals have moved — see CesiumCleanupHelper.`);
  }

  /** Test seam: the once-only report is process state, so it has to be resettable. */
  static resetReported(): void {
    CesiumCleanupHelper.#reported = false;
  }
}
