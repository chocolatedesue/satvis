import { describe, expect, test } from "vitest";

import { sanitizePostHogEvent, sanitizePostHogUrl } from "./posthogPrivacy";

describe("sanitizePostHogUrl", () => {
  test("removes every decimal place from ground-station coordinates", () => {
    expect(sanitizePostHogUrl("https://satvis.space/?gs=41.3843,2.0445_-33.4129,149.6128,Park&scene=2D")).toBe("https://satvis.space/?gs=41,2_-33,149,Park&scene=2D");
  });

  test("handles coordinates whose integer part is omitted", () => {
    expect(sanitizePostHogUrl("https://satvis.space/?gs=.125,-.875")).toBe("https://satvis.space/?gs=0,-0");
  });

  test("preserves decimals outside the ground-station parameter", () => {
    expect(sanitizePostHogUrl("https://satvis.space/?layers=ArcGis_0.5&gs=41.3843,2.0445&pixelratio=1.25")).toBe("https://satvis.space/?layers=ArcGis_0.5&gs=41,2&pixelratio=1.25");
  });

  test("leaves URLs without ground stations unchanged", () => {
    const url = "https://satvis.space/?scene=3D&layers=ArcGis_0.5";
    expect(sanitizePostHogUrl(url)).toBe(url);
  });
});

describe("sanitizePostHogEvent", () => {
  test("sanitizes URL values in event and person properties", () => {
    const event = {
      event: "$pageview",
      properties: {
        $current_url: "https://satvis.space/?gs=41.3843,2.0445",
        $referrer: "https://satvis.space/?gs=-33.4129,149.6128",
        build_sha: "1.23",
      },
      $set: { $session_entry_url: "https://satvis.space/?gs=52.4301,-1.4798" },
      $set_once: { $initial_current_url: "https://satvis.space/?gs=38.7665,-9.1717" },
    };

    expect(sanitizePostHogEvent(event)).toEqual({
      event: "$pageview",
      properties: {
        $current_url: "https://satvis.space/?gs=41,2",
        $referrer: "https://satvis.space/?gs=-33,149",
        build_sha: "1.23",
      },
      $set: { $session_entry_url: "https://satvis.space/?gs=52,-1" },
      $set_once: { $initial_current_url: "https://satvis.space/?gs=38,-9" },
    });
  });
});
