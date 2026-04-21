<script setup>
import { ref, watch, onUnmounted } from "vue";

const props = defineProps({
  visible: { type: Boolean, default: true },
});

const YEP_IWT_AVATAR =
  "https://avatars.githubusercontent.com/u/53908805?v=4&s=96";

const REPLY_TEXT = "neegde.ru";

const devReply = ref("");
const showLoadingTyping = ref(false);

let typewriterChain = null;

function clearTypewriter() {
  if (typewriterChain != null) {
    clearTimeout(typewriterChain);
    typewriterChain = null;
  }
}

function runTypewriter() {
  clearTypewriter();
  devReply.value = "";
  showLoadingTyping.value = false;
  let i = 0;
  const step = () => {
    if (i < REPLY_TEXT.length) {
      devReply.value = REPLY_TEXT.slice(0, i + 1);
      i += 1;
      typewriterChain = window.setTimeout(step, 70);
    } else {
      showLoadingTyping.value = true;
      typewriterChain = null;
    }
  };
  typewriterChain = window.setTimeout(step, 550);
}

watch(
  () => props.visible,
  (v) => {
    clearTypewriter();
    devReply.value = "";
    showLoadingTyping.value = false;
    if (v) {
      runTypewriter();
    }
  },
  { immediate: true }
);

onUnmounted(() => {
  clearTypewriter();
});
</script>

<template>
  <Teleport to="body">
    <Transition name="app-splash-fade">
      <div
        v-if="visible"
        class="app-splash-layer"
        role="status"
        aria-busy="true"
      >
        <span class="vh">Загрузка приложения</span>

        <div class="app-splash-panel" aria-hidden="true">
          <div class="app-splash-chat">
            <div class="app-splash-chat-inner">
              <div class="msg msg--b">
                <div class="msg-bubble">
                  <p>Где слушаешь?</p>
                </div>
                <span class="msg-av msg-av--accent" aria-hidden="true" />
              </div>

              <div class="msg msg--a">
                <span class="msg-av msg-av--photo" aria-hidden="true">
                  <img
                    class="msg-av-img"
                    :src="YEP_IWT_AVATAR"
                    alt=""
                    decoding="async"
                  />
                </span>
                <div class="msg-bubble">
                  <p>
                    <span class="msg-brand">{{ devReply }}</span>
                    <span
                      v-show="devReply.length < REPLY_TEXT.length"
                      class="msg-caret"
                      aria-hidden="true"
                    />
                  </p>
                </div>
              </div>

              <div
                v-show="showLoadingTyping"
                class="msg msg--typing"
                aria-hidden="true"
              >
                <span class="msg-av msg-av--photo">
                  <img
                    class="msg-av-img"
                    :src="YEP_IWT_AVATAR"
                    alt=""
                    decoding="async"
                  />
                </span>
                <div class="typing" title="Загрузка">
                  <span class="typing-dot" />
                  <span class="typing-dot" />
                  <span class="typing-dot" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.vh {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

/* Opaque fill: underneath app (covers, home) must not show during splash transitions. */
.app-splash-layer {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  display: flex;
  align-items: stretch;
  justify-content: stretch;
  background-color: var(--bg);
  overflow: hidden;
  padding: clamp(8px, 1.5vmin, 18px) clamp(16px, 4.5vw, 56px);
  box-sizing: border-box;
}

.app-splash-panel {
  flex: 1;
  min-height: 0;
  width: 100%;
  max-height: 100%;
  display: flex;
  flex-direction: column;
  border: none;
  background: transparent;
  box-shadow: none;
}

.app-splash-chat {
  flex: 1;
  min-height: 0;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: clamp(8px, 2vmin, 24px) 0;
  overflow-y: auto;
}

/* Узкая колонка по центру экрана (и по горизонтали, и по вертикали). */
.app-splash-chat-inner {
  width: min(100%, 440px);
  flex-shrink: 0;
  margin-inline: auto;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: clamp(12px, 2.2vmin, 28px);
}

.msg {
  display: flex;
  align-items: flex-end;
  gap: clamp(8px, 1.6vmin, 16px);
  max-width: 100%;
  opacity: 0;
  transform: translateY(12px);
  animation: msg-in 0.45s cubic-bezier(0.22, 1, 0.36, 1) forwards;
}

.msg--typing {
  align-self: flex-start;
  opacity: 1;
  transform: none;
  animation: none;
}

.msg--a {
  flex-direction: row;
  align-self: flex-start;
}

.msg--b {
  align-self: flex-end;
  flex-direction: row-reverse;
}

.msg:nth-child(1) {
  animation-delay: 0.06s;
}

.msg:nth-child(2) {
  animation-delay: 0.12s;
}

.msg-av {
  flex-shrink: 0;
  width: clamp(52px, 9vmin, 92px);
  height: clamp(52px, 9vmin, 92px);
  border-radius: 50%;
  background: var(--surface-h);
  border: 1px solid var(--border);
}

.msg-av--accent {
  background: rgba(var(--accent-rgb), 0.12);
  border-color: rgba(var(--accent-rgb), 0.28);
  box-shadow: 0 0 0 1px rgba(var(--accent-rgb), 0.06) inset;
}

.msg-av--photo {
  padding: 0;
  overflow: hidden;
}

.msg-av-img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 50%;
}

.msg-bubble {
  max-width: min(100%, calc(100% - 3.5rem));
  padding: clamp(16px, 2.2vmin, 28px) clamp(20px, 3vmin, 40px);
  border-radius: clamp(18px, 2.8vmin, 28px);
  border: 1px solid var(--border);
  font-size: clamp(20px, 3.8vmin, 40px);
  line-height: 1.42;
  color: var(--text);
}

.msg--a .msg-bubble {
  background: var(--bg);
  border-bottom-left-radius: clamp(5px, 1vmin, 10px);
  min-height: clamp(3em, 8vmin, 5rem);
}

.msg--b .msg-bubble {
  background: rgba(var(--accent-rgb), 0.08);
  border-color: rgba(var(--accent-rgb), 0.2);
  border-bottom-right-radius: clamp(5px, 1vmin, 10px);
}

.msg-bubble p {
  margin: 0;
}

.msg--a .msg-bubble p {
  text-align: left;
}

.msg--b .msg-bubble p {
  text-align: right;
}

.msg-brand {
  font-weight: 800;
  font-size: 1em;
  letter-spacing: -0.02em;
  color: var(--accent-h);
  white-space: nowrap;
}

.msg-caret {
  display: inline-block;
  width: clamp(2px, 0.35vmin, 4px);
  height: 0.95em;
  margin-left: 4px;
  vertical-align: -0.1em;
  background: var(--accent-h);
  animation: caret-blink 0.9s step-end infinite;
}

.typing {
  display: inline-flex;
  align-items: center;
  gap: clamp(8px, 1.4vmin, 14px);
  padding: clamp(14px, 2.2vmin, 26px) clamp(18px, 3vmin, 36px);
  border-radius: clamp(18px, 3vmin, 30px);
  border: 1px dashed rgba(255, 255, 255, 0.12);
  background: rgba(0, 0, 0, 0.22);
}

.typing-dot {
  width: clamp(10px, 1.6vmin, 16px);
  height: clamp(10px, 1.6vmin, 16px);
  border-radius: 50%;
  background: var(--muted2);
  animation: typing-dot 1.05s ease-in-out infinite;
}

.typing-dot:nth-child(2) {
  animation-delay: 0.15s;
}

.typing-dot:nth-child(3) {
  animation-delay: 0.3s;
}

.app-splash-fade-enter-active .app-splash-panel,
.app-splash-fade-leave-active .app-splash-panel {
  transition: opacity 0.34s ease, transform 0.34s cubic-bezier(0.22, 1, 0.36, 1);
}

.app-splash-fade-enter-from .app-splash-panel,
.app-splash-fade-leave-to .app-splash-panel {
  opacity: 0;
  transform: translateY(10px) scale(0.99);
}

@keyframes msg-in {
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes caret-blink {
  0%,
  50% {
    opacity: 1;
  }
  51%,
  100% {
    opacity: 0;
  }
}

@keyframes typing-dot {
  0%,
  70%,
  100% {
    opacity: 0.25;
    transform: translateY(0);
  }

  35% {
    opacity: 1;
    transform: translateY(-4px);
    background: var(--accent-h);
  }
}

@media (prefers-reduced-motion: reduce) {
  .msg {
    animation: none;
    opacity: 1;
    transform: none;
  }

  .typing-dot {
    animation: none;
    opacity: 0.7;
  }

  .msg-caret {
    animation: none;
  }
}
</style>
