/**
 * Lazy cover loader for Track / Album entities.
 *
 * Both entity kinds expose `coverUrl()` / `startCoverFetch()` polymorphically
 * (Track hierarchy in `src/track/`, Album hierarchy in `src/album/`).
 *
 * IntersectionObserver (400 px margin) kicks the lazy fetch when the root
 * element enters the viewport and cancels it when the element leaves — this
 * prevents wasted requests when SoulSeek search results shift rapidly.
 * Unmount tears everything down.
 */

import { ref, computed, watch, onMounted, onUnmounted, type Ref, unref } from "vue";
import type { Track } from "../track/Track.js";
import type { Album } from "../album/Album.js";
import { entitiesVersion } from "../stores/entities.js";
import { slskConnected } from "../stores/auth.js";
import { appDebugLog } from "../appDebugLog.js";

const FETCH_TIMEOUT_MS = 20_000;
/** Spinner only after this delay so fast cache hits / iTunes covers avoid flicker. */
const FETCHING_SPINNER_DELAY_MS = 160;
/** SoulSeek folder guess may run before the peer address resolves — retry while still visible. */
const SLSK_COVER_RETRY_DELAYS_MS = [2500, 8000];

type Entity = Track | Album | null | undefined;

/** Duck-type: both Track and Album expose `coverUrl()` + `startCoverFetch()`. */
function hasCoverApi(e: Entity): e is Track | Album {
  return !!e && typeof (e as Track | Album).coverUrl === "function" &&
    typeof (e as Track | Album).startCoverFetch === "function";
}

/** Reactive cover URL — delegates to the entity's polymorphic method. */
function coverOfEntity(entity: Entity): string | null {
  if (!hasCoverApi(entity)) return null;
  // Touch the version ref so album-registry updates refresh consumers.
  entitiesVersion.value;
  return entity.coverUrl();
}

export type UseEntityCoverOptions = {
  /**
   * When false, SoulSeek tracks skip peer folder guessing (`peerGuess: off`);
   * ref-based and enriched covers still apply.
   */
  autoPeerCover?: Ref<boolean> | boolean;
};

export function useEntityCover(
  entityRef: Ref<Entity>,
  rootRef: Ref<HTMLElement | null>,
  coverOptions?: UseEntityCoverOptions,
) {
  const coverErr = ref(false);
  const fetching = ref(false);
  const coverUrl = computed(() => coverOfEntity(entityRef.value));

  let observer: IntersectionObserver | null = null;
  let fetchTimer: ReturnType<typeof setTimeout> | null = null;
  let spinnerDelayTimer: ReturnType<typeof setTimeout> | null = null;
  let abortCtrl: AbortController | null = null;
  /** True after first intersecting frame until the row leaves the IO root. */
  let intersectArmed = false;
  let slskRetryTimers: ReturnType<typeof setTimeout>[] = [];

  function resolveAutoPeerCover(): boolean {
    const raw = coverOptions?.autoPeerCover;
    if (raw === undefined) return true;
    return unref(raw);
  }

  function guessOptFor(ent: Track | Album) {
    return ent.kind === "soulseek" && !resolveAutoPeerCover()
      ? { peerGuess: "off" as const }
      : undefined;
  }

  function clearSlskRetryTimers(): void {
    for (const t of slskRetryTimers) clearTimeout(t);
    slskRetryTimers = [];
  }

  function clearSpinnerDelay(): void {
    if (spinnerDelayTimer) {
      clearTimeout(spinnerDelayTimer);
      spinnerDelayTimer = null;
    }
  }

  function clearTimer(): void {
    if (fetchTimer) { clearTimeout(fetchTimer); fetchTimer = null; }
  }

  function cancelFetch(): void {
    abortCtrl?.abort();
    abortCtrl = null;
  }

  function disconnect(): void {
    if (observer) { observer.disconnect(); observer = null; }
  }

  /**
   * Re-runs peer cover fetch for the same visible row after delays so a late
   * GetPeerAddress / login does not leave the UI stuck after the first miss.
   *
   * @param armedEntityId - Entity id at arm time; ignored if the row swapped.
   */
  function scheduleSlskCoverRetries(armedEntityId: string): void {
    clearSlskRetryTimers();
    if (!resolveAutoPeerCover()) return;
    SLSK_COVER_RETRY_DELAYS_MS.forEach((ms, idx) => {
      const tid = setTimeout(() => {
        const cur = entityRef.value;
        if (!intersectArmed || !hasCoverApi(cur) || cur.id !== armedEntityId) return;
        if (cur.kind !== "soulseek" || cur.coverUrl()) return;
        if (!resolveAutoPeerCover()) return;
        void appDebugLog("cover", `entity: slsk cover retry ${idx + 2} — ${cur.kind}:${cur.id}`);
        cancelFetch();
        abortCtrl = new AbortController();
        cur.startCoverFetch(abortCtrl.signal, guessOptFor(cur));
      }, ms);
      slskRetryTimers.push(tid);
    });
  }

  function arm(): void {
    disconnect();
    cancelFetch();
    clearSlskRetryTimers();
    intersectArmed = false;
    coverErr.value = false;
    fetching.value = false;
    clearTimer();
    clearSpinnerDelay();
    const ent = entityRef.value;
    if (!hasCoverApi(ent)) return;
    if (ent.coverUrl()) return;  // already cached

    observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        const now = entry.isIntersecting;
        if (now && !intersectArmed) {
          intersectArmed = true;
          cancelFetch();
          abortCtrl = new AbortController();
          fetching.value = false;
          clearSpinnerDelay();
          spinnerDelayTimer = setTimeout(() => {
            spinnerDelayTimer = null;
            fetching.value = true;
          }, FETCHING_SPINNER_DELAY_MS);
          clearTimer();
          fetchTimer = setTimeout(() => {
            void appDebugLog("cover", `entity: timeout 20s — ${ent.kind}:${ent.id}`);
            fetching.value = false;
            fetchTimer = null;
            clearSpinnerDelay();
          }, FETCH_TIMEOUT_MS);
          void appDebugLog("cover", `entity: visible — ${ent.kind}:${ent.id}`);
          const cur = entityRef.value;
          if (!hasCoverApi(cur)) return;
          cur.startCoverFetch(abortCtrl.signal, guessOptFor(cur));
          if (cur.kind === "soulseek" && resolveAutoPeerCover()) {
            scheduleSlskCoverRetries(cur.id);
          }
        } else if (!now && intersectArmed) {
          intersectArmed = false;
          clearSlskRetryTimers();
          void appDebugLog("cover", `entity: left viewport — ${ent.kind}:${ent.id}`);
          cancelFetch();
          clearTimer();
          clearSpinnerDelay();
          if (!coverUrl.value) fetching.value = false;
        }
      },
      { rootMargin: "400px" },
    );
    if (rootRef.value) observer.observe(rootRef.value);
  }

  watch(slskConnected, (on, wasOn) => {
    if (!on) return;
    if (wasOn) return;
    const cur = entityRef.value;
    if (!intersectArmed || !hasCoverApi(cur) || cur.coverUrl()) return;
    if (cur.kind !== "soulseek" || !resolveAutoPeerCover()) return;
    void appDebugLog("cover", `entity: slsk session up — retry cover ${cur.kind}:${cur.id}`);
    clearSlskRetryTimers();
    cancelFetch();
    abortCtrl = new AbortController();
    cur.startCoverFetch(abortCtrl.signal, guessOptFor(cur));
    scheduleSlskCoverRetries(cur.id);
  });

  watch(coverUrl, (v) => {
    if (v) {
      const ent = entityRef.value;
      void appDebugLog("cover", `entity: loaded — ${ent?.kind}:${ent?.id}`);
      fetching.value = false;
      clearSpinnerDelay();
      clearTimer();
      clearSlskRetryTimers();
      cancelFetch();
      // Cover found — observer no longer needed
      disconnect();
    }
  });

  watch(() => entityRef.value, (newEnt, oldEnt) => {
    if (newEnt === oldEnt) return;
    coverErr.value = false;
    fetching.value = false;
    clearTimer();
    clearSpinnerDelay();
    clearSlskRetryTimers();
    arm();
  });

  onMounted(arm);
  onUnmounted(() => {
    disconnect();
    clearTimer();
    clearSpinnerDelay();
    clearSlskRetryTimers();
    cancelFetch();
  });

  return { coverUrl, coverErr, fetching };
}
