<!-- Language. A button rather than a menu: there are two of them, and a reader
     looking for their own language wants to cycle, not to choose from a list.

     Labelled in each language's own name, so it is findable from either side —
     the one control whose text must never be translated. -->
<template>
  <UTooltip :text="t('common.language')">
    <button type="button" class="cesium-button cesium-toolbar-button" @click="cycle">
      <UIcon name="lucide:languages" />
      <span class="localeToggle__label">{{ nextLabel }}</span>
    </button>
  </UTooltip>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import { LOCALE_LABEL, SUPPORTED_LOCALES, setLocale, type SupportedLocale } from "../i18n";

const { t, locale } = useI18n();

const next = computed<SupportedLocale>(() => {
  const at = SUPPORTED_LOCALES.indexOf(locale.value as SupportedLocale);
  return SUPPORTED_LOCALES[(at + 1) % SUPPORTED_LOCALES.length] as SupportedLocale;
});

// The *next* language's own name, not the current one: what the button offers is
// the switch, and a label reading the language you are already in looks broken.
const nextLabel = computed(() => LOCALE_LABEL[next.value]);

function cycle(): void {
  setLocale(next.value);
}
</script>

<style scoped>
.localeToggle__label {
  margin-left: 0.35em;
  font-size: 0.85em;
}
</style>
