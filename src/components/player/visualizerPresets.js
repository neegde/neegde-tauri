/** @type {Record<string, string>} */
export const PRESET_LABELS = {
  bloom: "Корона",
  meridian: "Меридиан",
  aurora: "Полярное сияние",
  lattice: "Созвездие",
};

const TWO_PI = Math.PI * 2;

/**
 * Extracts CSS --accent RGB triplet from a root element (e.g. canvas parent).
 *
 * Args:
 *     el: Element to call getComputedStyle on.
 *
 * Returns:
 *     Tuple [r, g, b] in 0–255, or default orange if missing.
 */
export function readAccentRgb(el) {
  if (!el || typeof getComputedStyle !== "function") return [252, 116, 29];
  const raw = getComputedStyle(el).getPropertyValue("--accent").trim();
  const m = raw.match(/^#([\da-f]{6})$/i);
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = raw.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return [252, 116, 29];
}

/**
 * Radial «solar corona» bars: energy radiates from center with soft bloom.
 *
 * Args:
 *     ctx: Canvas 2D context.
 *     w: Canvas width.
 *     h: Canvas height.
 *     freq: Byte frequency data (analyser frequencyBinCount length).
 *     t: Time in seconds for idle motion.
 *     playing: Whether audio is currently playing.
 *     smooth: Smoothed float array (same length as freq), mutated in place.
 */
export function drawBloomCorona(ctx, w, h, freq, t, playing, smooth) {
  const cx = w * 0.5;
  const cy = h * 0.52;
  const maxR = Math.min(w, h) * 0.48;
  const n = freq.length;
  const step = TWO_PI / 128;
  const parent = ctx.canvas?.parentElement;
  const [ar, ag, ab] = readAccentRgb(parent);

  for (let i = 0; i < 128; i++) {
    const fi = Math.floor((i / 128) * (n - 4)) + 2;
    const raw = freq[fi] / 255;
    const target = playing ? raw * raw : 0.06 + Math.sin(t * 1.7 + i * 0.08) * 0.04;
    smooth[i] += (target - smooth[i]) * 0.18;
    const s = smooth[i];
    const angle = i * step - Math.PI * 0.5;
    const len = maxR * (0.08 + s * 0.92);
    const x1 = cx + Math.cos(angle) * (maxR * 0.12);
    const y1 = cy + Math.sin(angle) * (maxR * 0.12);
    const x2 = cx + Math.cos(angle) * len;
    const y2 = cy + Math.sin(angle) * len;
    const alpha = 0.15 + s * 0.85;
    ctx.strokeStyle = `rgba(${ar},${ag},${ab},${alpha})`;
    ctx.lineWidth = 2 + s * 4;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  ctx.save();
  const pulse = playing ? 0.35 + smooth[32] * 0.65 : 0.2 + Math.sin(t * 2.2) * 0.05;
  const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR * 0.4);
  grd.addColorStop(0, `rgba(${ar},${ag},${ab},${0.12 * pulse})`);
  grd.addColorStop(0.5, `rgba(${ar},${ag + 40},${ab + 30},${0.04 * pulse})`);
  grd.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.arc(cx, cy, maxR * 0.35, 0, TWO_PI);
  ctx.fill();
  ctx.restore();
}

/**
 * Mirrored horizontal oscilloscope: waveform folds around the midline.
 *
 * Args:
 *     ctx: Canvas 2D context.
 *     w: Canvas width.
 *     h: Canvas height.
 *     timeData: Byte time-domain data from the analyser.
 *     playing: Whether playback is active.
 *     t: Time in seconds (for idle undulation when not playing).
 */
export function drawMeridianScope(ctx, w, h, timeData, playing, t) {
  const mid = h * 0.5;
  const len = timeData.length;
  const parent = ctx.canvas?.parentElement;
  const [ar, ag, ab] = readAccentRgb(parent);
  const idle = Math.sin(t * 1.25);

  ctx.lineWidth = 1.5;
  ctx.strokeStyle = `rgba(${ar},${ag},${ab},0.85)`;
  ctx.beginPath();
  for (let x = 0; x < w; x++) {
    const idx = Math.floor((x / w) * len);
    const v = (timeData[idx] - 128) / 128;
    const amp = playing ? v : Math.sin((x / w) * Math.PI * 6 + t * 4.2) * 0.15 * (0.85 + idle * 0.15);
    const y = mid + amp * mid * 0.85;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.strokeStyle = `rgba(${Math.min(255, ar + 40)},${ag + 20},${ab},0.45)`;
  ctx.beginPath();
  for (let x = 0; x < w; x++) {
    const idx = Math.floor((x / w) * len);
    const v = (timeData[idx] - 128) / 128;
    const amp = playing ? v : Math.sin((x / w) * Math.PI * 6 + t * 4.2) * 0.15 * (0.85 + idle * 0.15);
    const y = mid - amp * mid * 0.85;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(w, mid);
  ctx.stroke();
}

/**
 * Flowing aurora curtains driven by spectrum energy per column.
 *
 * Args:
 *     ctx: Canvas 2D context.
 *     w: Canvas width.
 *     h: Canvas height.
 *     freq: Byte frequency data.
 *     t: Time in seconds.
 *     playing: Whether audio plays.
 *     columnEnergy: Reusable Float32Array of column smoothed values.
 */
export function drawAuroraVeils(ctx, w, h, freq, t, playing, columnEnergy) {
  const cols = columnEnergy.length;
  const n = freq.length;
  for (let c = 0; c < cols; c++) {
    const fi = Math.floor((c / cols) * (n - 1));
    const raw = freq[fi] / 255;
    const target = playing ? raw : 0.12 + 0.06 * Math.sin(t * 1.1 + c * 0.4);
    columnEnergy[c] += (target - columnEnergy[c]) * 0.14;
  }

  const parent = ctx.canvas?.parentElement;
  const [ar, ag, ab] = readAccentRgb(parent);

  for (let c = 0; c < cols; c++) {
    const x = (c / cols) * w;
    const bw = w / cols + 1;
    const e = columnEnergy[c];
    const wave = Math.sin(t * 1.8 + c * 0.35) * 0.08;
    const hueShift = (c / cols + t * 0.03 + wave) % 1;
    const r = Math.min(255, ar + hueShift * 80);
    const g = Math.min(255, ag + (1 - hueShift) * 60);
    const b = Math.min(255, ab + e * 120);
    const g0 = ctx.createLinearGradient(x, h, x, 0);
    const tip = h * (1 - (0.15 + e * 0.8));
    g0.addColorStop(0, `rgba(${r * 0.1},${g * 0.15},${b * 0.2},0)`);
    g0.addColorStop(0.65, `rgba(${r},${g},${b},${0.12 + e * 0.5})`);
    g0.addColorStop(1, `rgba(${r},${g},${b},${0.35 + e * 0.45})`);
    ctx.fillStyle = g0;
    ctx.fillRect(x, tip, bw, h - tip);
  }

  ctx.fillStyle = `rgba(${ar},${ag},${ab},0.06)`;
  for (let i = 0; i < 40; i++) {
    const px = ((i * 73 + t * 35) % (w + 80)) - 40;
    const ph = 4 + (i % 5) * 3;
    ctx.fillRect(px, h * 0.15 + Math.sin(t + i) * 12, 2, ph);
  }
}

/**
 * Constellation of nodes linked when bass energy rises (beat feel).
 *
 * Args:
 *     ctx: Canvas 2D context.
 *     w: Canvas width.
 *     h: Canvas height.
 *     freq: Byte frequency data (use low bins for bass).
 *     t: Time in seconds.
 *     playing: Whether audio plays.
 *     stars: Array of {x,y,phase} normalized 0–1 coords.
 */
export function drawStarLattice(ctx, w, h, freq, t, playing, stars) {
  const bass =
    (freq[2] + freq[3] + freq[4] + freq[5]) / (4 * 255);
  const pulse = playing ? bass : 0.1 + Math.sin(t * 3) * 0.05;
  const parent = ctx.canvas?.parentElement;
  const [ar, ag, ab] = readAccentRgb(parent);

  const pts = stars.map((s, i) => ({
    x: s.x * w,
    y: s.y * h,
    r: 1.2 + pulse * 4 + Math.sin(t * 2 + s.phase) * 0.5,
    a: 0.25 + pulse * 0.65 + (i % 7) * 0.02,
  }));

  ctx.lineWidth = 1;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[i].x - pts[j].x;
      const dy = pts[i].y - pts[j].y;
      const d = Math.hypot(dx, dy);
      if (d < w * 0.22 && pulse > 0.18) {
        const lineA = (1 - d / (w * 0.22)) * pulse * 0.45;
        ctx.strokeStyle = `rgba(${ar},${ag},${ab},${lineA})`;
        ctx.beginPath();
        ctx.moveTo(pts[i].x, pts[i].y);
        ctx.lineTo(pts[j].x, pts[j].y);
        ctx.stroke();
      }
    }
  }

  for (const p of pts) {
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 6);
    g.addColorStop(0, `rgba(255,255,255,${p.a})`);
    g.addColorStop(0.4, `rgba(${ar},${ag},${ab},${p.a * 0.9})`);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r * 6, 0, TWO_PI);
    ctx.fill();
  }
}

/**
 * Builds fixed pseudo-random star positions for the lattice preset.
 *
 * Args:
 *     count: Number of points.
 *     seed: Seed string for deterministic layout.
 *
 * Returns:
 *     Array of {x,y,phase} with x,y in 0…1.
 */
export function buildStarField(count, seed) {
  const out = [];
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  for (let i = 0; i < count; i++) {
    h = Math.imul(h ^ i, 1103515245);
    const x = ((h >>> 0) % 10000) / 10000 * 0.85 + 0.075;
    h = Math.imul(h ^ (i * 13), 1103515245);
    const y = ((h >>> 0) % 10000) / 10000 * 0.78 + 0.08;
    h = Math.imul(h + i, 2654435761);
    const phase = ((h >>> 0) % 6283) / 1000;
    out.push({ x, y, phase });
  }
  return out;
}
