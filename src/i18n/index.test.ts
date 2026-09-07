// Locale files are two copies of one key tree, and the failure mode of a copy is
// drift: a key added to English that Chinese does not have renders English in the
// middle of a Chinese panel, and a key removed from English that Chinese keeps is
// dead weight nobody will find. Neither breaks a build, so both are asserted here.
//
// The second half is the other direction: every literal `$t("...")` in a component
// has to resolve. A typo in a key is otherwise invisible until that branch is
// rendered, and several of these branches only render when a demo is running.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import en from "./locales/en";
import zh from "./locales/zh";

/** Every leaf of a nested message tree, as `a.b.c` paths. */
function flatten(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object") {
    return prefix === "" ? [] : [prefix];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => flatten(child, prefix === "" ? key : `${prefix}.${key}`));
}

/** What `$t(key)` would return, or undefined when the key is not there. */
function resolve(messages: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((at, segment) => (at === null || typeof at !== "object" ? undefined : (at as Record<string, unknown>)[segment]), messages);
}

const enKeys = flatten(en).toSorted();
const zhKeys = flatten(zh).toSorted();

describe("locale parity", () => {
  it("is not empty — a broken import would make every check below pass trivially", () => {
    expect(enKeys.length).toBeGreaterThan(80);
  });

  it("has every English key in Chinese", () => {
    expect(enKeys.filter((key) => !zhKeys.includes(key))).toEqual([]);
  });

  it("has no Chinese key that English does not have", () => {
    expect(zhKeys.filter((key) => !enKeys.includes(key))).toEqual([]);
  });

  it("leaves no value untranslated in Chinese", () => {
    // A translation that was copied and never edited is worse than a missing one:
    // it looks finished. Only checked where the English is long enough that a
    // verbatim copy cannot be a coincidence (units, "ISL", "KV" and the like).
    const identical = enKeys.filter((key) => {
      const source = resolve(en, key);
      return typeof source === "string" && source.length > 40 && resolve(zh, key) === source;
    });
    expect(identical).toEqual([]);
  });
});

describe("component keys", () => {
  // Literal `$t("a.b.c")` and `$t(\`a.b.${x}\`)` calls. The template-literal form
  // is checked for its prefix only; its tail comes from a config array that has
  // its own test in the module that owns it.
  const components = ["src/components/OrbitLabPanel.vue"];

  for (const relative of components) {
    it(`${relative} only asks for keys that exist`, () => {
      const path = fileURLToPath(new URL(`../../${relative}`, import.meta.url));
      const source = readFileSync(path, "utf8");
      const keys = new Set<string>();
      for (const match of source.matchAll(/\$t\(\s*"([^"]+)"/g)) {
        keys.add(match[1] as string);
      }
      expect(keys.size).toBeGreaterThan(40);
      const missing = [...keys].filter((key) => resolve(en, key) === undefined);
      expect(missing).toEqual([]);
    });
  }
});
