<script setup>
import { ref, computed, watch, onUnmounted } from "vue";
import { login, loginViaWebview, checkConnectivity } from "../../rutracker/auth.js";
import {
  RT_HTTP_PROXY_PX1,
  RT_HTTP_PROXY_PX2,
  setHttpProxy,
  setRtHttpProxyCache,
} from "../../rutracker/proxyConfig.js";
import { soulseekLogin, soulseekSaveCredentials } from "../../soulseek/api.js";

const props = defineProps({
  visible:       { type: Boolean, default: false },
  rtLoggedIn:    { type: Boolean, default: false },
  rtUsername:    { type: String,  default: null },
  slskConnected: { type: Boolean, default: false },
  slskUsername:  { type: String,  default: null },
});

const emit = defineEmits(["close", "rt-connected", "slsk-connected"]);

// ── Step machine ──────────────────────────────────────────────────────────
// 0=welcome  1=rutracker  2=soulseek  3=done
const step       = ref(0);
const shownItems = ref(0);
const showBtns   = ref(false);

// Per-step item counts: how many things animate in before buttons appear
const STEP_ITEMS = [2, 2, 2, 2];

let timers = [];
function clearTimers() { for (const t of timers) clearTimeout(t); timers = []; }

function runStep(s) {
  clearTimers();
  shownItems.value = 0;
  showBtns.value   = false;
  const count = STEP_ITEMS[s] ?? 2;
  let delay = 220;
  for (let i = 0; i < count; i++) {
    const idx = i + 1;
    timers.push(setTimeout(() => { shownItems.value = idx; }, delay));
    delay += 680;
  }
  timers.push(setTimeout(() => { showBtns.value = true; }, delay + 100));

  if (s === 1) {
    void runRtConnectivityCheck();
  }
}

function advance() {
  if (step.value >= 3) { emit("close"); return; }
  step.value += 1;
  runStep(step.value);
}

watch(
  () => props.visible,
  (v) => {
    if (v) {
      // Reset login form states on re-show
      rtState.value  = props.rtLoggedIn    ? "success" : "idle";
      rtWho.value    = props.rtUsername    ?? "";
      slskState.value = props.slskConnected ? "success" : "idle";
      slskWho.value  = props.slskUsername  ?? "";
      rtReachable.value  = null;
      rtConnError.value  = "";
      rtNeedsCaptcha.value = false;
      rtWebviewBusy.value  = false;
      step.value = 0;
      runStep(0);
    } else {
      clearTimers();
      shownItems.value = 0;
      showBtns.value   = false;
    }
  },
  { immediate: true },
);

onUnmounted(clearTimers);

// ── Rutracker connectivity / proxy ───────────────────────────────────────
const rtReachable   = ref(null);       // null = unknown, true/false once probed
const rtChecking    = ref(false);
const rtConnError   = ref("");         // human-readable last probe error
const rtProxyBusy   = ref("");         // "" | "px1" | "px2" | "off" while switching
const rtActiveProxy = ref("");         // preset id currently active ("" | "px1" | "px2" | "other")

function presetIdFor(url) {
  if (!url) return "";
  if (url === RT_HTTP_PROXY_PX1) return "px1";
  if (url === RT_HTTP_PROXY_PX2) return "px2";
  return "other";
}

async function runRtConnectivityCheck() {
  if (rtChecking.value) return;
  if (props.rtLoggedIn) { rtReachable.value = true; return; }
  rtChecking.value = true;
  rtConnError.value = "";
  try {
    const res = await checkConnectivity();
    rtReachable.value  = !!res?.reachable;
    rtConnError.value  = res?.error || "";
    rtActiveProxy.value = presetIdFor(res?.using_proxy || "");
  } catch (e) {
    rtReachable.value = false;
    rtConnError.value = String(e?.message || e);
    rtActiveProxy.value = "";
  } finally {
    rtChecking.value = false;
  }
}

async function applyProxyPreset(presetId) {
  if (rtProxyBusy.value) return;
  rtProxyBusy.value = presetId;
  rtConnError.value = "";
  try {
    const url =
      presetId === "px1" ? RT_HTTP_PROXY_PX1 :
      presetId === "px2" ? RT_HTTP_PROXY_PX2 :
      "";
    await setHttpProxy(url || null);
    setRtHttpProxyCache(url || null);
    await runRtConnectivityCheck();
  } catch (e) {
    rtConnError.value = String(e?.message || e);
  } finally {
    rtProxyBusy.value = "";
  }
}

// ── Rutracker login (form + webview fallback) ────────────────────────────
const rtUser  = ref("");
const rtPass  = ref("");
const rtState = ref("idle"); // idle | loading | success | error
const rtError = ref("");
const rtWho   = ref("");
const rtNeedsCaptcha = ref(false);
const rtWebviewBusy  = ref(false);

const rtConnected = computed(() => rtState.value === "success" || props.rtLoggedIn);

function isCaptchaError(msg) {
  if (!msg) return false;
  const m = String(msg).toLowerCase();
  return m.includes("captcha") || m.includes("каптч") || m.includes("капч");
}

async function submitRt(e) {
  e.preventDefault();
  if (!rtUser.value.trim() || !rtPass.value) return;
  rtState.value = "loading";
  rtError.value = "";
  rtNeedsCaptcha.value = false;
  try {
    const res = await login(rtUser.value.trim(), rtPass.value);
    if (res.success) {
      rtWho.value = res.username || rtUser.value.trim();
      emit("rt-connected", res.username, res.avatar_url || null);
      rtState.value = "success";
      rtUser.value  = "";
      rtPass.value  = "";
    } else {
      rtError.value = res.error || "Ошибка входа";
      rtNeedsCaptcha.value = isCaptchaError(res.error);
      rtState.value = "error";
    }
  } catch {
    rtError.value = "Нет соединения — проверьте зеркало и интернет";
    rtState.value = "error";
    void runRtConnectivityCheck();
  }
}

async function runWebviewLogin() {
  if (rtWebviewBusy.value) return;
  rtWebviewBusy.value = true;
  rtError.value = "";
  try {
    const res = await loginViaWebview();
    if (res?.success) {
      rtWho.value = res.username || rtUser.value.trim() || "подключено";
      emit("rt-connected", res.username, res.avatar_url || null);
      rtState.value = "success";
      rtNeedsCaptcha.value = false;
      rtUser.value = "";
      rtPass.value = "";
    } else {
      rtError.value = res?.error || "Вход не завершён";
      rtState.value = "error";
    }
  } catch (e) {
    rtError.value = String(e?.message || e);
    rtState.value = "error";
  } finally {
    rtWebviewBusy.value = false;
  }
}

// ── SoulSeek login ────────────────────────────────────────────────────────
const slskUser  = ref("");
const slskPass  = ref("");
const slskState = ref("idle");
const slskError = ref("");
const slskWho   = ref("");

const slskConnectedLocal = computed(() => slskState.value === "success" || props.slskConnected);

async function submitSlsk(e) {
  e.preventDefault();
  if (!slskUser.value.trim() || !slskPass.value) return;
  slskState.value = "loading";
  slskError.value = "";
  try {
    const res = await soulseekLogin(slskUser.value.trim(), slskPass.value);
    if (res.success) {
      slskWho.value = res.username || slskUser.value.trim();
      emit("slsk-connected", slskWho.value);
      soulseekSaveCredentials(slskUser.value.trim(), slskPass.value).catch(() => {});
      slskState.value = "success";
      slskUser.value  = "";
      slskPass.value  = "";
    } else {
      slskError.value = res.error || "Ошибка подключения";
      slskState.value = "error";
    }
  } catch {
    slskError.value = "Ошибка — проверьте логин и пароль";
    slskState.value = "error";
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="ob-fade-layer">
      <div
        v-if="visible"
        class="ob-layer"
        role="dialog"
        aria-modal="true"
        aria-label="Начало работы"
      >
        <div class="ob-panel">
          <div class="ob-chat">
            <Transition name="ob-step" mode="out-in">
              <div :key="step" class="ob-inner">

                <!-- ═══════════════════════════════════ Step 0: Welcome ═══ -->
                <template v-if="step === 0">
                  <div
                    class="ob-msg ob-item"
                    :class="{ 'ob-item--visible': shownItems >= 1 }"
                  >
                    <div class="ob-bubble">
                      <p>Добро пожаловать в нигде.</p>
                    </div>
                  </div>
                  <div
                    class="ob-msg ob-item"
                    :class="{ 'ob-item--visible': shownItems >= 2 }"
                  >
                    <div class="ob-bubble">
                      <p>Ищи музыку по Rutracker и SoulSeek — слушай прямо в приложении, без скачивания.</p>
                    </div>
                  </div>
                  <Transition name="ob-btns">
                    <div v-if="showBtns" class="ob-actions">
                      <button type="button" class="ob-btn ob-btn--primary" @click="advance">
                        Дальше
                      </button>
                    </div>
                  </Transition>
                </template>

                <!-- ══════════════════════════════════ Step 1: Rutracker ══ -->
                <template v-else-if="step === 1">
                  <div
                    class="ob-msg ob-item"
                    :class="{ 'ob-item--visible': shownItems >= 1 }"
                  >
                    <div class="ob-bubble">
                      <p>
                        Rutracker — альбомы и торрент-раздачи.
                        Нужен аккаунт форума rutracker.org — логин и пароль те же, что на сайте.
                      </p>
                    </div>
                  </div>

                  <!-- Login card -->
                  <div
                    class="ob-card ob-item"
                    :class="{ 'ob-item--visible': shownItems >= 2 }"
                  >
                    <!-- Success state -->
                    <div v-if="rtConnected" class="ob-card-success">
                      <span class="ob-success-icon" aria-hidden="true">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                             stroke="currentColor" stroke-width="2.5"
                             stroke-linecap="round" stroke-linejoin="round">
                          <polyline points="20 6 9 17 4 12"/>
                        </svg>
                      </span>
                      <span>Подключено{{ rtWho ? ` как ${rtWho}` : "" }}</span>
                    </div>

                    <!-- Probing connectivity -->
                    <div
                      v-else-if="rtChecking && rtReachable === null"
                      class="ob-card-probing"
                    >
                      <span class="spinner" />
                      <span>Проверяем доступность Rutracker…</span>
                    </div>

                    <!-- Site unreachable — offer built-in proxy presets -->
                    <div v-else-if="rtReachable === false" class="ob-card-unreachable">
                      <p class="ob-unreach-title">Rutracker недоступен</p>
                      <p class="ob-unreach-desc">
                        Скорее всего сайт заблокирован. Попробуй встроенные прокси —
                        они подменяют маршрут только для запросов к Rutracker.
                      </p>
                      <p v-if="rtConnError" class="ob-form-error">{{ rtConnError }}</p>
                      <div class="ob-proxy-row">
                        <button
                          type="button"
                          class="ob-btn ob-btn--ghost ob-btn--small"
                          :class="{ 'ob-btn--active': rtActiveProxy === 'px1' }"
                          :disabled="!!rtProxyBusy || rtChecking"
                          @click="applyProxyPreset('px1')"
                        >
                          <span v-if="rtProxyBusy === 'px1'" class="spinner" />
                          <template v-else>Прокси 1</template>
                        </button>
                        <button
                          type="button"
                          class="ob-btn ob-btn--ghost ob-btn--small"
                          :class="{ 'ob-btn--active': rtActiveProxy === 'px2' }"
                          :disabled="!!rtProxyBusy || rtChecking"
                          @click="applyProxyPreset('px2')"
                        >
                          <span v-if="rtProxyBusy === 'px2'" class="spinner" />
                          <template v-else>Прокси 2</template>
                        </button>
                        <button
                          type="button"
                          class="ob-btn ob-btn--ghost ob-btn--small"
                          :disabled="!!rtProxyBusy || rtChecking"
                          @click="runRtConnectivityCheck"
                        >
                          <span v-if="rtChecking" class="spinner" />
                          <template v-else>Проверить</template>
                        </button>
                      </div>
                    </div>

                    <!-- Login form -->
                    <form v-else class="ob-form" @submit="submitRt">
                      <input
                        v-model="rtUser"
                        class="login-input ob-form-input"
                        type="text"
                        placeholder="Логин"
                        autocomplete="username"
                        :disabled="rtState === 'loading' || rtWebviewBusy"
                      />
                      <input
                        v-model="rtPass"
                        class="login-input ob-form-input"
                        type="password"
                        placeholder="Пароль"
                        autocomplete="current-password"
                        :disabled="rtState === 'loading' || rtWebviewBusy"
                      />
                      <p v-if="rtError" class="ob-form-error">{{ rtError }}</p>
                      <p v-if="rtActiveProxy === 'px1' || rtActiveProxy === 'px2'" class="ob-form-hint">
                        Используется встроенный прокси ({{ rtActiveProxy === 'px1' ? 'Прокси 1' : 'Прокси 2' }}).
                      </p>
                      <button
                        type="submit"
                        class="login-btn ob-form-submit"
                        :disabled="rtState === 'loading' || rtWebviewBusy || !rtUser.trim() || !rtPass"
                      >
                        <span v-if="rtState === 'loading'" class="spinner" />
                        <template v-else>Войти в Rutracker</template>
                      </button>

                      <!-- Webview fallback (CAPTCHA / Cloudflare) -->
                      <button
                        v-if="rtNeedsCaptcha || rtWebviewBusy"
                        type="button"
                        class="login-btn ob-form-submit ob-form-submit--ghost"
                        :disabled="rtState === 'loading' || rtWebviewBusy"
                        @click="runWebviewLogin"
                      >
                        <span v-if="rtWebviewBusy" class="spinner" />
                        <template v-else>Войти через встроенный браузер</template>
                      </button>
                      <p v-if="rtNeedsCaptcha && !rtWebviewBusy" class="ob-form-hint">
                        Сайт просит подтвердить, что вход не автоматический — откроется окно браузера,
                        в котором нужно ввести логин/пароль и пройти проверку.
                      </p>
                    </form>
                  </div>

                  <!-- Nav -->
                  <Transition name="ob-btns">
                    <div v-if="showBtns" class="ob-actions">
                      <button
                        type="button"
                        class="ob-btn"
                        :class="rtConnected ? 'ob-btn--primary' : 'ob-btn--ghost'"
                        :disabled="rtState === 'loading' || rtWebviewBusy"
                        @click="advance"
                      >
                        {{ rtConnected ? "Дальше" : "Пропустить" }}
                      </button>
                    </div>
                  </Transition>
                </template>

                <!-- ═══════════════════════════════════ Step 2: SoulSeek ══ -->
                <template v-else-if="step === 2">
                  <div
                    class="ob-msg ob-item"
                    :class="{ 'ob-item--visible': shownItems >= 1 }"
                  >
                    <div class="ob-bubble">
                      <p>
                        SoulSeek — треки напрямую от пользователей.
                        Нужен аккаунт на soulseek.net — или пропусти, если не нужен.
                      </p>
                    </div>
                  </div>

                  <!-- Login card -->
                  <div
                    class="ob-card ob-item"
                    :class="{ 'ob-item--visible': shownItems >= 2 }"
                  >
                    <!-- Success state -->
                    <div v-if="slskConnectedLocal" class="ob-card-success">
                      <span class="ob-success-icon" aria-hidden="true">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                             stroke="currentColor" stroke-width="2.5"
                             stroke-linecap="round" stroke-linejoin="round">
                          <polyline points="20 6 9 17 4 12"/>
                        </svg>
                      </span>
                      <span>Подключено{{ slskWho ? ` как ${slskWho}` : "" }}</span>
                    </div>

                    <!-- Login form -->
                    <form v-else class="ob-form" @submit="submitSlsk">
                      <input
                        v-model="slskUser"
                        class="login-input ob-form-input"
                        type="text"
                        placeholder="Логин"
                        autocomplete="username"
                        :disabled="slskState === 'loading'"
                      />
                      <input
                        v-model="slskPass"
                        class="login-input ob-form-input"
                        type="password"
                        placeholder="Пароль"
                        autocomplete="current-password"
                        :disabled="slskState === 'loading'"
                      />
                      <p v-if="slskError" class="ob-form-error">{{ slskError }}</p>
                      <button
                        type="submit"
                        class="login-btn ob-form-submit"
                        :disabled="slskState === 'loading' || !slskUser.trim() || !slskPass"
                      >
                        <span v-if="slskState === 'loading'" class="spinner" />
                        <template v-else>Подключить SoulSeek</template>
                      </button>
                    </form>
                  </div>

                  <!-- Nav -->
                  <Transition name="ob-btns">
                    <div v-if="showBtns" class="ob-actions">
                      <button
                        type="button"
                        class="ob-btn"
                        :class="slskConnectedLocal ? 'ob-btn--primary' : 'ob-btn--ghost'"
                        :disabled="slskState === 'loading'"
                        @click="advance"
                      >
                        {{ slskConnectedLocal ? "Дальше" : "Пропустить" }}
                      </button>
                    </div>
                  </Transition>
                </template>

                <!-- ════════════════════════════════════════ Step 3: Done ══ -->
                <template v-else-if="step === 3">
                  <div
                    class="ob-msg ob-item"
                    :class="{ 'ob-item--visible': shownItems >= 1 }"
                  >
                    <div class="ob-bubble">
                      <p>Всё готово.</p>
                    </div>
                  </div>
                  <div
                    class="ob-msg ob-item"
                    :class="{ 'ob-item--visible': shownItems >= 2 }"
                  >
                    <div class="ob-bubble">
                      <p>Открой строку поиска сверху — введи трек, исполнителя или альбом.</p>
                    </div>
                  </div>
                  <Transition name="ob-btns">
                    <div v-if="showBtns" class="ob-actions">
                      <button type="button" class="ob-btn ob-btn--primary" @click="emit('close')">
                        Начать
                      </button>
                    </div>
                  </Transition>
                </template>

              </div>
            </Transition>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* ── Layer / panel / chat column ────────────────────────────────────────── */
.ob-layer {
  position: fixed;
  inset: 0;
  z-index: 2147482000;
  display: flex;
  align-items: stretch;
  justify-content: stretch;
  background-color: var(--bg);
  overflow: hidden;
  padding: clamp(8px, 1.5vmin, 18px) clamp(16px, 4.5vw, 56px);
  box-sizing: border-box;
}

.ob-panel {
  flex: 1;
  min-height: 0;
  width: 100%;
  display: flex;
  flex-direction: column;
}

.ob-chat {
  flex: 1;
  min-height: 0;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: clamp(8px, 2vmin, 24px) 0;
  overflow-y: auto;
}

.ob-inner {
  width: min(100%, 440px);
  flex-shrink: 0;
  margin-inline: auto;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: clamp(12px, 2.2vmin, 26px);
}

/* ── Text bubble (left-aligned, matches splash msg--a) ──────────────────── */
.ob-msg {
  display: flex;
  align-items: flex-end;
  align-self: flex-start;
  max-width: 100%;
}

.ob-bubble {
  max-width: 100%;
  padding: clamp(14px, 2vmin, 24px) clamp(18px, 2.6vmin, 34px);
  border-radius: clamp(16px, 2.5vmin, 22px);
  border-bottom-left-radius: clamp(4px, 0.8vmin, 8px);
  border: 1px solid var(--border);
  background: var(--bg);
  font-size: clamp(17px, 3.1vmin, 32px);
  line-height: 1.46;
  color: var(--text);
}

.ob-bubble p {
  margin: 0;
  text-align: left;
}

/* ── Login card ─────────────────────────────────────────────────────────── */
.ob-card {
  border: 1px solid var(--border);
  border-radius: clamp(12px, 1.8vmin, 16px);
  background: var(--surface);
  overflow: hidden;
}

/* Success banner inside card */
.ob-card-success {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: clamp(14px, 2vmin, 20px) clamp(16px, 2.2vmin, 22px);
  font-size: clamp(13px, 2vmin, 15px);
  color: var(--accent);
  font-weight: 600;
}

.ob-success-icon {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

/* Probing banner inside card */
.ob-card-probing {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: clamp(14px, 2vmin, 20px) clamp(16px, 2.2vmin, 22px);
  font-size: clamp(13px, 2vmin, 15px);
  color: var(--muted);
}

/* Unreachable block inside card */
.ob-card-unreachable {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: clamp(14px, 2vmin, 20px) clamp(16px, 2.2vmin, 22px);
}
.ob-unreach-title {
  margin: 0;
  font-size: clamp(13px, 2vmin, 15px);
  font-weight: 700;
  color: var(--text);
}
.ob-unreach-desc {
  margin: 0;
  font-size: clamp(12px, 1.8vmin, 13px);
  color: var(--muted);
  line-height: 1.4;
}
.ob-proxy-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
}

/* Form inside card */
.ob-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: clamp(14px, 2vmin, 20px) clamp(16px, 2.2vmin, 22px);
}

.ob-form-input {
  width: 100%;
  box-sizing: border-box;
  font-size: clamp(13px, 1.9vmin, 14px);
}

.ob-form-error {
  margin: 0;
  font-size: clamp(11px, 1.6vmin, 12px);
  color: var(--red, #e05252);
}

.ob-form-hint {
  margin: 0;
  font-size: clamp(11px, 1.6vmin, 12px);
  color: var(--muted);
  line-height: 1.4;
}

.ob-form-submit {
  width: 100%;
  font-size: clamp(12px, 1.8vmin, 13px);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 36px;
}
.ob-form-submit--ghost {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text);
}
.ob-form-submit--ghost:not(:disabled):hover {
  border-color: var(--muted);
}

/* ── Action buttons (below card / bubbles) ──────────────────────────────── */
.ob-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.ob-btn {
  font-size: clamp(13px, 1.9vmin, 15px);
  font-weight: 600;
  padding: clamp(9px, 1.4vmin, 13px) clamp(20px, 3vmin, 30px);
  border-radius: 999px;
  border: none;
  cursor: pointer;
  transition: opacity 0.15s, background 0.15s;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.ob-btn:disabled { opacity: 0.45; cursor: not-allowed; }

.ob-btn--primary { background: var(--accent); color: #000; }
.ob-btn--primary:not(:disabled):hover  { opacity: 0.85; }
.ob-btn--primary:not(:disabled):active { opacity: 0.70; }

.ob-btn--ghost {
  background: transparent;
  color: var(--muted);
  border: 1px solid var(--border);
}
.ob-btn--ghost:not(:disabled):hover  { color: var(--text); border-color: var(--muted); }
.ob-btn--ghost:not(:disabled):active { opacity: 0.7; }

.ob-btn--small {
  font-size: clamp(12px, 1.6vmin, 13px);
  padding: clamp(6px, 1vmin, 9px) clamp(14px, 2vmin, 18px);
  font-weight: 500;
}
.ob-btn--active {
  border-color: var(--accent);
  color: var(--accent);
}

/* ── Staggered entrance animation ───────────────────────────────────────── */
.ob-item {
  opacity: 0;
  transform: translateY(10px);
  transition:
    opacity 0.34s ease,
    transform 0.34s cubic-bezier(0.22, 1, 0.36, 1);
}
.ob-item--visible {
  opacity: 1;
  transform: none;
}

/* ── Layer entrance / exit ──────────────────────────────────────────────── */
.ob-fade-layer-enter-active .ob-panel,
.ob-fade-layer-leave-active .ob-panel {
  transition: opacity 0.34s ease, transform 0.34s cubic-bezier(0.22, 1, 0.36, 1);
}
.ob-fade-layer-enter-from .ob-panel,
.ob-fade-layer-leave-to   .ob-panel {
  opacity: 0;
  transform: translateY(10px) scale(0.99);
}

/* Step cross-fade */
.ob-step-enter-active { transition: opacity 0.2s ease; }
.ob-step-leave-active { transition: opacity 0.15s ease; }
.ob-step-enter-from,
.ob-step-leave-to     { opacity: 0; }

/* Buttons entrance */
.ob-btns-enter-active {
  transition: opacity 0.28s ease, transform 0.28s cubic-bezier(0.22, 1, 0.36, 1);
}
.ob-btns-enter-from { opacity: 0; transform: translateY(6px); }

@media (prefers-reduced-motion: reduce) {
  .ob-item,
  .ob-fade-layer-enter-active .ob-panel,
  .ob-fade-layer-leave-active .ob-panel,
  .ob-step-enter-active,
  .ob-step-leave-active,
  .ob-btns-enter-active {
    transition: none;
  }
}
</style>
