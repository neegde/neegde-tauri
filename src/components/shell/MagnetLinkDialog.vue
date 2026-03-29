<script setup>
import { toRefs } from "vue";

const props = defineProps({
  /** Validation / backend error message. */
  error: { type: String, default: null },
  /** Waiting for librqbit metadata (DHT / trackers). */
  resolving: { type: Boolean, default: false },
});

const { error, resolving } = toRefs(props);

const open = defineModel("open", { type: Boolean, default: false });
const draft = defineModel("draft", { type: String, default: "" });

const emit = defineEmits(["submit", "close"]);

function onOverlayClick() {
  emit("close");
}

function onSubmit() {
  emit("submit");
}

function onKeydown(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    if (!resolving.value) emit("submit");
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="magnet-link">
      <div
        v-if="open"
        class="magnet-link-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="magnet-link-title"
        @click.self="onOverlayClick"
      >
        <div class="magnet-link-panel" @click.stop>
          <div class="magnet-link-head">
            <span v-if="resolving" class="magnet-link-spinner" aria-hidden="true" />
            <h2 id="magnet-link-title" class="magnet-link-phase">
              {{ resolving ? "Получение метаданных" : "Открыть по magnet-ссылке" }}
            </h2>
          </div>

          <p class="magnet-link-msg">
            {{
              resolving
                ? "Подключаемся к торрент-сети (DHT и трекеры). Первый раз это может занять время."
                : "Вставьте ссылку из буфера — список треков появится, как у раздачи с RuTracker."
            }}
          </p>

          <div
            v-if="resolving"
            class="magnet-link-bar-wrap magnet-link-bar-wrap--pulse"
          >
            <div class="magnet-link-bar magnet-link-bar--indet" />
          </div>

          <textarea
            v-model="draft"
            class="magnet-link-input"
            :class="{ 'magnet-link-input--dim': resolving }"
            placeholder="magnet:?xt=urn:btih:…"
            rows="4"
            autocomplete="off"
            spellcheck="false"
            :disabled="resolving"
            @keydown="onKeydown"
          />

          <p v-if="error" class="magnet-link-error">{{ error }}</p>

          <p class="magnet-link-hint">
            BitTorrent зависит от сидов и сети — как при скачивании альбома на диск.
          </p>

          <div class="magnet-link-actions">
            <button
              type="button"
              class="magnet-link-btn magnet-link-btn--ghost"
              :disabled="resolving"
              @click="onOverlayClick"
            >
              Отмена
            </button>
            <button
              type="button"
              class="magnet-link-btn magnet-link-btn--primary"
              :disabled="resolving"
              @click="onSubmit"
            >
              <span v-if="resolving" class="magnet-link-btn-spinner" aria-hidden="true" />
              <template v-else>Открыть</template>
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.magnet-link-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(6px);
  box-sizing: border-box;
}

.magnet-link-panel {
  width: min(440px, 100%);
  padding: 22px 22px 18px;
  border-radius: 12px;
  background: var(--surface, #181818);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.45);
}

.magnet-link-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.magnet-link-phase {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-weight: 700;
  font-size: 16px;
  letter-spacing: -0.02em;
  color: var(--text, #fff);
}

.magnet-link-spinner {
  width: 22px;
  height: 22px;
  border: 2px solid var(--border, rgba(255, 255, 255, 0.12));
  border-top-color: var(--accent, #1db954);
  border-radius: 50%;
  animation: magnet-link-spin 0.7s linear infinite;
  flex-shrink: 0;
}

@keyframes magnet-link-spin {
  to {
    transform: rotate(360deg);
  }
}

.magnet-link-msg {
  color: var(--muted, #b3b3b3);
  font-size: 13px;
  margin: 0 0 14px;
  line-height: 1.45;
}

.magnet-link-bar-wrap {
  height: 6px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.08);
  overflow: hidden;
  margin-bottom: 14px;
}

.magnet-link-bar-wrap--pulse {
  overflow: hidden;
}

.magnet-link-bar {
  height: 100%;
  border-radius: 3px;
  background: linear-gradient(
    90deg,
    var(--accent, #1db954),
    var(--accent-h, #1ed760)
  );
  transition: width 0.25s ease-out;
}

.magnet-link-bar--indet {
  width: 40% !important;
  animation: magnet-link-indet 1.2s ease-in-out infinite;
}

@keyframes magnet-link-indet {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(350%);
  }
}

.magnet-link-input {
  width: 100%;
  box-sizing: border-box;
  min-height: 96px;
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
  background: rgba(0, 0, 0, 0.22);
  color: var(--text, #fff);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
  font-size: 12px;
  line-height: 1.45;
  resize: vertical;
  transition: opacity 0.2s ease;
}

.magnet-link-input--dim {
  opacity: 0.45;
  pointer-events: none;
}

.magnet-link-input:focus {
  outline: none;
  border-color: rgba(29, 185, 84, 0.45);
  box-shadow: 0 0 0 1px rgba(29, 185, 84, 0.2);
}

.magnet-link-input::placeholder {
  color: var(--muted, #b3b3b3);
}

.magnet-link-input:disabled {
  cursor: not-allowed;
}

.magnet-link-error {
  margin: 10px 0 0;
  font-size: 13px;
  color: #f87171;
  line-height: 1.4;
}

.magnet-link-hint {
  margin: 12px 0 0;
  font-size: 11px;
  color: var(--muted2, #535353);
  line-height: 1.4;
}

.magnet-link-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 16px;
}

.magnet-link-btn {
  min-height: 40px;
  padding: 0 18px;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  cursor: pointer;
  border: 1px solid transparent;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  transition: background 0.15s ease, border-color 0.15s ease, opacity 0.15s ease;
}

.magnet-link-btn--ghost {
  background: rgba(255, 255, 255, 0.05);
  border-color: var(--border, rgba(255, 255, 255, 0.12));
  color: var(--muted, #b3b3b3);
}

.magnet-link-btn--ghost:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text, #fff);
  border-color: rgba(255, 255, 255, 0.2);
}

.magnet-link-btn--primary {
  background: linear-gradient(180deg, #1ed760 0%, var(--accent, #1db954) 100%);
  color: #0a0a0a;
  border-color: transparent;
  box-shadow: 0 4px 16px rgba(29, 185, 84, 0.25);
}

.magnet-link-btn--primary:hover:not(:disabled) {
  filter: brightness(1.06);
  box-shadow: 0 6px 20px rgba(29, 185, 84, 0.35);
}

.magnet-link-btn--primary:disabled {
  opacity: 0.55;
  cursor: not-allowed;
  filter: none;
}

.magnet-link-btn-spinner {
  width: 18px;
  height: 18px;
  border: 2px solid rgba(0, 0, 0, 0.2);
  border-top-color: rgba(0, 0, 0, 0.65);
  border-radius: 50%;
  animation: magnet-link-spin 0.7s linear infinite;
}

.magnet-link-enter-active,
.magnet-link-leave-active {
  transition: opacity 0.22s ease;
}

.magnet-link-enter-active .magnet-link-panel,
.magnet-link-leave-active .magnet-link-panel {
  transition: transform 0.22s ease, opacity 0.22s ease;
}

.magnet-link-enter-from,
.magnet-link-leave-to {
  opacity: 0;
}

.magnet-link-enter-from .magnet-link-panel,
.magnet-link-leave-to .magnet-link-panel {
  transform: scale(0.96) translateY(6px);
  opacity: 0;
}

[data-theme="light"] .magnet-link-panel {
  background: #fff;
  border-color: rgba(0, 0, 0, 0.1);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.12);
}

[data-theme="light"] .magnet-link-input {
  background: rgba(0, 0, 0, 0.04);
  border-color: rgba(0, 0, 0, 0.12);
}

[data-theme="light"] .magnet-link-btn--primary {
  color: #042;
}
</style>
