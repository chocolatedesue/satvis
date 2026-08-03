<template>
  <UModal v-model:open="open" title="About Satvis" :ui="{ content: 'bg-[#303336]/95 text-[#edffff] divide-neutral-600 max-w-2xl', header: 'p-2 sm:px-3', body: 'p-3 sm:p-3' }">
    <UTooltip text="About">
      <!-- A real link that the dialog intercepts, rather than a button. Opening the
           dialog is what a click does, but /about is the same content as a page, so
           the href is honest — and it is the only thing in the rendered document
           that points there. Without it the page is reachable only by typing the
           url, which for anything crawling the app means not at all. Middle-click
           and "open in new tab" get the page, as they should. -->
      <a class="cesium-button cesium-toolbar-button" href="/about" aria-label="About Satvis" @click.prevent>
        <UIcon name="lucide:info" />
      </a>
    </UTooltip>
    <template #body>
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div v-if="content" class="about about--dialog" v-html="content"></div>
      <div v-else class="about about--dialog">
        <p v-if="failed">The about page could not be loaded. <a href="/about">Open it directly</a>.</p>
        <p v-else>Loading…</p>
      </div>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";

import "../css/about.css";

const open = ref(false);
const content = ref("");
const failed = ref(false);

/**
 * The about page is the one copy of this content, so the dialog reads it rather
 * than holding its own — a page that grows screenshots and interactive pieces can
 * do that without a second surface having to be taught about any of it.
 *
 * Only `#about-content` is lifted, which is what leaves the page free to carry
 * chrome (its back link, later a header) that has no business in a modal. Any
 * script the page picks up will not run here: `v-html` does not execute one, and
 * that is the deliberate limit of this arrangement — the dialog shows the page's
 * content, not the page.
 *
 * Fetched on first open rather than on mount, so nothing about drawing the globe
 * waits on it. `about.html` and not `/about`: that is the url workbox precached
 * (vite.config.ts globPatterns), so the request is answered from the cache and
 * works offline, where `/about` would miss the precache and 307 on the network.
 */
watch(open, async (isOpen) => {
  if (!isOpen || content.value || failed.value) {
    return;
  }
  try {
    const response = await fetch("about.html");
    if (!response.ok) {
      throw new Error(`about.html: ${response.status}`);
    }
    const main = new DOMParser().parseFromString(await response.text(), "text/html").getElementById("about-content");
    if (!main) {
      throw new Error("about.html has no #about-content");
    }
    content.value = main.innerHTML;
  } catch (error) {
    console.warn("Could not load the about content", error);
    failed.value = true;
  }
});
</script>
