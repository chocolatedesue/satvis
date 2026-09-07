<!-- The orbit lab: generate a Walker pattern, and read what the sun is doing to
     it.

     One panel for two things because they are one workflow — a synthetic
     constellation exists to be analysed, and the analysis needs something with a
     known geometry to be checked against. Both halves also work alone: the
     illumination half colours the real catalog, and the generator half is just a
     constellation.

     The sections are collapsible because the panel is not one control but
     nine: a reader who came to generate a pattern does not want the migration
     ledger in the way, and a reader who came for the ledger does not want the
     form. Grouping them also gives each one a heading it did not have — the
     generator's own fields used to sit, unlabelled, between two unrelated
     sections. Only the first group opens itself; the rest announce themselves
     and stay out of the way. -->
<template>
  <div class="orbitLab">
    <details class="orbitLab__group" open>
      <summary class="orbitLab__summary">{{ $t("orbitLab.group.constellation") }}</summary>
      <div class="orbitLab__body">
        <p class="orbitLab__note" v-html="$t('orbitLab.pattern.intro')"></p>

        <div class="orbitLab__radios">
          <label v-for="mode in CAMERA_MODES" :key="mode" class="toolbarSwitch">
            <input type="radio" name="orbitLabCameraMode" :value="mode" :checked="cameraMode === mode" @change="cameraMode = mode" />
            <span class="slider"></span>
            {{ $t(`labels.cameraMode.${mode}`) }}
          </label>
        </div>
        <p class="orbitLab__note" v-html="$t('orbitLab.camera.note')"></p>

        <label class="orbitLab__field">
          <span>{{ $t("orbitLab.form.preset") }}</span>
          <select class="orbitLab__preset" :value="presetIndex" @change="applyPreset(Number(($event.target as HTMLSelectElement).value))">
            <option :value="-1">{{ $t("common.custom") }}</option>
            <option v-for="(preset, index) in WALKER_PRESETS" :key="preset.label" :value="index">{{ preset.label }}</option>
          </select>
        </label>
        <p v-if="presetNote" class="orbitLab__note">{{ presetNote }}</p>

        <div class="orbitLab__grid">
          <label class="orbitLab__field">
            <span>{{ $t("orbitLab.form.total") }}</span>
            <input v-model.number="draft.total" type="number" min="1" :max="MAX_WALKER_SATELLITES" step="1" />
          </label>
          <label class="orbitLab__field">
            <span>{{ $t("orbitLab.form.planes") }}</span>
            <input v-model.number="draft.planes" type="number" min="1" step="1" />
          </label>
          <label class="orbitLab__field">
            <span>{{ $t("orbitLab.form.phasing") }}</span>
            <input v-model.number="draft.phasing" type="number" min="0" step="1" />
          </label>
          <label class="orbitLab__field">
            <span>{{ $t("orbitLab.form.inclination") }}</span>
            <input v-model.number="draft.inclinationDeg" type="number" min="0" max="180" step="0.1" />
          </label>
          <label class="orbitLab__field">
            <span>{{ $t("orbitLab.form.altitude") }}</span>
            <input v-model.number="draft.altitudeKm" type="number" min="150" step="10" />
          </label>
          <label class="orbitLab__field">
            <span>{{ $t("orbitLab.form.raanSpan") }}</span>
            <input v-model.number="draft.raanSpanDeg" type="number" min="1" max="360" step="1" />
          </label>
        </div>

        <p class="orbitLab__derived">
          {{ $t("orbitLab.form.derived", { perPlane, period: periodMinutes, meanMotion }) }}
          <template v-if="draft.raanSpanDeg === 180">{{ $t("orbitLab.form.walkerStar") }}</template>
        </p>
        <p v-if="validation.error" class="orbitLab__error">{{ validation.error }}</p>

        <div class="orbitLab__actions">
          <button type="button" class="orbitLab__button" :disabled="!validation.ok" :title="$t('orbitLab.form.showOnlyTitle', { wire })" @click="generate">
            {{ patterns.length === 1 && patterns[0] === wire ? $t("orbitLab.form.regenerate") : $t("orbitLab.form.showOnly") }}
          </button>
          <button type="button" class="orbitLab__button" :disabled="!validation.ok || patterns.includes(wire)" :title="$t('orbitLab.form.addTitle', { wire })" @click="addPattern">
            {{ $t("orbitLab.form.add") }}
          </button>
          <button type="button" class="orbitLab__button" :disabled="!walkerActive" @click="clear">{{ $t("orbitLab.form.hideAll") }}</button>
        </div>

        <template v-if="patterns.length > 0">
          <div class="toolbarTitle">{{ $t("orbitLab.group.patterns") }}</div>
          <ul class="orbitLab__patterns">
            <li v-for="pattern in patterns" :key="pattern">
              <button
                type="button"
                class="orbitLab__patternName"
                :class="{ 'orbitLab__patternName--off': !isShown(pattern) }"
                :title="isShown(pattern) ? $t('orbitLab.patterns.stopDrawing') : $t('orbitLab.patterns.draw')"
                @click="toggleShown(pattern)"
              >
                <code>{{ pattern }}</code>
              </button>
              <button type="button" class="orbitLab__patternDrop" :title="$t('orbitLab.patterns.load')" @click="loadIntoForm(pattern)">
                {{ $t("orbitLab.patterns.edit") }}
              </button>
              <button type="button" class="orbitLab__patternDrop" :title="$t('orbitLab.patterns.forget')" @click="dropPattern(pattern)">×</button>
            </li>
          </ul>
          <p class="orbitLab__note">
            {{ $t("orbitLab.patterns.note") }}
            <code>?walker={{ patterns.join(",") }}</code>
          </p>
        </template>
      </div>
    </details>

    <details class="orbitLab__group">
      <summary class="orbitLab__summary">{{ $t("orbitLab.group.demos") }}</summary>
      <div class="orbitLab__body">
        <button type="button" class="orbitLab__button orbitLab__button--wide" @click="twoOrbitDemo">{{ $t("orbitLab.demos.twoOrbit") }}</button>
        <p class="orbitLab__note" v-html="$t('orbitLab.demos.twoOrbitNote', { multiplier: DEMO_MULTIPLIER, seconds: demoOrbitSeconds })"></p>
        <p class="orbitLab__note" v-html="$t('orbitLab.demos.penumbraNote')"></p>
        <p class="orbitLab__note" v-html="$t('orbitLab.demos.arcNote')"></p>

        <button type="button" class="orbitLab__button orbitLab__button--wide" @click="sunSyncDemo">{{ $t("orbitLab.demos.sunSync") }}</button>
        <p class="orbitLab__note" v-html="$t('orbitLab.demos.sunSyncNote', { altitude: alwaysSunlitAltitude })"></p>

        <button type="button" class="orbitLab__button orbitLab__button--wide" @click="shellsDemo">{{ $t("orbitLab.demos.shells") }}</button>
        <p class="orbitLab__note" v-html="$t('orbitLab.demos.shellsNote', { multiplier: SHELLS_MULTIPLIER })"></p>

        <label class="toolbarSwitch">
          <input type="checkbox" :checked="links" @change="links = ($event.target as HTMLInputElement).checked" />
          <span class="slider"></span>
          {{ $t("orbitLab.links.label") }}
        </label>
        <p class="orbitLab__note" v-html="$t('orbitLab.links.note')"></p>
      </div>
    </details>

    <details class="orbitLab__group" :open="hasCluster">
      <summary class="orbitLab__summary">{{ $t("orbitLab.group.formationCloseUp") }}</summary>
      <div class="orbitLab__body">
        <formation-view v-if="hasCluster" />
        <p v-else class="orbitLab__note">{{ $t("orbitLab.cluster.empty") }}</p>
      </div>
    </details>

    <details class="orbitLab__group">
      <summary class="orbitLab__summary">{{ $t("orbitLab.group.formation") }}</summary>
      <div class="orbitLab__body">
        <label class="orbitLab__field">
          <span>{{ $t("orbitLab.cluster.preset") }}</span>
          <select class="orbitLab__preset" :value="clusterPresetIndex" @change="applyClusterPreset(Number(($event.target as HTMLSelectElement).value))">
            <option :value="-1">{{ $t("common.custom") }}</option>
            <option v-for="(preset, index) in CLUSTER_PRESETS" :key="preset.label" :value="index">{{ preset.label }}</option>
          </select>
        </label>
        <p v-if="clusterPresetNote" class="orbitLab__note">{{ clusterPresetNote }}</p>

        <div class="orbitLab__grid">
          <label class="orbitLab__field">
            <span>{{ $t("orbitLab.cluster.rings") }}</span>
            <input v-model.number="clusterDraft.rings" type="number" min="1" step="1" />
          </label>
          <label class="orbitLab__field">
            <span>{{ $t("orbitLab.cluster.pitch") }}</span>
            <input v-model.number="clusterDraft.pitchM" type="number" min="1" step="10" />
          </label>
          <label class="orbitLab__field">
            <span>{{ $t("orbitLab.cluster.inclination") }}</span>
            <input v-model.number="clusterDraft.inclinationDeg" type="number" min="0" max="180" step="0.01" />
          </label>
          <label class="orbitLab__field">
            <span>{{ $t("orbitLab.cluster.altitude") }}</span>
            <input v-model.number="clusterDraft.altitudeKm" type="number" min="150" step="10" />
          </label>
        </div>

        <p class="orbitLab__derived">
          {{ $t("orbitLab.cluster.derived", { members: clusterMembers, radius: (clusterRadius / 1000).toFixed(3) }) }}
        </p>
        <p class="orbitLab__note" v-html="$t('orbitLab.cluster.pitchNote')"></p>
        <p v-if="clusterValidation.error" class="orbitLab__error">{{ clusterValidation.error }}</p>

        <div class="orbitLab__actions">
          <button
            type="button"
            class="orbitLab__button"
            :disabled="!clusterValidation.ok"
            :title="$t('orbitLab.cluster.showOnlyTitle', { wire: clusterWire })"
            @click="generateCluster"
          >
            {{ clusterIsOnly ? $t("orbitLab.cluster.regenerate") : $t("orbitLab.cluster.showOnly") }}
          </button>
          <button
            type="button"
            class="orbitLab__button"
            :disabled="!clusterValidation.ok || clusterPatterns.includes(clusterWire)"
            :title="$t('orbitLab.cluster.addTitle', { wire: clusterWire })"
            @click="addCluster"
          >
            {{ $t("orbitLab.cluster.add") }}
          </button>
          <button type="button" class="orbitLab__button" :disabled="!clusterActive" @click="clearClusters">{{ $t("orbitLab.cluster.hideAll") }}</button>
        </div>

        <template v-if="clusterPatterns.length > 0">
          <div class="toolbarTitle">{{ $t("orbitLab.group.clusterPatterns") }}</div>
          <ul class="orbitLab__patterns">
            <li v-for="pattern in clusterPatterns" :key="pattern">
              <button
                type="button"
                class="orbitLab__patternName"
                :class="{ 'orbitLab__patternName--off': !satStore.enabledTags.includes(`Cluster ${pattern}`) }"
                :title="$t('orbitLab.patterns.stopDrawing')"
                @click="toggleCluster(pattern)"
              >
                <code>{{ pattern }}</code>
              </button>
              <button type="button" class="orbitLab__patternDrop" :title="$t('orbitLab.patterns.load')" @click="loadClusterIntoForm(pattern)">
                {{ $t("orbitLab.patterns.edit") }}
              </button>
              <button type="button" class="orbitLab__patternDrop" :title="$t('orbitLab.patterns.forget')" @click="dropCluster(pattern)">×</button>
            </li>
          </ul>
          <p class="orbitLab__note">
            {{ $t("orbitLab.patterns.note") }}
            <code>?cluster={{ clusterPatterns.join(",") }}</code>
          </p>
        </template>
      </div>
    </details>

    <details class="orbitLab__group">
      <summary class="orbitLab__summary">{{ $t("orbitLab.group.marked") }}</summary>
      <div class="orbitLab__body">
        <button type="button" class="orbitLab__button orbitLab__button--wide" :disabled="!walkerActive" @click="markColumn">
          {{ $t("orbitLab.marked.markColumn") }}
        </button>
        <button type="button" class="orbitLab__button orbitLab__button--wide" :disabled="!walkerActive" @click="markCrossShell">
          {{ $t("orbitLab.marked.markCrossShell") }}
        </button>
        <button type="button" class="orbitLab__button orbitLab__button--wide" :disabled="!marks.length" @click="clearMarks">
          {{ $t("orbitLab.marked.clear") }}
        </button>
        <p class="orbitLab__note" v-html="$t('orbitLab.marked.note')"></p>
      </div>
    </details>

    <details class="orbitLab__group">
      <summary class="orbitLab__summary">{{ $t("orbitLab.group.shells") }}</summary>
      <div class="orbitLab__body">
        <button type="button" class="orbitLab__button orbitLab__button--wide" @click="stableShellsDemo">{{ $t("orbitLab.shells.demo") }}</button>
        <p class="orbitLab__note" v-html="$t('orbitLab.shells.note')"></p>
        <table class="orbitLab__facts">
          <tbody>
            <tr :title="$t('orbitLab.shells.facts.nodeRateTitle')">
              <td class="orbitLab__factName">{{ $t("orbitLab.shells.facts.nodeRate") }}</td>
              <td class="orbitLab__factValue">{{ nodeDrift }}</td>
            </tr>
            <tr :title="$t('orbitLab.shells.facts.ceilingTitle')">
              <td class="orbitLab__factName">{{ $t("orbitLab.shells.facts.ceiling") }}</td>
              <td class="orbitLab__factValue">{{ layoutCeiling }}</td>
            </tr>
            <tr v-if="bestLayout" :title="$t('orbitLab.shells.facts.companionTitle')">
              <td class="orbitLab__factName">{{ $t("orbitLab.shells.facts.companion") }}</td>
              <td class="orbitLab__factValue">{{ bestCompanionText }}</td>
            </tr>
            <tr v-if="bestLayout" :title="$t('orbitLab.shells.facts.cycleTitle')">
              <td class="orbitLab__factName">{{ $t("orbitLab.shells.facts.cycle") }}</td>
              <td class="orbitLab__factValue">{{ bestCycleText }}</td>
            </tr>
          </tbody>
        </table>
        <button type="button" class="orbitLab__button orbitLab__button--wide" :disabled="!bestCompanionWire || patterns.includes(bestCompanionWire)" @click="addCompanionShell">
          {{ $t("orbitLab.shells.add") }}
        </button>
        <p class="orbitLab__note" v-html="$t('orbitLab.shells.addNote')"></p>

        <template v-if="layoutVerdicts.length > 0">
          <table class="orbitLab__facts">
            <tbody>
              <tr v-for="row in layoutVerdicts" :key="row.key" :title="row.detail">
                <td class="orbitLab__factName">
                  <code>{{ row.pair }}</code>
                </td>
                <td class="orbitLab__factValue">{{ row.verdict }}</td>
              </tr>
            </tbody>
          </table>
          <p class="orbitLab__note" v-html="$t('orbitLab.shells.verdictsNote')"></p>
        </template>
      </div>
    </details>

    <details class="orbitLab__group">
      <summary class="orbitLab__summary">{{ $t("orbitLab.group.clusters") }}</summary>
      <div class="orbitLab__body">
        <p class="orbitLab__note" v-html="$t('orbitLab.clusters.note')"></p>

        <button type="button" class="orbitLab__button orbitLab__button--wide" @click="familyDemo">{{ $t("orbitLab.clusters.demo") }}</button>
        <p class="orbitLab__note" v-html="$t('orbitLab.clusters.demoNote', { shells: familyDemoShells, revolutions: FAMILY_CYCLE_REVOLUTIONS })"></p>

        <div class="toolbarTitle">{{ $t("orbitLab.clusters.foundTitle", { count: clusterRows.length }) }}</div>
        <template v-if="clusterRows.length > 0">
          <table class="orbitLab__facts">
            <tbody>
              <tr v-for="row in clusterRows" :key="row.key">
                <td class="orbitLab__factName" :title="row.detail">
                  <code>{{ row.members }}</code>
                </td>
                <td class="orbitLab__factValue">{{ row.cycle }}</td>
                <td class="orbitLab__factMark">
                  <button type="button" class="orbitLab__patternDrop" :title="$t('orbitLab.clusters.markTitle')" @click="markCluster(row)">
                    {{ $t("orbitLab.clusters.mark") }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
          <p class="orbitLab__note" v-html="$t('orbitLab.clusters.foundNote')"></p>
        </template>
        <p v-else class="orbitLab__note">{{ $t("orbitLab.clusters.none", { count: patternOrbits.length }) }}</p>

        <div class="toolbarTitle">{{ $t("orbitLab.clusters.family") }}</div>
        <label class="orbitLab__field">
          <span>{{ $t("orbitLab.clusters.revolutions") }}</span>
          <input v-model.number="familyRevolutions" type="number" min="2" max="60" step="1" />
        </label>
        <p class="orbitLab__derived">{{ $t("orbitLab.clusters.familyDerived", { shells: familyShellPatterns.length, cycle: familyCycleText }) }}</p>
        <table v-if="familyShells.length > 0" class="orbitLab__facts">
          <tbody>
            <tr :title="$t('orbitLab.clusters.facts.altitudeTitle')">
              <td class="orbitLab__factName">{{ $t("orbitLab.clusters.facts.altitude") }}</td>
              <td class="orbitLab__factValue">{{ familyAltitudeText }}</td>
            </tr>
            <tr :title="$t('orbitLab.clusters.facts.inclinationTitle')">
              <td class="orbitLab__factName">{{ $t("orbitLab.clusters.facts.inclination") }}</td>
              <td class="orbitLab__factValue">{{ familyInclinationText }}</td>
            </tr>
            <tr :title="$t('orbitLab.clusters.facts.revolutionsTitle')">
              <td class="orbitLab__factName">{{ $t("orbitLab.clusters.facts.revolutions") }}</td>
              <td class="orbitLab__factValue">{{ familyRevolutionsText }}</td>
            </tr>
          </tbody>
        </table>
        <button type="button" class="orbitLab__button orbitLab__button--wide" :disabled="familyShellPatterns.length < 2 || !validation.ok" @click="flyFamily">
          {{ $t("orbitLab.clusters.flyFamily") }}
        </button>
        <p class="orbitLab__note" v-html="$t('orbitLab.clusters.familyNote')"></p>
      </div>
    </details>

    <details class="orbitLab__group">
      <summary class="orbitLab__summary">{{ $t("orbitLab.group.migration") }}</summary>
      <div class="orbitLab__body">
        <button type="button" class="orbitLab__button orbitLab__button--wide" @click="migrationDemo">{{ $t("orbitLab.migration.kvDemo") }}</button>
        <button type="button" class="orbitLab__button orbitLab__button--wide" @click="walker25Demo">{{ $t("orbitLab.migration.fleetDemo") }}</button>
        <label class="toolbarSwitch">
          <input type="checkbox" :checked="migration" @change="migration = ($event.target as HTMLInputElement).checked" />
          <span class="slider"></span>
          {{ $t("orbitLab.migration.overlay") }}
        </label>
        <label class="orbitLab__field">
          <span>{{ $t("orbitLab.migration.stages") }}</span>
          <select class="orbitLab__stages" :value="migrationStages" @change="migrationStages = Number(($event.target as HTMLSelectElement).value)">
            <option v-for="count in PIPELINE_STAGE_CHOICES" :key="count" :value="count">{{ count }}</option>
          </select>
        </label>
        <div class="orbitLab__radios">
          <label class="toolbarSwitch">
            <input type="radio" name="orbitLabMigrationPolicy" value="predictive" :checked="migrationPolicy === 'predictive'" @change="migrationPolicy = 'predictive'" />
            <span class="slider"></span>
            {{ $t("orbitLab.migration.policyPredictive") }}
          </label>
          <label class="toolbarSwitch">
            <input type="radio" name="orbitLabMigrationPolicy" value="naive" :checked="migrationPolicy === 'naive'" @change="migrationPolicy = 'naive'" />
            <span class="slider"></span>
            {{ $t("orbitLab.migration.policyNaive") }}
          </label>
        </div>
        <label class="toolbarSwitch">
          <input type="checkbox" :checked="migrationIncremental" @change="migrationIncremental = ($event.target as HTMLInputElement).checked" />
          <span class="slider"></span>
          {{ $t("orbitLab.migration.incremental") }}
        </label>
        <p class="orbitLab__note" v-html="$t('orbitLab.migration.incrementalNote', { gigabytes: migrationStatus?.kvGigabytes ?? 2 })"></p>
        <p
          class="orbitLab__note"
          v-html="$t('orbitLab.migration.pipelineNote', { stageCount: migrationStatus?.stageCount ?? migrationStages, gigabytes: migrationStatus?.kvGigabytes ?? 2 })"
        ></p>
        <p class="orbitLab__note" v-html="$t('orbitLab.migration.policyNote')"></p>
        <p class="orbitLab__note" v-html="$t('orbitLab.migration.servingNote')"></p>
        <p class="orbitLab__note" v-html="$t('orbitLab.migration.opaqueNote')"></p>

        <table v-if="migrationStatus?.active && migrationStatus.stages.length > 0" class="orbitLab__facts">
          <tbody>
            <tr v-for="stage in migrationStatus.stages" :key="stage.index">
              <td class="orbitLab__factName">
                <span class="orbitLab__swatch" :style="{ backgroundColor: stage.color }"></span>
                S{{ stage.index + 1 }}
              </td>
              <td class="orbitLab__factValue">
                <template v-if="stage.phase === 'migrating'"
                  >{{ shortHost(stage.from) }} → <template v-if="stage.via">{{ shortHost(stage.via) }} → </template>{{ shortHost(stage.to) }} ({{
                    $t("orbitLab.migration.transferMs", { ms: ((stage.transferSeconds ?? 0) * 1000).toFixed(0) })
                  }})</template
                >
                <template v-else-if="stage.phase === 'stranded'">{{ shortHost(stage.hostName) }}{{ $t("orbitLab.migration.stage.stranded") }}</template>
                <template v-else>
                  {{ shortHost(stage.hostName)
                  }}{{
                    stage.powered
                      ? stage.lookaheadPowered === false
                        ? $t("orbitLab.migration.stage.nearEclipse")
                        : $t("orbitLab.migration.stage.sunlit")
                      : $t("orbitLab.migration.stage.dark")
                  }}
                </template>
              </td>
            </tr>
          </tbody>
        </table>

        <table v-if="migrationStatus?.active" class="orbitLab__facts">
          <tbody>
            <tr>
              <td class="orbitLab__factName">{{ $t("orbitLab.migration.facts.status") }}</td>
              <td class="orbitLab__factValue">
                {{ migrationStatus.serving ? $t("orbitLab.migration.status.serving") : $t("orbitLab.migration.status.stalled") }} ·
                {{ $t("orbitLab.migration.status.stagesPowered", { powered: migrationStatus.poweredStages, total: migrationStatus.stages.length }) }}
              </td>
            </tr>
            <tr>
              <td class="orbitLab__factName">{{ $t("orbitLab.migration.facts.policy") }}</td>
              <td class="orbitLab__factValue">
                {{ migrationStatus.policy === "predictive" ? $t("orbitLab.migration.policy.predictive") : $t("orbitLab.migration.policy.reactive") }}
              </td>
            </tr>
            <tr v-if="migrationStatus.allPoweredFraction !== undefined">
              <td class="orbitLab__factName">{{ $t("orbitLab.migration.facts.utilization") }}</td>
              <td class="orbitLab__factValue">
                {{ pct(migrationStatus.allPoweredFraction) }} of {{ simDuration(migrationStatus.ledger.allPoweredSeconds + migrationStatus.ledger.stalledSeconds) }}
              </td>
            </tr>
            <tr>
              <td class="orbitLab__factName">{{ $t("orbitLab.migration.facts.migrations") }}</td>
              <td class="orbitLab__factValue">{{ migrationStatus.migrations }}</td>
            </tr>
            <tr v-if="migrationStatus.ledger.migrations > 0">
              <td class="orbitLab__factName">{{ $t("orbitLab.migration.facts.kvMoved") }}</td>
              <td class="orbitLab__factValue">
                {{
                  $t("orbitLab.migration.kvMovedValue", {
                    payload: formatPayload(migrationStatus.ledger.gigabytesMoved),
                    ms: (migrationStatus.ledger.transferSeconds * 1000).toFixed(0),
                  })
                }}
                <template v-if="migrationStatus.incremental && migrationStatus.ledger.baselineGigabytes > migrationStatus.ledger.gigabytesMoved">
                  {{ $t("orbitLab.migration.lessThanFull", { delta: migrationDelta }) }}
                </template>
              </td>
            </tr>
            <tr v-if="migrationStatus.linkKm !== undefined">
              <td class="orbitLab__factName">{{ $t("orbitLab.migration.facts.isl") }}</td>
              <td class="orbitLab__factValue">{{ $t("orbitLab.migration.linkTime", { kilometres: migrationStatus.linkKm.toFixed(0) }) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="migrationStatus?.active" class="orbitLab__note">{{ migrationStatus.reason }}</p>

        <template v-if="migrationStatus?.active && migrationStatus.log.length > 0">
          <div class="toolbarTitle">{{ $t("orbitLab.group.log") }}</div>
          <table class="orbitLab__facts">
            <tbody>
              <tr v-for="(event, index) in migrationStatus.log" :key="`${event.at}-${event.stage}-${index}`">
                <td class="orbitLab__factName">{{ clockOf(event.at) }}</td>
                <td class="orbitLab__factValue">
                  <span class="orbitLab__swatch" :style="{ backgroundColor: stageColor(event.stage) }"></span>
                  S{{ event.stage + 1 }} {{ event.hops.map(shortHost).join(" → ") }} · {{ event.linkKm.toFixed(0) }} km ·
                  {{ $t("orbitLab.migration.transferMs", { ms: (event.transferSeconds * 1000).toFixed(0) }) }}
                </td>
              </tr>
            </tbody>
          </table>
          <p class="orbitLab__note">{{ $t("orbitLab.migration.logNote") }}</p>
        </template>
      </div>
    </details>

    <details class="orbitLab__group">
      <summary class="orbitLab__summary">{{ $t("orbitLab.group.fleet") }}</summary>
      <div class="orbitLab__body">
        <button type="button" class="orbitLab__button orbitLab__button--wide" @click="realFleetDemo">{{ $t("orbitLab.fleet.demo") }}</button>
        <p class="orbitLab__note" v-html="$t('orbitLab.fleet.note', { count: realSatelliteCount })"></p>
        <button type="button" class="orbitLab__button orbitLab__button--wide" :disabled="realSatelliteCount === 0 || evaluatingFleet" @click="evaluateContinuity">
          {{ evaluatingFleet ? $t("orbitLab.fleet.evaluating") : $t("orbitLab.fleet.evaluate", { count: realSatelliteCount }) }}
        </button>
        <table v-if="fleetReport" class="orbitLab__facts">
          <tbody>
            <tr :title="$t('orbitLab.fleet.facts.meanSunlitTitle')">
              <td class="orbitLab__factName">{{ $t("orbitLab.fleet.facts.meanSunlit") }}</td>
              <td class="orbitLab__factValue">{{ pct(fleetReport.meanSunlitFraction) }}</td>
            </tr>
            <tr :title="$t('orbitLab.fleet.facts.bestTitle')">
              <td class="orbitLab__factName">{{ $t("orbitLab.fleet.facts.best") }}</td>
              <td class="orbitLab__factValue">{{ pct(fleetReport.bestSunlitFraction) }}</td>
            </tr>
            <tr :title="$t('orbitLab.fleet.facts.fixedPlacementTitle')">
              <td class="orbitLab__factName">{{ $t("orbitLab.fleet.facts.fixedPlacement", { stages: migrationStages }) }}</td>
              <td class="orbitLab__factValue">{{ fleetReport.staticPlacementContinuity === undefined ? "—" : pct(fleetReport.staticPlacementContinuity) }}</td>
            </tr>
            <tr :title="$t('orbitLab.fleet.facts.ceilingTitle')">
              <td class="orbitLab__factName">{{ $t("orbitLab.fleet.facts.ceiling", { stages: migrationStages }) }}</td>
              <td class="orbitLab__factValue">{{ pct(fleetReport.serviceOpportunity) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="fleetReport" class="orbitLab__note" v-html="$t('orbitLab.fleet.sampleNote', { step: FLEET_STEP_SECONDS, satellites: fleetReport.satellites })"></p>
      </div>
    </details>

    <details class="orbitLab__group">
      <summary class="orbitLab__summary">{{ $t("orbitLab.group.sunSync") }}</summary>
      <div class="orbitLab__body">
        <p class="orbitLab__note" v-html="$t('orbitLab.sunSync.note')"></p>
        <table class="orbitLab__facts">
          <tbody>
            <tr :title="$t('orbitLab.sunSync.facts.reachableTitle')">
              <td class="orbitLab__factName">{{ $t("orbitLab.sunSync.facts.reachable") }}</td>
              <td class="orbitLab__factValue">{{ reachableVsDemanded }}</td>
            </tr>
            <tr :title="$t('orbitLab.sunSync.facts.neverEclipsedTitle')">
              <td class="orbitLab__factName">{{ $t("orbitLab.sunSync.facts.neverEclipsed") }}</td>
              <td class="orbitLab__factValue">{{ eclipseFreePlanes }}</td>
            </tr>
            <tr :title="$t('orbitLab.sunSync.facts.exchangeTitle')">
              <td class="orbitLab__factName">{{ $t("orbitLab.sunSync.facts.exchange") }}</td>
              <td class="orbitLab__factValue">{{ exchangeRate }}</td>
            </tr>
            <tr :title="$t('orbitLab.sunSync.facts.nodeDriftTitle')">
              <td class="orbitLab__factName">{{ $t("orbitLab.sunSync.facts.nodeDrift") }}</td>
              <td class="orbitLab__factValue">{{ nodeDrift }}</td>
            </tr>
            <tr :title="$t('orbitLab.sunSync.facts.inclinationTitle')">
              <td class="orbitLab__factName">{{ $t("orbitLab.sunSync.facts.inclination") }}</td>
              <td class="orbitLab__factValue">{{ ssoInclination }}</td>
            </tr>
            <tr :title="$t('orbitLab.sunSync.facts.worstBetaTitle')">
              <td class="orbitLab__factName">{{ $t("orbitLab.sunSync.facts.worstBeta") }}</td>
              <td class="orbitLab__factValue">{{ ssoWorstBeta }}</td>
            </tr>
            <tr :title="$t('orbitLab.sunSync.facts.requiredBetaTitle')">
              <td class="orbitLab__factName">{{ $t("orbitLab.sunSync.facts.requiredBeta") }}</td>
              <td class="orbitLab__factValue">{{ ssoRequiredBeta }}</td>
            </tr>
            <tr :title="ssoVerdictNote">
              <td class="orbitLab__factName">{{ $t("orbitLab.sunSync.facts.always") }}</td>
              <td class="orbitLab__factValue">{{ ssoVerdict === "yes" ? $t("orbitLab.sunSync.verdictYes") : $t("orbitLab.sunSync.verdictNo") }}</td>
            </tr>
          </tbody>
        </table>
        <p class="orbitLab__note" v-html="$t('orbitLab.sunSync.knobsNote')"></p>
        <p class="orbitLab__note" v-html="$t('orbitLab.sunSync.notExactNote')"></p>
        <p class="orbitLab__note" v-html="$t('orbitLab.sunSync.bandNote', { band: sunlitBand })"></p>
        <button type="button" class="orbitLab__button orbitLab__button--wide" :disabled="!validation.ok" @click="useSunSyncInclination">
          {{ $t("orbitLab.sunSync.use") }}
        </button>
      </div>
    </details>

    <details class="orbitLab__group">
      <summary class="orbitLab__summary">{{ $t("orbitLab.group.illumination") }}</summary>
      <div class="orbitLab__body">
        <p class="orbitLab__note" v-html="$t('orbitLab.illumination.note')"></p>

        <div class="orbitLab__radios">
          <label v-for="mode in POINT_COLOR_MODES" :key="mode" class="toolbarSwitch">
            <input type="radio" name="pointColorMode" :value="mode" :checked="pointColorMode === mode" @change="pointColorMode = mode" />
            <span class="slider"></span>
            {{ $t(`labels.pointColorMode.${mode}`) }}
          </label>
        </div>

        <label class="orbitLab__field">
          <span>{{ $t("orbitLab.illumination.pointSize") }}</span>
          <select :value="pointSize" @change="pointSize = ($event.target as HTMLSelectElement).value as PointSize">
            <option v-for="size in POINT_SIZES" :key="size" :value="size">{{ $t(`labels.pointSize.${size}`) }}</option>
          </select>
        </label>

        <label class="orbitLab__field">
          <span>{{ $t("orbitLab.illumination.panelNormal") }}</span>
          <select :value="panelAxis" @change="panelAxis = ($event.target as HTMLSelectElement).value as PanelAxis">
            <option v-for="axis in PANEL_AXES" :key="axis" :value="axis">{{ $t(`labels.panelAxis.${axis}`) }}</option>
          </select>
        </label>

        <table class="orbitLab__legend">
          <tbody>
            <tr v-for="state in ILLUMINATION_STATES" :key="state" :title="$t(`labels.illumination.${state}`)">
              <td><span class="orbitLab__swatch" :style="{ backgroundColor: ILLUMINATION_COLOR[state] }"></span></td>
              <td class="orbitLab__legendName">{{ state }}</td>
              <td class="orbitLab__legendCount">{{ census.counts[state] ?? 0 }}</td>
              <td class="orbitLab__legendShare">{{ share(census.counts[state] ?? 0) }}</td>
            </tr>
          </tbody>
        </table>
        <p class="orbitLab__derived">
          {{ $t("orbitLab.illumination.census", { total: census.total }) }}
          <template v-if="census.total > 0">{{ $t("orbitLab.illumination.withoutPower", { share: share(census.dark) }) }}</template>
        </p>
        <p v-if="pointColorMode === 'class'" class="orbitLab__note">{{ $t("orbitLab.illumination.switchNote") }}</p>

        <template v-if="selected">
          <div class="toolbarTitle">{{ selected.name }}</div>
          <p class="orbitLab__derived">
            <span class="orbitLab__swatch" :style="{ backgroundColor: ILLUMINATION_COLOR[selected.state] }"></span>
            {{ selected.state }} · ν {{ selected.nu.toFixed(3) }} · κ {{ selected.kappa.toFixed(3) }} · β {{ selected.betaDeg.toFixed(1) }}°
          </p>
          <div
            v-if="selected.strip.length > 0"
            class="orbitLab__strip"
            :title="$t('orbitLab.illumination.stripTitle', { orbits: STRIP_ORBITS, minutes: selected.spanMinutes, step: STRIP_STEP_SECONDS })"
          >
            <span v-for="(segment, index) in selected.strip" :key="index" :style="{ backgroundColor: segment.color, flexGrow: segment.weight }"></span>
          </div>
          <p v-if="selected.strip.length > 0" class="orbitLab__note">
            {{
              $t("orbitLab.illumination.stripNote", {
                orbits: STRIP_ORBITS,
                minutes: selected.spanMinutes,
                umbra: pct(selected.fractions.umbra ?? 0),
                penumbra: pct(selected.fractions.penumbra ?? 0),
                back: pct(selected.fractions.sunlit_back ?? 0),
                dark: pct(selected.darkFraction),
              })
            }}
          </p>
        </template>
        <p v-else class="orbitLab__note">{{ $t("orbitLab.illumination.clickNote") }}</p>
      </div>
    </details>
  </div>
</template>

<script setup lang="ts">
import { JulianDate } from "@cesium/engine";
import { storeToRefs } from "pinia";
import { computed, onUnmounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import { useController } from "../composables/useController";
import { useViewerClock } from "../composables/useViewerClock";
import { POINT_SIZES, type PointSize } from "../config/components";
import { ILLUMINATION_COLOR, ILLUMINATION_STATES, PANEL_AXES, POINT_COLOR_MODES, type IlluminationState, type PanelAxis } from "../config/illumination";
import { PIPELINE_STAGE_CHOICES, stageColor } from "../config/migration";
import { CAMERA_MODES } from "../config/viewModes";
import {
  applyFamilyScene,
  applyMigrationScene,
  applyRealFleetScene,
  applyShellsScene,
  applyStableShellsScene,
  applySunSyncScene,
  applyTwoOrbitScene,
  applyWalker25Scene,
  type ClockControl,
  DEMO_MULTIPLIER,
  FAMILY_BAND_KM,
  FAMILY_CYCLE_REVOLUTIONS,
  familyPatterns,
  familyReference,
  SHELLS_MULTIPLIER,
  STABLE_REFERENCE,
} from "../modules/demoScenes";
import {
  CLUSTER_PRESETS,
  clusterRadiusM,
  clusterSize,
  clusterTagFor,
  decodeCluster,
  encodeCluster,
  isClusterTag,
  validateClusterFormation,
  type ClusterFormationParams,
} from "../modules/util/clusterFormation";
import { parseGeneratedSatellite } from "../modules/util/constellationLinks";
import { fleetContinuity, type FleetContinuity } from "../modules/util/fleetContinuity";
import { illuminationTimeline } from "../modules/util/illumination";
import { annualEclipseFreePlaneFraction, betaExchangeRateKmPerDegree, maxReachableBetaDeg } from "../modules/util/orbitDesign";
import {
  coPrecessingCeilingKm,
  familyCycleHours,
  findStableClusters,
  type ClusterMember,
  MAX_CLUSTER_CYCLE_HOURS,
  searchStableShellLayouts,
  shellFamily,
  shellPairLayout,
} from "../modules/util/shellLayout";
import {
  alwaysSunlitAltitudeBandKm,
  alwaysSunlitVerdict,
  nodalPrecessionDegPerDay,
  representativeAlwaysSunlitAltitudeKm,
  sunSyncWalkerParams,
} from "../modules/util/sunSynchronous";
import {
  decodeWalker,
  encodeWalker,
  MAX_WALKER_SATELLITES,
  meanMotionRevPerDay,
  planeSlotOf,
  satsPerPlane,
  isWalkerTag,
  validateWalkerDelta,
  WALKER_PRESETS,
  WALKER_EPOCH_ISO,
  walkerPatternAt,
  walkerTagFor,
  type WalkerDeltaParams,
} from "../modules/util/walkerDelta";
import { useCesiumStore } from "../stores/cesium";
import { useSatStore } from "../stores/sat";
import FormationView from "./FormationView.vue";

/** How often the census and the selected satellite's readout are recomputed. */
const REFRESH_MS = 500;

/** Sample step for the strip, in seconds. Matches illuminationTimeline's own default reasoning. */
const STRIP_STEP_SECONDS = 10;

/**
 * How many orbits the strip covers.
 *
 * Two rather than one, because one orbit cannot show what changes between them.
 * The sun moves ~0.04° an hour and the orbit plane regresses a few degrees a day,
 * so consecutive orbits are nearly but not exactly alike — and where a satellite
 * is close to entering or leaving eclipse season, two orbits is where that first
 * shows up as two visibly different halves of the strip.
 */
const STRIP_ORBITS = 2;

const { tm } = useI18n();

const cc = useController();
const satStore = useSatStore();
const { pointColorMode, pointSize, panelAxis, walker, cluster, migration, migrationStages, migrationPolicy, migrationIncremental, links, marks } = storeToRefs(satStore);

// The clock is live viewer state rather than store state (see useViewerClock), and
// this is the seam the clock deck writes it through — so the demo writes it the same
// way rather than reaching for viewer.clock.
const clock = useViewerClock();

// The reference frame the camera is pinned to. Already a setting — it lives in the
// View menu and travels as `?camera=` — surfaced here because it is the difference
// between a picture that shows what the orbit does and one that does not.
const cesiumStore = useCesiumStore();
const { cameraMode } = storeToRefs(cesiumStore);

// Camera-mode labels are prose, so they are read from the locale rather than
// carried here — see `labels.cameraMode` in src/i18n/locales.
//
// The demo scenes are shared with the `?demo=` startup path (modules/demoScenes).
// The panel drives the clock through useViewerClock; the startup path drives the
// ClockViewModel directly. Both reach the scenes through this small control.
const clockControl: ClockControl = {
  setMultiplier: (value) => clock.setMultiplier(value),
  play: () => {
    if (!clock.playing.value) {
      clock.togglePlaying();
    }
  },
};

// The form's own copy: a pattern is only handed to the globe when Generate is
// pressed, so a half-typed T never becomes a constellation. Seeded from the url's
// pattern when there is one, so a shared link opens with its own numbers in the
// fields rather than the default preset's.
const draft = reactive<WalkerDeltaParams>({ ...(WALKER_PRESETS[0] as (typeof WALKER_PRESETS)[number]).params });
const initial = decodeWalker(walker.value[0] ?? "");
if (initial) {
  // The url's first pattern in the fields, so a shared link opens with its own
  // numbers rather than the default preset's.
  Object.assign(draft, initial);
}

const validation = computed(() => validateWalkerDelta(draft));
const wire = computed(() => (validation.value.ok ? encodeWalker(draft) : ""));
const perPlane = computed(() => (validation.value.ok ? satsPerPlane(draft) : 0));
const meanMotion = computed(() => meanMotionRevPerDay(draft.altitudeKm).toFixed(2));
const periodMinutes = computed(() => (1440 / meanMotionRevPerDay(draft.altitudeKm)).toFixed(1));

/** Every pattern generated this session, in the order they were added. */
const patterns = computed(() => walker.value);
const walkerActive = computed(() => satStore.enabledTags.some((tag) => isWalkerTag(tag)));

/** Whether this pattern's tag is currently switched on. */
function isShown(pattern: string): boolean {
  const params = decodeWalker(pattern);
  return params !== undefined && satStore.enabledTags.includes(walkerTagFor(params));
}

function tagsWithout(pattern: string): string[] {
  const params = decodeWalker(pattern);
  const tag = params && walkerTagFor(params);
  return satStore.enabledTags.filter((existing) => existing !== tag);
}

/** Draw or stop drawing one pattern, leaving the others as they are. */
function toggleShown(pattern: string): void {
  const params = decodeWalker(pattern);
  if (!params) {
    return;
  }
  const kept = tagsWithout(pattern);
  satStore.setActivation({ enabledTags: isShown(pattern) ? kept : [...kept, walkerTagFor(params)] });
}

/** Put a pattern's numbers back in the form, so it can be edited into another one. */
function loadIntoForm(pattern: string): void {
  const params = decodeWalker(pattern);
  if (params) {
    Object.assign(draft, params);
  }
}

/**
 * Forget a pattern: out of the list, out of the url, off the globe.
 *
 * Its records stay in the catalog — the catalog has no removal and nothing else
 * needs one — but with the tag gone and the pattern out of the url, nothing draws
 * them and a reload does not bring them back.
 */
function dropPattern(pattern: string): void {
  satStore.setActivation({ enabledTags: tagsWithout(pattern) });
  walker.value = walker.value.filter((existing) => existing !== pattern);
}

const demoOrbitSeconds = computed(() =>
  Math.round(((1440 / meanMotionRevPerDay((WALKER_PRESETS[0] as (typeof WALKER_PRESETS)[number]).params.altitudeKm)) * 60) / DEMO_MULTIPLIER),
);

// Everything the Sun-synchronous block reports, recomputed as the altitude field is
// typed. Cheap: an arcsin and an inverse cosine.
const ssoFacts = computed(() => alwaysSunlitVerdict(draft.altitudeKm));
// The design numbers, recomputed as the form is typed — this is the "can I tune it to
// suit me" question, and the answer is two closed-form angles and a comparison.
const reachableVsDemanded = computed(() => {
  const reachable = maxReachableBetaDeg(draft.inclinationDeg);
  // ssoFacts carries the margin; the geometric demand is the figure to compare against.
  const demanded = ssoFacts.value.requiredBetaDeg - 1;
  return `${reachable.toFixed(1)}° vs ${demanded.toFixed(1)}°${reachable >= demanded ? " ✓" : ""}`;
});
const eclipseFreePlanes = computed(() => {
  const fraction = annualEclipseFreePlaneFraction(draft);
  return fraction === 0 ? "none, ever" : `${(fraction * 100).toFixed(1)}% of the year`;
});
const exchangeRate = computed(() => `${betaExchangeRateKmPerDegree(draft.altitudeKm).toFixed(0)} km of altitude`);

const nodeDrift = computed(() => {
  const rate = nodalPrecessionDegPerDay(draft);
  return Number.isFinite(rate) ? `${rate >= 0 ? "+" : ""}${rate.toFixed(3)}°/day` : "—";
});
const ssoInclination = computed(() => (ssoFacts.value.inclinationDeg === undefined ? "none" : `${ssoFacts.value.inclinationDeg.toFixed(2)}°`));
const ssoWorstBeta = computed(() => (Number.isFinite(ssoFacts.value.worstBetaDeg) ? `${ssoFacts.value.worstBetaDeg.toFixed(1)}°` : "—"));
const ssoRequiredBeta = computed(() => `${ssoFacts.value.requiredBetaDeg.toFixed(1)}°`);
const ssoVerdict = computed(() => (ssoFacts.value.alwaysSunlit ? "yes" : "no"));
const ssoVerdictNote = computed(() =>
  ssoFacts.value.inclinationDeg === undefined
    ? "No inclination makes this altitude sun-synchronous."
    : ssoFacts.value.alwaysSunlit
      ? "A dawn–dusk plane at this altitude clears the shadow all year."
      : "A dawn–dusk plane at this altitude is eclipsed for part of the year.",
);

// The band and the altitude the demo uses. Constant for the session, so computed once
// rather than per keystroke.
/**
 * The layout facts for the shell in the form: how far a companion can be pushed
 * before no inclination keeps up, and the best companion inside that reach.
 *
 * Recomputed as the form changes, which is affordable because none of it
 * propagates anything — the whole answer is two closed-form rates and a
 * bisection over an altitude (`shellLayout.ts`).
 */
const layoutCeiling = computed(() => {
  const ceiling = coPrecessingCeilingKm(draft);
  return Number.isFinite(ceiling) ? `${ceiling.toFixed(0)} km` : "none — a polar shell matches at any altitude";
});

const bestLayout = computed(() => (validation.value.ok ? searchStableShellLayouts(draft, { limit: 1 })[0] : undefined));

const bestCompanionText = computed(() => {
  const layout = bestLayout.value;
  return layout ? `${layout.altitudeKm.toFixed(0)} km at ${layout.inclinationDeg.toFixed(2)}°` : "—";
});

const bestCycleText = computed(() => {
  const layout = bestLayout.value;
  return layout ? `${layout.resonance.repeatHours.toFixed(2)} h — ${layout.resonance.referenceRevolutions} orbits to its ${layout.resonance.companionRevolutions}` : "—";
});

/** The companion pattern the button would add: the layout, flown in the form's own fleet shape. */
const bestCompanion = computed(() => {
  const layout = bestLayout.value;
  return layout && validation.value.ok ? walkerPatternAt(draft, layout, layout.minPerPlane) : undefined;
});

const bestCompanionWire = computed(() => {
  const companion = bestCompanion.value;
  return companion ? encodeWalker(companion) : "";
});

/**
 * What every pair of generated patterns does to the other.
 *
 * Pairwise rather than a single verdict, because "is this fleet stable" is not a
 * question a multi-shell fleet has one answer to: the stable-layout demo flies a
 * pair that repeats and a pair that drifts at the same time, and the table is
 * where they are told apart without waiting for the picture to show it.
 */
const layoutVerdicts = computed(() => {
  const shells = patterns.value.flatMap((wireForm) => {
    const params = decodeWalker(wireForm);
    return params ? [{ wire: wireForm, params }] : [];
  });
  const rows: Array<{ key: string; pair: string; verdict: string; detail: string }> = [];
  for (let a = 0; a < shells.length; a += 1) {
    for (let b = a + 1; b < shells.length; b += 1) {
      const first = shells[a] as (typeof shells)[number];
      const second = shells[b] as (typeof shells)[number];
      const layout = shellPairLayout(first.params, second.params);
      const cycle = layout.verdict === "repeating" && layout.resonance ? ` every ${layout.resonance.repeatHours.toFixed(1)} h` : "";
      rows.push({
        key: `${first.wire}|${second.wire}`,
        pair: `${first.params.inclinationDeg}°/${first.params.altitudeKm} ↔ ${second.params.inclinationDeg}°/${second.params.altitudeKm}`,
        verdict: `${layout.verdict}${cycle}`,
        detail: `node shear ${layout.nodeShearDegPerDay.toFixed(4)}°/day (a degree of seam every ${
          Number.isFinite(layout.seamHoldDays) ? layout.seamHoldDays.toFixed(1) : "∞"
        } days), period ratio ${layout.periodRatio.toFixed(4)}`,
      });
    }
  }
  return rows;
});

const band = alwaysSunlitAltitudeBandKm();
const sunlitBand = band ? `${band.lowestKm} and ${band.highestKm} km` : "no altitude";
const alwaysSunlitAltitude = representativeAlwaysSunlitAltitudeKm() ?? 1760;

const presetIndex = computed(() => WALKER_PRESETS.findIndex((preset) => encodeWalker(preset.params) === wire.value));
// The note is prose, so it is translated here rather than read off the preset.
// Keyed by position in `WALKER_PRESETS`, and a preset added without a matching
// note falls back to the English one rather than to nothing.
const presetNote = computed(() => {
  const index = presetIndex.value;
  if (index < 0) {
    return "";
  }
  const translated = tm(`orbitLab.presetNotes.${index}`);
  return (typeof translated === "string" ? translated : WALKER_PRESETS[index]?.note) ?? "";
});

function applyPreset(index: number): void {
  const preset = WALKER_PRESETS[index];
  if (preset) {
    Object.assign(draft, preset.params);
  }
}

/**
 * Hand the pattern to the globe and switch its tag on, dropping any other
 * pattern's.
 *
 * Two writes rather than one, and both to the store: the pattern is what
 * sceneSync expands into element sets, and the tag is what activates them. A
 * generated constellation nobody asked to see would be a catalog entry and no
 * more, which is not what pressing Generate means.
 *
 * Replacing rather than adding, because Generate means "show me this pattern" —
 * the previous one is still in the catalog and still in the browser's group list,
 * so keeping both on screen stays one click away.
 */
function generate(): void {
  if (!validation.value.ok) {
    return;
  }
  walker.value = [wire.value];
  const kept = satStore.enabledTags.filter((tag) => !isWalkerTag(tag));
  satStore.setActivation({ enabledTags: [...kept, walkerTagFor(draft)] });
}

/**
 * The same, keeping what is already there.
 *
 * The reason both buttons exist: comparing two shells is the question this panel is
 * for, and before this the second Generate silently dropped the first pattern out of
 * the url — so the comparison survived until the page was reloaded and no further.
 */
function addPattern(): void {
  if (!validation.value.ok || walker.value.includes(wire.value)) {
    return;
  }
  walker.value = [...walker.value, wire.value];
  satStore.setActivation({ enabledTags: [...satStore.enabledTags, walkerTagFor(draft)] });
}

/**
 * The whole two-orbit demo in one press.
 *
 * Four writes that only make sense together — the pattern, its tag, the components
 * that draw the arc, and the colouring that matches the points to it. Offered as
 * one button because the thing being asked for is "show me the simplest version of
 * this", and reaching it through four menus is not that. Nothing here is a mode: a
 * reader can undo any of the four afterwards.
 */
function twoOrbitDemo(): void {
  const preset = WALKER_PRESETS[0] as (typeof WALKER_PRESETS)[number];
  // Fill the form too, so the numbers on screen match the scene. The scene itself
  // is applied by the shared helper that the `?demo=` link also uses.
  Object.assign(draft, preset.params);
  applyTwoOrbitScene(satStore, cesiumStore, clockControl);
}

/**
 * The two-orbit demo, plus the naive KV-cache live-migration overlay on top.
 *
 * Builds on twoOrbitDemo rather than repeating it: the migration story needs
 * exactly the scene that demo sets up — a handful of satellites, coloured by
 * illumination, in the inertial frame, with the clock moving so a host crosses
 * into shadow while someone watches. Turning the overlay on is the one thing this
 * adds: a workload that hops to a lit neighbour each time its host goes dark.
 */
function migrationDemo(): void {
  const preset = WALKER_PRESETS[0] as (typeof WALKER_PRESETS)[number];
  Object.assign(draft, preset.params);
  applyMigrationScene(satStore, cesiumStore, clockControl);
}
function walker25Demo(): void {
  const params = { total: 100, planes: 25, phasing: 1, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 };
  Object.assign(draft, params);
  applyWalker25Scene(satStore, cesiumStore, clockControl);
}
function useSunSyncInclination(): void {
  const inclinationDeg = ssoFacts.value.inclinationDeg;
  if (inclinationDeg !== undefined) {
    draft.inclinationDeg = Number(inclinationDeg.toFixed(3));
  }
}

/**
 * The always-sunlit demo: the same orbit twice, a quarter turn of the plane apart.
 *
 * Two patterns rather than one, because "never in shadow" is only meaningful against
 * something that is. Same altitude and same inclination in both, so the only thing
 * the difference can be attributed to is where the plane faces — which is the whole
 * content of the result.
 *
 * The node is placed relative to where the sun actually is at the pattern epoch, and
 * sun-synchrony is what keeps it there afterwards.
 */
function sunSyncDemo(): void {
  const epoch = new Date(WALKER_EPOCH_ISO);
  const dawnDusk = sunSyncWalkerParams({ altitudeKm: alwaysSunlitAltitude, total: 12, plane: "dawn-dusk" }, epoch);
  if (dawnDusk) {
    // Fill the form with the dawn–dusk numbers to match; the scene is applied by
    // the shared helper.
    Object.assign(draft, dawnDusk);
  }
  applySunSyncScene(satStore, cesiumStore, clockControl, alwaysSunlitAltitude);
}

/**
 * The stacked-shells demo: three Walker shells at once, watched from the outside.
 *
 * Three patterns rather than one, because the thing being shown is *relative*
 * motion — what a difference in period does (the low shell laps the high ones) and
 * what a difference in inclination does when the period is shared (a node drift that
 * nothing in the model removes). The form keeps the first shell's numbers, since it
 * holds one pattern's worth of fields and three patterns' worth of scene.
 */
function shellsDemo(): void {
  Object.assign(draft, { total: 24, planes: 4, phasing: 1, inclinationDeg: 53, altitudeKm: 550, raanSpanDeg: 360 });
  applyShellsScene(satStore, cesiumStore, clockControl);
}

/**
 * The stable-layout demo: the stacked-shells scene with the middle shell designed
 * rather than picked.
 *
 * The form keeps the reference shell's numbers, so the layout facts above the
 * button describe the shell the scene is built around — press it and the "best
 * companion" row is the shell that just appeared beside it.
 */
function stableShellsDemo(): void {
  Object.assign(draft, STABLE_REFERENCE);
  applyStableShellsScene(satStore, cesiumStore, clockControl);
}

/**
 * Add the companion the layout search picked, beside what is already flying.
 *
 * Add rather than replace: a companion shell is only meaningful next to the shell
 * it was solved against, and the pairwise verdict table below is what it is for.
 * The form's own pattern is generated first if it is not already on screen, since
 * a companion to nothing is just another shell.
 */
function addCompanionShell(): void {
  const companion = bestCompanion.value;
  if (!companion || !validation.value.ok) {
    return;
  }
  const companionWire = encodeWalker(companion);
  const wires = patterns.value.includes(wire.value) ? [...patterns.value] : [...patterns.value, wire.value];
  const tags = new Set(satStore.enabledTags);
  tags.add(walkerTagFor(draft));
  tags.add(walkerTagFor(companion));
  walker.value = [...wires, companionWire];
  satStore.setActivation({ enabledTags: [...tags] });
}

/** Leave the records in the catalog and stop drawing them — the tag is the switch. */
function clear(): void {
  satStore.setActivation({ enabledTags: satStore.enabledTags.filter((tag) => !isWalkerTag(tag)) });
}

// ---------------------------------------------------------------------------
// Stable clusters
//
// The third thing the app calls a cluster, and until now the only one with
// nowhere to be seen: `findStableClusters` and `shellFamily` ran in scripts and
// tests and printed to a terminal, while the panel could build a shell and a
// formation but not read the partition back off either.
//
// Two halves, because the two functions answer opposite questions:
// `findStableClusters` reads the partition off orbits that already exist, and
// `shellFamily` writes one. The first is a table of what the generated patterns
// already are; the second is a control that turns the form's own shell into a
// whole family and flies it.
// ---------------------------------------------------------------------------

/** How long a cycle may be and still be worth offering: two days (see shellLayout). */
const CLUSTER_MAX_CYCLE_HOURS = MAX_CLUSTER_CYCLE_HOURS;

/** How many revolutions per cycle the family builder starts on. */
const familyRevolutions = ref(FAMILY_CYCLE_REVOLUTIONS);

/**
 * The distinct orbits the generated patterns fly, one wire each.
 *
 * Deduplicated by (altitude, inclination) because a cluster is a statement about
 * orbits: two patterns differing only in phasing or plane count are one shell in
 * two pieces, and offering them as two members would inflate every cluster by
 * however many times the reader pressed Add.
 */
const patternOrbits = computed<ClusterMember[]>(() => {
  const seen = new Map<string, ClusterMember>();
  for (const wireForm of patterns.value) {
    const params = decodeWalker(wireForm);
    if (!params) {
      continue;
    }
    const key = `${params.inclinationDeg.toFixed(3)}@${params.altitudeKm.toFixed(3)}`;
    if (!seen.has(key)) {
      seen.set(key, { id: wireForm, orbit: { altitudeKm: params.altitudeKm, inclinationDeg: params.inclinationDeg } });
    }
  }
  return [...seen.values()];
});

/**
 * Every stable cluster among the generated patterns, best first.
 *
 * The Pareto front of size against cycle rather than one answer: a subset that
 * returns sooner than the cluster containing it is a different offer, not a
 * worse one, and it is kept. So this list is not a partition — the same shell
 * appears in several rows, which is the honest reading of a tolerance that is
 * not transitive.
 */
const stableClusters = computed(() => findStableClusters(patternOrbits.value, { maxCycleHours: CLUSTER_MAX_CYCLE_HOURS }));

interface ClusterRow {
  key: string;
  /** The member patterns, as wires, in the order the solver reported them. */
  wires: string[];
  members: string;
  cycle: string;
  detail: string;
}

/** An orbit, as the panel names it: the two numbers a cluster is a statement about. */
function orbitLabel(wireForm: string): string {
  const params = decodeWalker(wireForm);
  return params ? `${params.inclinationDeg}°/${params.altitudeKm}` : wireForm;
}

const clusterRows = computed<ClusterRow[]>(() =>
  stableClusters.value.map((found) => ({
    key: found.members.toSorted().join("|"),
    wires: [...found.members],
    members: found.members.map(orbitLabel).join(" + "),
    cycle: `${found.cycleHours.toFixed(2)} h · ${found.verdict}`,
    detail: [
      `${found.revolutions.join(", ")} revolutions per cycle`,
      `slip ${found.slipDegPerCycle.toFixed(2)}° per cycle`,
      `node spread ${found.nodeSpreadDegPerDay.toFixed(4)}°/day`,
      `tightest link budget ${found.maxLinkRangeKm.toFixed(0)} km`,
    ].join(" · "),
  })),
);

/**
 * Bond one satellite per cluster member, which is what makes a cluster visible
 * rather than tabulated: the marks are the amber halos, and every pair of them is
 * bonded in the verdict's line style. A cluster that returns draws solid and
 * comes back to the same shape; pressing this on two rows in turn is how the
 * Pareto front is read off the globe rather than off the table.
 */
function markCluster(row: ClusterRow): void {
  satStore.marks = row.wires.map((wireForm) => `1-1@${wireForm}`);
}

/** The family the form's own shell can hold, as orbits. */
const familyShells = computed(() =>
  validation.value.ok && Number.isInteger(familyRevolutions.value) && familyRevolutions.value >= 2
    ? shellFamily(draft, { cycleRevolutions: familyRevolutions.value, minAltitudeKm: FAMILY_BAND_KM.min, maxAltitudeKm: FAMILY_BAND_KM.max })
    : [],
);

/** The same family, as patterns the globe can draw. */
const familyShellPatterns = computed(() =>
  validation.value.ok && Number.isInteger(familyRevolutions.value) && familyRevolutions.value >= 2 ? familyPatterns(draft, familyRevolutions.value) : [],
);

const familyCycleText = computed(() => {
  const hours = familyCycleHours(familyShells.value);
  return hours > 0 ? `${hours.toFixed(2)} h` : "—";
});

const familyAltitudeText = computed(() => {
  const altitudes = familyShells.value.map((shell) => shell.altitudeKm);
  return altitudes.length === 0 ? "—" : `${(altitudes[0] as number).toFixed(0)} – ${(altitudes[altitudes.length - 1] as number).toFixed(0)} km`;
});

const familyInclinationText = computed(() => {
  const inclinations = familyShells.value.map((shell) => shell.inclinationDeg);
  if (inclinations.length === 0) {
    return "—";
  }
  const spread = (Math.max(...inclinations) as number) - (Math.min(...inclinations) as number);
  return `${(inclinations[0] as number).toFixed(2)}° – ${(inclinations[inclinations.length - 1] as number).toFixed(2)}° (span ${spread.toFixed(2)}°)`;
});

const familyRevolutionsText = computed(() => familyShells.value.map((shell) => shell.revolutions).join(", "));

/**
 * Fly the whole family the form's shell can hold.
 *
 * Replaces the pattern list rather than adding to it: a family is a designed
 * object, and leaving the shell it was solved from plus three unrelated patterns
 * on screen makes the pairwise table below the multi-shell group read as if the
 * family were drifting. One satellite per shell is marked, so the bonds between
 * shells — the thing a family guarantees — are the thing on screen.
 */
function flyFamily(): void {
  const shells = familyShellPatterns.value;
  if (shells.length < 2 || !validation.value.ok) {
    return;
  }
  const wires = shells.map(encodeWalker);
  walker.value = wires;
  satStore.setActivation({ enabledTags: shells.map(walkerTagFor) });
  satStore.links = true;
  satStore.marks = wires.map((wireForm) => `1-1@${wireForm}`);
}

/** How many shells the sun-synchronous family scene flies. */
const familyDemoShells = computed(() => {
  const reference = familyReference();
  return reference ? familyPatterns(reference, FAMILY_CYCLE_REVOLUTIONS).length : 0;
});

/** The sun-synchronous family, in one press: the scene `?demo=sso-family` also opens. */
function familyDemo(): void {
  applyFamilyScene(satStore, cesiumStore, clockControl);
}

// ---------------------------------------------------------------------------
// Formation cluster
//
// The same four-knob form the Walker pattern has, because a formation is four
// numbers too — inclination, rings, radial pitch, altitude — and the along-track
// pitch is not one of them: it is twice the radial, because that is the
// epicycle's own axis ratio. Until this existed, the only way to get a cluster
// onto the globe was to edit the url, which meant the panel could *display* a
// formation it had no way to build.
// ---------------------------------------------------------------------------

const clusterDraft = reactive<ClusterFormationParams>({ ...(CLUSTER_PRESETS[0] as (typeof CLUSTER_PRESETS)[number]).params });
const clusterValidation = computed(() => validateClusterFormation(clusterDraft));
const clusterWire = computed(() => (clusterValidation.value.ok ? encodeCluster(clusterDraft) : ""));
const clusterPatterns = computed(() => cluster.value);
const clusterMembers = computed(() => (clusterValidation.value.ok ? clusterSize(clusterDraft.rings) : 0));
const clusterRadius = computed(() => (clusterValidation.value.ok ? clusterRadiusM(clusterDraft) : 0));
const clusterActive = computed(() => satStore.enabledTags.some((tag) => isClusterTag(tag)));

/** Whether the form's numbers are already on the globe, so the button can say which it will do. */
const clusterIsOnly = computed(() => clusterPatterns.value.length === 1 && clusterPatterns.value[0] === clusterWire.value);

function generateCluster(): void {
  if (!clusterValidation.value.ok) {
    return;
  }
  cluster.value = [clusterWire.value];
  const kept = satStore.enabledTags.filter((tag) => !isClusterTag(tag));
  // The tag, not just the wire. A cluster added without its tag is in the
  // catalog and on nothing — no error, no satellite, which reads as "this does
  // not work" rather than as "this is switched off".
  satStore.setActivation({ enabledTags: [...kept, clusterTagFor(clusterDraft)] });
}

function addCluster(): void {
  if (!clusterValidation.value.ok || clusterPatterns.value.includes(clusterWire.value)) {
    return;
  }
  cluster.value = [...clusterPatterns.value, clusterWire.value];
  satStore.setActivation({ enabledTags: [...satStore.enabledTags, clusterTagFor(clusterDraft)] });
}

function clearClusters(): void {
  satStore.setActivation({ enabledTags: satStore.enabledTags.filter((tag) => !isClusterTag(tag)) });
}

function applyClusterPreset(index: number): void {
  const preset = CLUSTER_PRESETS[index];
  if (preset) {
    Object.assign(clusterDraft, preset.params);
  }
}

/**
 * The close-up view is the only place a formation is legible — at globe range a
 * 1 km cluster is one point — so the group holding it opens itself the moment
 * there is one to look at. It does not force itself open on every render: the
 * binding is to whether a cluster exists at all, not to a ref the user fights.
 */
const hasCluster = computed(() => clusterPatterns.value.length > 0);

const clusterPresetIndex = computed(() => CLUSTER_PRESETS.findIndex((preset) => encodeCluster(preset.params) === clusterWire.value));

// Prose, so it is translated here rather than read off the preset. Keyed by
// position in `CLUSTER_PRESETS`; a preset added without a matching note falls
// back to the English one rather than to nothing.
const clusterPresetNote = computed(() => {
  const index = clusterPresetIndex.value;
  if (index < 0) {
    return "";
  }
  const translated = tm(`orbitLab.clusterPresetNotes.${index}`);
  return (typeof translated === "string" ? translated : CLUSTER_PRESETS[index]?.note) ?? "";
});

function toggleCluster(pattern: string): void {
  const tag = clusterTagFor(decodeCluster(pattern) ?? clusterDraft);
  const on = satStore.enabledTags.includes(tag);
  satStore.setActivation({
    enabledTags: on ? satStore.enabledTags.filter((candidate) => candidate !== tag) : [...satStore.enabledTags, tag],
  });
}

function loadClusterIntoForm(pattern: string): void {
  const params = decodeCluster(pattern);
  if (params) {
    Object.assign(clusterDraft, params);
  }
}

function dropCluster(pattern: string): void {
  cluster.value = clusterPatterns.value.filter((candidate) => candidate !== pattern);
  const tag = clusterTagFor(decodeCluster(pattern) ?? clusterDraft);
  satStore.setActivation({ enabledTags: satStore.enabledTags.filter((candidate) => candidate !== tag) });
}

/**
 * Mark the same slot in every plane of the first pattern.
 *
 * The slot is the middle one, so the marked ladder sits away from the ring's
 * seam-ish slot-1 edge and the halos read as one column. The bonds between
 * column members are exactly the links the auto-topology already draws - the
 * point here is the halo making the column followable by eye.
 */
function markColumn(): void {
  const active = walker.value[0];
  const params = active ? decodeWalker(active) : undefined;
  if (!params) {
    return;
  }
  const slotsPerPlane = Math.round(params.total / params.planes);
  const slot = Math.floor(slotsPerPlane / 2) + 1;
  satStore.marks = Array.from({ length: params.planes }, (_, plane) => `${plane + 1}-${slot}@${active}`);
}

/** Mark one satellite per pattern, same slot each: the cross-shell sample. */
function markCrossShell(): void {
  satStore.marks = walker.value.map((w) => `1-1@${w}`);
}

function clearMarks(): void {
  satStore.marks = [];
}

interface Census {
  counts: Partial<Record<IlluminationState, number>>;
  total: number;
  dark: number;
}

const census = ref<Census>({ counts: {}, total: 0, dark: 0 });

interface SelectedReadout {
  name: string;
  state: IlluminationState;
  nu: number;
  kappa: number;
  betaDeg: number;
  /** The whole strip's span, not one period. */
  spanMinutes: string;
  strip: { color: string; weight: number }[];
  fractions: Partial<Record<IlluminationState, number>>;
  darkFraction: number;
}

const selected = ref<SelectedReadout | undefined>(undefined);

/** What the migration overlay is doing, polled with everything else. */
const migrationStatus = ref(cc.migrationStatus);

/**
 * How many of the fleet's real (non-generated) satellites are active.
 *
 * The continuity report is about real catalogued orbits — a generated Walker
 * pattern is the other sections' business — so this is the fleet the section
 * sizes itself against. Zero disables the evaluate button rather than showing a
 * report about nothing.
 */
const realSatelliteCount = computed(() => cc.sats.activeSatellites.filter((sat) => !parseGeneratedSatellite(sat.props.name)).length);

/** The last continuity report, shown until the fleet changes enough to re-run. */
const fleetReport = ref<FleetContinuity | undefined>(undefined);

const evaluatingFleet = ref(false);

/**
 * How many real satellites the continuity report samples, at most.
 *
 * The report propagates every sampled satellite over two orbits at 30 s steps —
 * ~400 SGP4 evaluations each — so the cap keeps the largest mapped fleet
 * (OneWeb's 651) under a second of work while still covering every orbital plane.
 * Evenly strided rather than the first N, so a fleet ordered by launch date does
 * not bias the sample to one shell.
 */
const FLEET_SAMPLE_LIMIT = 48;

/** Sample step for the continuity timelines, in seconds. */
const FLEET_STEP_SECONDS = 30;

/**
 * Evaluate the real fleet's sunlit service continuity.
 *
 * Each sampled satellite's illumination timeline is propagated over two orbits
 * from *now* — the same window for every satellite, so the per-instant columns
 * align and "how many are lit at once" is a real conjunction count, not a
 * per-satellite average. Propagation is synchronous (a few hundred ms at the
 * cap); the button disables for the duration rather than the report racing
 * itself.
 */
function evaluateContinuity(): void {
  if (evaluatingFleet.value) {
    return;
  }
  evaluatingFleet.value = true;
  try {
    const date = JulianDate.toDate(cc.viewer.clock.currentTime);
    const real = cc.sats.activeSatellites.filter((sat) => !parseGeneratedSatellite(sat.props.name));
    if (real.length === 0) {
      fleetReport.value = undefined;
      return;
    }
    const stride = Math.max(1, Math.ceil(real.length / FLEET_SAMPLE_LIMIT));
    const sampled = real.filter((_, index) => index % stride === 0);
    const periods = sampled.map((sat) => sat.props.orbit.orbitalPeriod).toSorted((a, b) => a - b);
    const spanSeconds = 2 * 60 * (periods[Math.floor(periods.length / 2)] ?? 95);
    const axis = panelAxis.value;
    const powered = sampled.map((sat) => {
      const timeline = illuminationTimeline(sat.props.orbit.satrec, date, spanSeconds, FLEET_STEP_SECONDS, axis);
      return timeline.samples.map((sample) => sample.state === "sunlit_on" || sample.state === "sunlit_edge");
    });
    fleetReport.value = fleetContinuity(powered, migrationStages.value);
  } finally {
    evaluatingFleet.value = false;
  }
}

/**
 * The migration demo mapped onto a real constellation, in one press.
 *
 * The scene is the shared `?demo=real-fleet` helper: it activates the real
 * Iridium NEXT group from the catalog, colours it by illumination and turns the
 * migration overlay on over it. The form is not touched — it holds Walker
 * numbers, and a real catalog has none to fill it with.
 */
function realFleetDemo(): void {
  applyRealFleetScene(satStore, cesiumStore, clockControl);
}

/**
 * A span of simulated time, in the largest unit that keeps it readable.
 *
 * The demo runs at 60× and the browser check winds to 4000×, so the accounted span
 * crosses from seconds to hours within a session — printing raw seconds throughout
 * would make the served fraction's denominator unreadable exactly when it gets
 * interesting.
 */
function simDuration(seconds: number): string {
  if (seconds < 90) {
    return `${seconds.toFixed(0)} s`;
  }
  if (seconds < 5400) {
    return `${(seconds / 60).toFixed(1)} min`;
  }
  return `${(seconds / 3600).toFixed(1)} h`;
}

/**
 * A satellite's name without its constellation prefix: `P02-07` rather than
 * `W53:20/2/1@550~180 P02-07`.
 *
 * The migration tables are two narrow columns in a side panel, and the generated
 * names are long enough that the plane-and-slot part — the only part that differs
 * between rows, and the only part that says which plane a stage sits in — was the
 * part being clipped off the right edge.
 *
 * Read with the same parser the globe labels use (`planeSlotOf`), so a stage's tag is
 * one string wherever it appears. The trailing-token fallback is for a real
 * catalogued satellite, which has no plane or slot to name.
 */
function shortHost(name: string | undefined): string {
  if (!name) {
    return "—";
  }
  const tag = planeSlotOf(name);
  if (tag) {
    return tag;
  }
  const lastSpace = name.lastIndexOf(" ");
  return lastSpace === -1 ? name : name.slice(lastSpace + 1);
}

/** The wall-clock time of an ISO instant, to the second — the log's left column. */
function clockOf(iso: string): string {
  return iso.slice(11, 19);
}

/** How much less the incremental sync has moved than the full-snapshot baseline. */
const migrationDelta = computed(() => {
  const ledger = migrationStatus.value?.ledger;
  if (!ledger || ledger.gigabytesMoved <= 0) {
    return "0";
  }
  const factor = ledger.baselineGigabytes / ledger.gigabytesMoved;
  return factor >= 10 ? factor.toFixed(0) : factor.toFixed(1);
});

/** A transfer payload for the tables: megabyte deltas read better than fractions of a GB. */
function formatPayload(gigabytes: number | undefined): string {
  if (gigabytes === undefined) {
    return "—";
  }
  return gigabytes < 2 ? `${(gigabytes * 1024).toFixed(0)} MB` : `${gigabytes.toFixed(gigabytes < 10 ? 2 : 0)} GB`;
}

/**
 * Which satellite the readout is about: the selected one, else the tracked one.
 *
 * Selection first, because clicking a satellite is the more deliberate of the two
 * — tracking is what the camera is doing, and a link can arrive with it already
 * set.
 */
function subjectSatellite() {
  const sats = cc.sats.activeSatellites;
  return sats.find((sat) => sat.isSelected) ?? sats.find((sat) => sat.isTracked);
}

/**
 * Recompute both readouts.
 *
 * On a timer rather than per frame: this walks every active satellite, and a
 * census is a number someone reads rather than an animation. Half a second is
 * under the interval at which a changing count is legible and well over the cost
 * of the walk, which is one memoized lookup per satellite (see IlluminationCache)
 * plus, for the subject only, one orbit of propagation.
 */
function refresh(): void {
  const date = JulianDate.toDate(cc.viewer.clock.currentTime);
  migrationStatus.value = cc.migrationStatus;
  const axis = panelAxis.value;
  const counts: Partial<Record<IlluminationState, number>> = {};
  let total = 0;
  let dark = 0;
  for (const sat of cc.sats.activeSatellites) {
    const illumination = sat.props.illumination(date, axis);
    if (!illumination) {
      continue;
    }
    total += 1;
    counts[illumination.state] = (counts[illumination.state] ?? 0) + 1;
    if (illumination.state !== "sunlit_on" && illumination.state !== "sunlit_edge") {
      dark += 1;
    }
  }
  census.value = { counts, total, dark };

  const subject = subjectSatellite();
  if (!subject) {
    selected.value = undefined;
    return;
  }
  const now = subject.props.illumination(date, axis);
  if (!now) {
    selected.value = undefined;
    return;
  }
  const spanMinutes = subject.props.orbit.orbitalPeriod * STRIP_ORBITS;
  const timeline = illuminationTimeline(subject.props.orbit.satrec, date, spanMinutes * 60, STRIP_STEP_SECONDS, axis);
  selected.value = {
    name: subject.props.name,
    state: now.state,
    nu: now.nu,
    kappa: now.kappa,
    betaDeg: now.betaDeg,
    spanMinutes: spanMinutes.toFixed(1),
    strip: runsOf(timeline.samples.map((sample) => sample.state)),
    fractions: timeline.fractions,
    darkFraction: timeline.darkFraction,
  };
}

/**
 * Consecutive equal states collapsed into weighted segments.
 *
 * A strip of ~570 one-sample divs is 570 elements the browser lays out on every
 * refresh; an orbit only ever has a handful of state changes, so the runs are the
 * same picture at a fraction of the DOM.
 */
function runsOf(states: IlluminationState[]): { color: string; weight: number }[] {
  const runs: { color: string; weight: number }[] = [];
  for (const state of states) {
    const last = runs[runs.length - 1];
    const color = ILLUMINATION_COLOR[state];
    if (last && last.color === color) {
      last.weight += 1;
    } else {
      runs.push({ color, weight: 1 });
    }
  }
  return runs;
}

/** A census count as a percentage of what is on screen. */
function share(count: number): string {
  const total = census.value.total;
  return total === 0 ? "0%" : `${((count / total) * 100).toFixed(0)}%`;
}

/** An already-normalized fraction as a percentage. */
function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

const timer = window.setInterval(refresh, REFRESH_MS);
refresh();
onUnmounted(() => window.clearInterval(timer));

// The axis is the one input the memoized readouts cannot notice on their own
// between ticks, so a change to it is answered immediately rather than at the next
// interval.
watch(panelAxis, () => refresh());
</script>

<style scoped>
.orbitLab {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* One collapsible section per topic. Native `details` rather than a component:
   the panel is a Cesium toolbar child with its own styling, and this gets
   keyboard operation, find-in-page expansion and print behaviour for free. */
.orbitLab__group {
  border-top: 1px solid rgba(255, 255, 255, 0.12);
}

.orbitLab__group:first-of-type {
  border-top: none;
}

.orbitLab__summary {
  padding: 4px 0;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  list-style: none;
}

/* The marker is ours so the triangle sits at the end of the line — a heading
   reads as a heading when its affordance does not interrupt it. */
.orbitLab__summary::-webkit-details-marker {
  display: none;
}

.orbitLab__summary::after {
  float: right;
  font-weight: 400;
  opacity: 0.6;
  content: "▸";
}

.orbitLab__group[open] > .orbitLab__summary::after {
  content: "▾";
}

.orbitLab__summary:hover::after {
  opacity: 1;
}

.orbitLab__body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 0 0 6px 6px;
  border-left: 1px solid rgba(255, 255, 255, 0.12);
}

.orbitLab__note {
  margin: 0;
  font-size: 11px;
  line-height: 1.35;
  opacity: 0.7;
}

.orbitLab__derived {
  margin: 0;
  font-size: 11px;
  opacity: 0.9;
}

.orbitLab__error {
  margin: 0;
  font-size: 11px;
  color: #d55e00;
}

.orbitLab__grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px 8px;
}

.orbitLab__field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: 12px;
}

.orbitLab__field input,
.orbitLab__field select {
  width: 88px;
  min-width: 0;
  padding: 1px 3px;
  color: inherit;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 3px;
}

.orbitLab__field select {
  width: 128px;
}

.orbitLab__actions {
  display: flex;
  gap: 6px;
}

.orbitLab__button {
  flex: 1;
  padding: 2px 6px;
  font-size: 12px;
  color: inherit;
  background: rgba(255, 255, 255, 0.12);
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 3px;
  cursor: pointer;
}

.orbitLab__button--wide {
  width: 100%;
}

.orbitLab__button:disabled {
  cursor: default;
  opacity: 0.4;
}

.orbitLab__radios {
  display: flex;
  flex-direction: column;
}

.orbitLab__patterns {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.orbitLab__patterns li {
  display: flex;
  align-items: center;
  gap: 4px;
}

/* The name is the switch: clicking it draws or stops drawing that pattern, which is
   the same thing its tag's checkbox in the satellite browser does. Dimmed when off,
   because a pattern that is listed and not drawn has to look different from one that
   is not listed at all. */
.orbitLab__patternName {
  flex: 1;
  overflow: hidden;
  padding: 1px 3px;
  color: inherit;
  font-size: 11px;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 3px;
  cursor: pointer;
}

.orbitLab__patternName--off {
  opacity: 0.45;
}

.orbitLab__patternDrop {
  padding: 1px 5px;
  color: inherit;
  font-size: 11px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 3px;
  cursor: pointer;
}

/* The sun-synchronous readout: two columns of computed numbers. Its own class rather
   than the legend's, because a legend maps a colour to a name and this maps a name to
   a value — and because sharing the class made every query for "the legend" match
   both. */
.orbitLab__facts {
  width: 100%;
  font-size: 11px;
  border-collapse: collapse;
}

.orbitLab__factName {
  width: 100%;
  /* The migration tables put a colour swatch beside a short label here; without
     this the two wrap onto separate lines in the panel's narrow column. */
  white-space: nowrap;
}

.orbitLab__factValue {
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

/* The cluster table's third column: a per-row action, so a row can be flown
   without re-typing what it says. Padded rather than flush, because it sits
   beside a right-aligned figure. */
.orbitLab__factMark {
  padding-left: 6px;
  white-space: nowrap;
}

.orbitLab__legend {
  width: 100%;
  font-size: 11px;
  border-collapse: collapse;
}

.orbitLab__legendName {
  width: 100%;
}

.orbitLab__legendCount,
.orbitLab__legendShare {
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.orbitLab__legendShare {
  padding-left: 6px;
  opacity: 0.7;
}

.orbitLab__swatch {
  display: inline-block;
  width: 9px;
  height: 9px;
  margin-right: 4px;
  border: 1px solid rgba(0, 0, 0, 0.5);
  border-radius: 2px;
  vertical-align: middle;
}

/* One orbit as a strip of colour, so the state changes are countable at a glance. */
.orbitLab__strip {
  display: flex;
  height: 12px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 2px;
}

/* A state that happens at all is never invisible.
   A penumbra crossing is 10–20 s of a ~96 minute orbit, so proportionally it is a
   third of a pixel — and "0.3% penumbra" printed under a strip with no blue in it
   reads as a bug. Two pixels overstates a sliver's width and understates nothing
   else; the percentages beside the strip are what carry the real proportions. */
.orbitLab__strip > span {
  flex-basis: 0;
  min-width: 2px;
}
</style>
