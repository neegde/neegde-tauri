<script setup>
const props = defineProps({
  /** Controlled visibility. */
  open: { type: Boolean, default: false },
  /** Rows: { id, title, description, unlocked }. */
  rows: { type: Array, default: () => [] },
});

const emit = defineEmits(["update:open"]);

/**
 * Closes the modal.
 *
 * Returns:
 *     void
 */
function close() {
  emit("update:open", false);
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="ach-modal-overlay"
      role="presentation"
      @click.self="close"
    >
      <div
        class="ach-modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ach-modal-title"
        @click.stop
      >
        <div class="ach-modal-head">
          <h2 id="ach-modal-title" class="ach-modal-title">Достижения</h2>
          <button type="button" class="ach-modal-x" title="Закрыть" @click="close">×</button>
        </div>
        <p class="ach-modal-hint">
          Список может со временем расти — здесь удобно листать всё сразу.
        </p>
        <ul class="ach-modal-list" aria-label="Все достижения">
          <li
            v-for="row in rows"
            :key="row.id"
            :class="{
              'ach-modal-row': true,
              'ach-modal-row--stub': row.stub,
              'ach-modal-row--ok': !row.stub && row.unlocked,
              'ach-modal-row--locked': !row.stub && !row.unlocked,
            }"
          >
            <span class="ach-modal-row-mark" aria-hidden="true">
              {{ row.stub ? "—" : row.unlocked ? "✓" : "○" }}
            </span>
            <span class="ach-modal-row-body">
              <span class="ach-modal-row-title">
                {{ row.title }}
                <span v-if="row.stub" class="ach-modal-stub-badge">заглушка</span>
              </span>
              <span class="ach-modal-row-desc">{{ row.description }}</span>
            </span>
          </li>
        </ul>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ach-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 9600;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(4px);
}

.ach-modal-panel {
  width: 100%;
  max-width: 420px;
  max-height: min(72vh, 560px);
  display: flex;
  flex-direction: column;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--surface);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35);
  overflow: hidden;
}

.ach-modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px 8px;
  flex-shrink: 0;
}

.ach-modal-title {
  margin: 0;
  font-size: 17px;
  font-weight: 700;
  color: var(--text);
}

.ach-modal-x {
  width: 34px;
  height: 34px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
}

.ach-modal-x:hover {
  background: var(--surface-h);
  color: var(--text);
}

.ach-modal-hint {
  margin: 0 16px 10px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--muted2);
}

.ach-modal-list {
  list-style: none;
  margin: 0;
  padding: 0 12px 14px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}

.ach-modal-row {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 10px 12px;
  margin-bottom: 8px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--surface) 92%, var(--bg));
}

.ach-modal-row:last-child {
  margin-bottom: 0;
}

.ach-modal-row--ok {
  border-color: color-mix(in srgb, var(--accent) 35%, var(--border));
}

.ach-modal-row--locked {
  opacity: 0.75;
}
.ach-modal-row--stub {
  opacity: 0.88;
  border-style: dashed;
}
.ach-modal-stub-badge {
  display: inline-block;
  margin-left: 8px;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  vertical-align: middle;
  color: var(--muted2);
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--surface) 85%, var(--bg));
}

.ach-modal-row-mark {
  flex-shrink: 0;
  width: 22px;
  text-align: center;
  color: var(--muted);
  font-size: 13px;
}

.ach-modal-row--ok .ach-modal-row-mark {
  color: var(--accent);
}

.ach-modal-row-body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.ach-modal-row-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.ach-modal-row-desc {
  font-size: 12px;
  line-height: 1.4;
  color: var(--muted);
}
</style>
