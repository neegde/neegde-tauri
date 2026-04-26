<script setup>
import { computed, ref, watch, onUnmounted } from "vue";

const props = defineProps({
  visible: { type: Boolean, default: true },
});

const emit = defineEmits(["complete"]);

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
      typewriterChain = window.setTimeout(() => {
        typewriterChain = null;
        emit("complete");
      }, 500);
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

<template src="./AppSplash.html"></template>

<style scoped src="./AppSplash.scoped.css"></style>

