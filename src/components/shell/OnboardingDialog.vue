<script setup lang="ts">
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

const emit = defineEmits<{
  (e: "close"): void;
  (e: "rt-connected", username: string, avatarUrl: string | null): void;
  (e: "slsk-connected", username: string): void;
}>();

// ── Step machine ──────────────────────────────────────────────────────────────
// 0=welcome  1=rutracker  2=soulseek  3=done
const step       = ref(0);
const shownItems = ref(0);
const showBtns   = ref(false);

const STEP_ITEMS = [2, 2, 2, 2];

let timers: ReturnType<typeof setTimeout>[] = [];
function clearTimers() { for (const t of timers) clearTimeout(t); timers = []; }

// Declared before `watch(..., { immediate: true })` — that watcher runs synchronously
// when registered and touches these refs (TDZ if they were defined below the watch).
const rtReachable   = ref<boolean | null>(null);
const rtChecking    = ref(false);
const rtConnError   = ref("");
const rtProxyBusy   = ref("");
const rtActiveProxy = ref("");

const rtUser  = ref("");
const rtPass  = ref("");
const rtState = ref<"idle" | "loading" | "success" | "error">("idle");
const rtError = ref("");
const rtWho   = ref("");
const rtNeedsCaptcha = ref(false);
const rtWebviewBusy  = ref(false);

const slskUser  = ref("");
const slskPass  = ref("");
const slskState = ref<"idle" | "loading" | "success" | "error">("idle");
const slskError = ref("");
const slskWho   = ref("");

function runStep(s: number) {
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
      rtState.value   = props.rtLoggedIn    ? "success" : "idle";
      rtWho.value     = props.rtUsername    ?? "";
      slskState.value = props.slskConnected ? "success" : "idle";
      slskWho.value   = props.slskUsername  ?? "";
      rtReachable.value    = null;
      rtConnError.value    = "";
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

function presetIdFor(url: string | undefined | null): string {
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
    rtReachable.value   = !!res?.reachable;
    rtConnError.value   = res?.error || "";
    rtActiveProxy.value = presetIdFor(res?.using_proxy || "");
  } catch (e: unknown) {
    rtReachable.value = false;
    rtConnError.value = String((e as Error)?.message || e);
    rtActiveProxy.value = "";
  } finally {
    rtChecking.value = false;
  }
}

async function applyProxyPreset(presetId: string) {
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
  } catch (e: unknown) {
    rtConnError.value = String((e as Error)?.message || e);
  } finally {
    rtProxyBusy.value = "";
  }
}

const rtConnected = computed(() => rtState.value === "success" || props.rtLoggedIn);

function isCaptchaError(msg: string): boolean {
  const m = String(msg).toLowerCase();
  return m.includes("captcha") || m.includes("каптч") || m.includes("капч");
}

async function submitRt(e: Event) {
  e.preventDefault();
  if (!rtUser.value.trim() || !rtPass.value) return;
  rtState.value = "loading";
  rtError.value = "";
  rtNeedsCaptcha.value = false;
  try {
    const res = await login(rtUser.value.trim(), rtPass.value);
    if (res.success) {
      rtWho.value = res.username || rtUser.value.trim();
      emit("rt-connected", res.username ?? rtWho.value, res.avatar_url ?? null);
      rtState.value = "success";
      rtUser.value  = "";
      rtPass.value  = "";
    } else {
      rtError.value = res.error || "Ошибка входа";
      rtNeedsCaptcha.value = isCaptchaError(res.error || "");
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
      emit("rt-connected", res.username ?? rtWho.value, res.avatar_url ?? null);
      rtState.value = "success";
      rtNeedsCaptcha.value = false;
      rtUser.value = "";
      rtPass.value = "";
    } else {
      rtError.value = res?.error || "Вход не завершён";
      rtState.value = "error";
    }
  } catch (e: unknown) {
    rtError.value = String((e as Error)?.message || e);
    rtState.value = "error";
  } finally {
    rtWebviewBusy.value = false;
  }
}

const slskConnectedLocal = computed(() => slskState.value === "success" || props.slskConnected);

async function submitSlsk(e: Event) {
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

<template src="./OnboardingDialog.html"></template>

<style scoped src="./OnboardingDialog.scoped.css"></style>
