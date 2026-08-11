// framePump — frames for a page the browser has stopped presenting.
//
// Chrome suspends `requestAnimationFrame` in a hidden page, and an automated
// browser pane is hidden for its whole life. Nothing paced per frame runs there:
// no render loop, so no globe, and no satellites either, because the build
// re-arms itself through rAF between budgets. Measured: no rAF callback in 1.5 s,
// and a scene stuck at zero satellites indefinitely.
//
// `?framepump=1` supplies the frames instead, from a MessageChannel — the one
// scheduler a hidden page does not throttle, where `setTimeout` is clamped to a
// second. `installBenchmark` loads it, so a normal visitor never fetches it.
//
// It does not make this a normal page: frames come at a fixed interval of the
// pump's choosing, so `fps` and `frameMs` measure the pump rather than a display.
// Read `cpuMs` and `tickMs`, and see this directory's README before quoting any
// of them.

import type { Viewer } from "@cesium/widgets";

/** Stands in for a 60 Hz display. */
const DEFAULT_FRAME_MS = 16;

/**
 * Presence is enough. The value is read only so that `?framepump=false` can turn
 * it off in a url being reused.
 */
export function framePumpRequested(search: string): boolean {
  const value = new URLSearchParams(search).get("framepump");
  if (value === null) {
    return false;
  }
  return value !== "false" && value !== "0";
}

/** `?framems=`, in milliseconds, for pacing a run off 60 Hz. */
export function framePumpFrameMs(search: string): number {
  const value = Number(new URLSearchParams(search).get("framems"));
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_FRAME_MS;
}

export interface FrameQueue {
  request(callback: FrameRequestCallback): number;
  cancel(handle: number): void;
  /** Run everything queued if a frame is due. Returns whether it ran one. */
  runDue(): boolean;
}

/**
 * The callback queue behind the replacement `requestAnimationFrame`. Separate
 * from the installation so it can be tested without a browser, and because the
 * two rules in it are the whole of the correctness here:
 *
 * - Due callbacks are taken before any of them runs. Cesium's render loop asks
 *   for the next frame from inside the current one, so a queue read as it is
 *   drained would recurse until the stack gave out.
 * - One callback throwing does not cost the others their frame. A pump that
 *   stops at the first bad callback stops the app, which is the failure this
 *   module exists to avoid.
 */
export function frameQueue(frameMs: number, now: () => number): FrameQueue {
  let entries: Array<{ handle: number; callback: FrameRequestCallback }> = [];
  let nextHandle = 1;
  let lastFrame = Number.NEGATIVE_INFINITY;

  return {
    request(callback) {
      const handle = nextHandle;
      nextHandle += 1;
      entries.push({ handle, callback });
      return handle;
    },
    cancel(handle) {
      entries = entries.filter((entry) => entry.handle !== handle);
    },
    runDue() {
      const timestamp = now();
      if (timestamp - lastFrame < frameMs) {
        return false;
      }
      lastFrame = timestamp;
      const due = entries;
      entries = [];
      for (const entry of due) {
        try {
          entry.callback(timestamp);
        } catch (error) {
          console.error("[framePump] a frame callback threw", error);
        }
      }
      return true;
    },
  };
}

let uninstall: (() => void) | undefined;

/**
 * Take over the frame loop. Returns the undo, or undefined when the query string
 * did not ask or a pump is already running.
 *
 * The viewer's own loop is switched off rather than restarted, and this drives
 * `resize` and `render` in its place — Cesium's documented manual-loop mode, and
 * the only thing that works here. Toggling `useDefaultRenderLoop` looks like it
 * should be enough and is a no-op: the setter starts a loop only when one is not
 * already flagged as running, and a loop whose callback was suspended rather
 * than cancelled never cleared that flag.
 */
export function installFramePumpIfRequested(viewer: Viewer, search: string): (() => void) | undefined {
  if (uninstall || !framePumpRequested(search)) {
    return undefined;
  }

  const queue = frameQueue(framePumpFrameMs(search), () => performance.now());
  const nativeRequest = window.requestAnimationFrame.bind(window);
  const nativeCancel = window.cancelAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) => queue.request(callback);
  window.cancelAnimationFrame = (handle) => queue.cancel(handle);

  viewer.useDefaultRenderLoop = false;

  let running = true;
  let warnedAboutSize = false;
  const channel = new MessageChannel();
  const pump = (): void => {
    if (!running) {
      return;
    }
    if (queue.runDue()) {
      try {
        viewer.resize();
        viewer.render();
        // A canvas with no size is the other way to draw nothing, and a silent
        // one: `render` returns having done nothing and every row comes back
        // zero. A pane that has not laid its tab out arrives here, and only a
        // resize or a screenshot gets it out — neither of which this can do.
        if (!warnedAboutSize && viewer.scene.canvas.clientWidth === 0) {
          warnedAboutSize = true;
          console.warn("[framePump] the canvas is 0 px wide, so nothing is being drawn and every measurement will be zero. Give the page a viewport.");
        }
      } catch (error) {
        console.error("[framePump] the render threw; stopping", error);
        running = false;
        return;
      }
    }
    channel.port2.postMessage(0);
  };
  // `addEventListener` needs the explicit `start`; assigning `onmessage` would
  // have started the port for us.
  channel.port1.addEventListener("message", pump);
  channel.port1.start();
  channel.port2.postMessage(0);

  console.log(`[framePump] driving frames every ${framePumpFrameMs(search)} ms — fps and frameMs are this pump, not a display`);

  uninstall = () => {
    running = false;
    channel.port1.removeEventListener("message", pump);
    channel.port1.close();
    window.requestAnimationFrame = nativeRequest;
    window.cancelAnimationFrame = nativeCancel;
    viewer.useDefaultRenderLoop = true;
    uninstall = undefined;
  };
  return uninstall;
}
