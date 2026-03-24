/** 10 полос (Гц), типичная сетка графического эквалайзера */
export const EQ_BANDS = [
  { freq: 32, label: "32" },
  { freq: 64, label: "64" },
  { freq: 125, label: "125" },
  { freq: 250, label: "250" },
  { freq: 500, label: "500" },
  { freq: 1000, label: "1k" },
  { freq: 2000, label: "2k" },
  { freq: 4000, label: "4k" },
  { freq: 8000, label: "8k" },
  { freq: 16000, label: "16k" },
];

export const EQ_MIN_DB = -12;
export const EQ_MAX_DB = 12;

/** Значения в dB для peaking-фильтров; подобраны как «универсальные» пресеты */
export const EQ_PRESETS = [
  {
    id: "flat",
    name: "Ровно",
    hint: "Без изменений",
    gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  {
    id: "bass",
    name: "Бас",
    hint: "Низ для электроники и хип-хопа",
    gains: [7, 5, 3, 1, 0, 0, 0, 0, 1, 2],
  },
  {
    id: "treble",
    name: "Высокие",
    hint: "Яркость и детали",
    gains: [0, 0, 0, 0, 0, 1, 2, 4, 5, 6],
  },
  {
    id: "rock",
    name: "Рок",
    hint: "Классическая V-форма",
    gains: [5, 4, 2, 0, -1, -1, 0, 2, 3, 4],
  },
  {
    id: "pop",
    name: "Поп",
    hint: "Середина и верх — «радио»",
    gains: [0, 2, 3, 4, 3, 1, 0, 2, 3, 3],
  },
  {
    id: "jazz",
    name: "Джаз",
    hint: "Тёплый низ, мягкий верх",
    gains: [4, 3, 2, 1, 0, -1, -1, 0, 2, 3],
  },
  {
    id: "classical",
    name: "Классика",
    hint: "Чуть воздуха наверху",
    gains: [0, 0, 0, 0, 0, 0, 0, 0, 2, 3],
  },
  {
    id: "electronic",
    name: "Электро",
    hint: "Низ и верх, выемка в середине",
    gains: [6, 5, 3, 1, 0, 0, 2, 4, 5, 6],
  },
  {
    id: "vocal",
    name: "Вокал",
    hint: "Подчёркивание речи и пения",
    gains: [-1, -1, -2, -1, 2, 5, 4, 2, 0, -1],
  },
  {
    id: "acoustic",
    name: "Акустика",
    hint: "Сбалансировано для гитары и живого звука",
    gains: [2, 3, 2, 1, 0, 1, 2, 3, 3, 2],
  },
];

export const EQ_STORAGE_KEY = "neegdeEqualizerV1";

export function clampDb(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(EQ_MAX_DB, Math.max(EQ_MIN_DB, n));
}

export function parseStoredState(raw) {
  try {
    const o = JSON.parse(raw);
    if (!o || typeof o !== "object") return null;
    const gains = o.gains ?? o.bands;
    if (!Array.isArray(gains) || gains.length !== EQ_BANDS.length) return null;
    const bands = gains.map((g) => clampDb(g));
    let presetId =
      typeof o.presetId === "string" ? o.presetId : "flat";
    if (presetId !== "custom" && !EQ_PRESETS.some((p) => p.id === presetId)) {
      presetId = "flat";
    }
    return { gains: bands, presetId };
  } catch {
    return null;
  }
}

export function defaultEqGains() {
  return EQ_PRESETS[0].gains.slice();
}
