// The passes of whatever is selected. Module scope, like useSelectedEntity: one
// selection, and the producer has no component tree to hand them down.

import { readonly, ref } from "vue";

import type { TimeSpan } from "../modules/util/clockDeck";

const passes = ref<TimeSpan[]>([]);

/** Called again whenever prediction answers, which is late and more than once. */
export function setPassHighlights(next: readonly TimeSpan[]): void {
  passes.value = next.map((pass) => ({ start: pass.start, end: pass.end }));
}

export function clearPassHighlights(): void {
  if (passes.value.length > 0) {
    passes.value = [];
  }
}

export function usePassHighlights() {
  return { passes: readonly(passes) };
}
