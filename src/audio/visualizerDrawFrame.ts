import {
  drawBloomCorona, drawMeridianScope, drawAuroraVeils, drawStarLattice,
  type Star,
} from "../components/player/visualizerPresets.js";

const silentFreq = new Uint8Array(512);
const idleTimeDomain = new Uint8Array(2048);
idleTimeDomain.fill(128);

export interface VisualizerDrawParams {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  timeSec: number;
  presetId: string;
  effectivePlay: boolean;
  freq?: Uint8Array;
  timeDomain?: Uint8Array;
  bloomSmooth: Float32Array;
  auroraCols: Float32Array;
  stars: Star[];
}

/** Clears the canvas and draws one visualization preset from frequency/time data. */
export function visualizerDrawFrame(params: VisualizerDrawParams): void {
  const {
    ctx, w, h, timeSec, presetId, effectivePlay,
    freq, timeDomain, bloomSmooth, auroraCols, stars,
  } = params;

  ctx.fillStyle = "rgba(12, 11, 10, 0.92)";
  ctx.fillRect(0, 0, w, h);

  const fr = freq?.length ? freq : silentFreq;
  const td = timeDomain?.length ? timeDomain : idleTimeDomain;

  if (presetId === "bloom") {
    drawBloomCorona(ctx, w, h, fr, timeSec, effectivePlay, bloomSmooth);
  } else if (presetId === "meridian") {
    drawMeridianScope(ctx, w, h, td, effectivePlay, timeSec);
  } else if (presetId === "aurora") {
    drawAuroraVeils(ctx, w, h, fr, timeSec, effectivePlay, auroraCols);
  } else {
    drawStarLattice(ctx, w, h, fr, timeSec, effectivePlay, stars);
  }
}
