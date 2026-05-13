import { ref } from "vue";

export type CoverReloadStepState = "pending" | "success" | "fail" | "info";

export interface CoverReloadStep {
  id: number;
  text: string;
  state: CoverReloadStepState;
}

export interface CoverReloadToastState {
  open: boolean;
  runId: number;
  title: string;
  summary: string;
  done: boolean;
  ok: boolean | null;
  steps: CoverReloadStep[];
}

export const coverReloadToast = ref<CoverReloadToastState>({
  open: false,
  runId: 0,
  title: "",
  summary: "",
  done: false,
  ok: null,
  steps: [],
});

let nextRunId = 1;
let nextStepId = 1;

/**
 * Opens the floating cover reload status card and returns the run id.
 *
 * @param title - Short user-visible title for the current cover search.
 * @param summary - Initial summary line.
 * @returns Numeric run id used by subsequent step updates.
 */
export function beginCoverReload(title: string, summary = "Ищу обложку…"): number {
  const runId = nextRunId++;
  coverReloadToast.value = {
    open: true,
    runId,
    title,
    summary,
    done: false,
    ok: null,
    steps: [],
  };
  return runId;
}

/**
 * Adds a step to the active cover reload status card.
 *
 * @param runId - Run id returned by `beginCoverReload`.
 * @param text - Human-readable step description.
 * @param state - Visual state for the step.
 * @returns void
 */
export function addCoverReloadStep(
  runId: number,
  text: string,
  state: CoverReloadStepState = "info",
): void {
  const cur = coverReloadToast.value;
  if (cur.runId !== runId) return;
  if (cur.done) return;
  coverReloadToast.value = {
    ...cur,
    steps: [...cur.steps, { id: nextStepId++, text, state }],
  };
}

/**
 * Updates the summary line without finishing the current run.
 *
 * @param runId - Run id returned by `beginCoverReload`.
 * @param summary - New summary line.
 * @returns void
 */
export function updateCoverReloadSummary(runId: number, summary: string): void {
  const cur = coverReloadToast.value;
  if (cur.runId !== runId) return;
  if (cur.done) return;
  coverReloadToast.value = { ...cur, summary };
}

/**
 * Marks the active cover reload run as finished.
 *
 * @param runId - Run id returned by `beginCoverReload`.
 * @param ok - Whether a cover was found.
 * @param summary - Final summary line.
 * @returns void
 */
export function finishCoverReload(runId: number, ok: boolean, summary: string): void {
  const cur = coverReloadToast.value;
  if (cur.runId !== runId) return;
  if (cur.done) return;
  coverReloadToast.value = {
    ...cur,
    summary,
    done: true,
    ok,
  };
}

/**
 * Closes the floating cover reload status card.
 *
 * @returns void
 */
export function dismissCoverReload(): void {
  coverReloadToast.value = { ...coverReloadToast.value, open: false };
}
