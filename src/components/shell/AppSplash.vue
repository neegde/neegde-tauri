<script setup>
import { computed, ref, watch, onUnmounted } from "vue";

const props = defineProps({
  visible: { type: Boolean, default: true },
});

const QUESTION_TEXT = "Где слушаешь?";

const REPLY_TEXT = "neegde.ru";

const SPLASH_TYPE_START_MS = 320;

const SPLASH_TYPE_CHAR_MS = 42;

const SPLASH_TYPE_LINE_GAP_MS = 140;

const questionText = ref("");

const devReply = ref("");

const showTypingIndicator = ref(false);

// Second row: only after question is done and reply has started (no empty box).
const replyBubbleVisible = computed(
  () =>
    questionText.value.length >= QUESTION_TEXT.length && devReply.value.length > 0
);

let typewriterChain = null;

/**
 * Clears any scheduled typewriter step.
 */
function clearTypewriter() {
  if (typewriterChain != null) {
    clearTimeout(typewriterChain);
    typewriterChain = null;
  }
}

/**
 * Types the question, then the reply; then shows the typing dots until splash hides.
 */
function runTypewriter() {
  clearTypewriter();
  questionText.value = "";
  devReply.value = "";
  showTypingIndicator.value = false;

  /**
   * Schedules progressive typing of `full` into `targetRef`, then calls `onComplete`.
   */
  function typeLine(full, targetRef, pauseMs, onComplete) {
    typewriterChain = window.setTimeout(() => {
      let i = 0;
      const step = () => {
        if (i < full.length) {
          targetRef.value = full.slice(0, i + 1);
          i += 1;
          typewriterChain = window.setTimeout(step, SPLASH_TYPE_CHAR_MS);
        } else {
          typewriterChain = null;
          if (onComplete) {
            onComplete();
          }
        }
      };
      step();
    }, pauseMs);
  }

  typeLine(QUESTION_TEXT, questionText, SPLASH_TYPE_START_MS, () => {
    typeLine(REPLY_TEXT, devReply, SPLASH_TYPE_LINE_GAP_MS, () => {
      showTypingIndicator.value = true;
    });
  });
}

watch(
  () => props.visible,
  (v) => {
    clearTypewriter();
    questionText.value = "";
    devReply.value = "";
    showTypingIndicator.value = false;
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
                  <p>
                    {{ questionText }}<span
                      v-show="questionText.length < QUESTION_TEXT.length"
                      class="msg-caret msg-caret--question"
                      aria-hidden="true"
                    />
                  </p>
                </div>
              </div>

              <div v-show="replyBubbleVisible" class="msg msg--a">
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
                v-show="showTypingIndicator"
                class="msg msg--typing"
                aria-hidden="true"
              >
                <div class="typing typing-messenger" title="Загрузка">
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
}

.msg--typing {
  align-self: flex-start;
}

.msg--a {
  flex-direction: row;
  align-self: flex-start;
}

.msg--b {
  align-self: flex-end;
  flex-direction: row-reverse;
}

.msg-bubble {
  max-width: 100%;
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

.msg-caret--question {
  background: var(--text);
  opacity: 0.85;
}

.typing {
  display: inline-flex;
  align-items: center;
  gap: 0;
  padding: 0;
  border: none;
  background: transparent;
}

/* Incoming bubble + three dots, messenger-style wave. */
.typing-messenger {
  align-items: center;
  justify-content: center;
  gap: clamp(5px, 0.85vmin, 8px);
  min-width: clamp(56px, 12vmin, 76px);
  min-height: clamp(38px, 6vmin, 48px);
  padding: clamp(10px, 1.6vmin, 14px) clamp(14px, 2.2vmin, 18px);
  border-radius: clamp(16px, 2.5vmin, 22px);
  border-bottom-left-radius: clamp(4px, 0.7vmin, 8px);
  border: 1px solid var(--border);
  background: var(--bg);
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.06);
}

.typing-dot {
  display: block;
  width: clamp(7px, 1.15vmin, 10px);
  height: clamp(7px, 1.15vmin, 10px);
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--muted2);
  animation: typing-dot-bounce 1.35s ease-in-out infinite;
}

.typing-dot:nth-child(2) {
  animation-delay: 0.18s;
}

.typing-dot:nth-child(3) {
  animation-delay: 0.36s;
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

@keyframes typing-dot-bounce {
  0%,
  66%,
  100% {
    transform: translateY(0);
    opacity: 0.55;
  }

  33% {
    transform: translateY(-6px);
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .msg-caret {
    animation: none;
  }

  .typing-dot {
    animation: none;
    opacity: 0.7;
    transform: none;
  }
}
</style>
