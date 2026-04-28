import { describe, it, expect } from "vitest";
import "../_setup.js";

import { fmtEtaHuman, fmtRate, describeMediaError } from "../../src/lib/fmt.js";

describe("fmtEtaHuman", () => {
  it("seconds under a minute", () => {
    expect(fmtEtaHuman(15)).toBe("~15 с");
    expect(fmtEtaHuman(1)).toBe("~1 с");
  });
  it("rounds sub-second up to 1", () => {
    expect(fmtEtaHuman(0.4)).toBe("~1 с");
  });
  it("minutes under an hour", () => {
    expect(fmtEtaHuman(60)).toBe("~1 мин");
    expect(fmtEtaHuman(120)).toBe("~2 мин");
  });
  it("hours + minutes", () => {
    expect(fmtEtaHuman(3600)).toBe("~1 ч");
    expect(fmtEtaHuman(7260)).toBe("~2 ч 1 мин");
  });
  it("rejects invalid inputs", () => {
    expect(fmtEtaHuman(0)).toBeNull();
    expect(fmtEtaHuman(-5)).toBeNull();
    expect(fmtEtaHuman(NaN)).toBeNull();
    expect(fmtEtaHuman("abc")).toBeNull();
    expect(fmtEtaHuman(null)).toBeNull();
    expect(fmtEtaHuman(undefined)).toBeNull();
  });
});

describe("fmtRate", () => {
  it("bytes", () => {
    expect(fmtRate(500)).toBe("500 Б/с");
  });
  it("kilobytes", () => {
    expect(fmtRate(10_240)).toBe("10 КБ/с");
  });
  it("megabytes", () => {
    expect(fmtRate(1_500_000)).toBe("1.5 МБ/с");
  });
  it("boundary at 1_000_000", () => {
    expect(fmtRate(1_000_000)).toBe("1.0 МБ/с");
  });
  it("boundary at 1024", () => {
    expect(fmtRate(1024)).toBe("1 КБ/с");
  });
  it("zero", () => {
    expect(fmtRate(0)).toBe("0 Б/с");
  });
});

describe("describeMediaError", () => {
  it("maps known codes", () => {
    expect(describeMediaError(1)).toBe("MEDIA_ERR_ABORTED");
    expect(describeMediaError(2)).toBe("MEDIA_ERR_NETWORK");
    expect(describeMediaError(3)).toBe("MEDIA_ERR_DECODE");
    expect(describeMediaError(4)).toBe("MEDIA_ERR_SRC_NOT_SUPPORTED");
  });
  it("unknowns are labelled", () => {
    expect(describeMediaError(0)).toBe("UNKNOWN(0)");
    expect(describeMediaError(99)).toBe("UNKNOWN(99)");
  });
});
