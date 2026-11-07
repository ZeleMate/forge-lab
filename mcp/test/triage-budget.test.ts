// The triage tools' $0.50/day budget (#8, #57), written before the code (#54).
// The day is driven by the fake clock, and the counter lives in a file so a
// restart doesn't reset it.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Budget } from "../src/triage/budget";
import { fakeClock } from "./helpers";

const CAP = 0.5;
const NOON = Date.parse("2026-11-07T12:00:00.000Z");

function budgetFile() {
  return join(mkdtempSync(join(tmpdir(), "forge-lab-budget-")), "triage-budget.json");
}

describe("Budget", () => {
  test("a new day starts with nothing spent", () => {
    const b = new Budget({ file: budgetFile(), capUsd: CAP, clock: fakeClock(NOON) });
    expect(b.status()).toEqual({ day: "2026-11-07", spentUsd: 0, capUsd: CAP, leftUsd: CAP });
  });

  test("spending adds up, and a call is allowed only if its estimate still fits", () => {
    const b = new Budget({ file: budgetFile(), capUsd: CAP, clock: fakeClock(NOON) });
    b.spend(0.3);
    b.spend(0.15);
    expect(b.status().spentUsd).toBeCloseTo(0.45);
    expect(b.allows(0.05)).toBe(true);
    expect(b.allows(0.051)).toBe(false);
  });

  test("once the cap is reached, nothing more is allowed, not even a free call", () => {
    const b = new Budget({ file: budgetFile(), capUsd: CAP, clock: fakeClock(NOON) });
    b.spend(0.5);
    expect(b.allows(0)).toBe(false);
    expect(b.status().leftUsd).toBe(0);
  });

  test("the day turns at midnight UTC, and the spend resets", () => {
    const clock = fakeClock(Date.parse("2026-11-07T23:59:59.000Z"));
    const b = new Budget({ file: budgetFile(), capUsd: CAP, clock });
    b.spend(0.5);
    expect(b.allows(0.01)).toBe(false);
    clock.sleep(1_000); // the fake clock's sleep moves `now` forward at once
    expect(b.status()).toEqual({ day: "2026-11-08", spentUsd: 0, capUsd: CAP, leftUsd: CAP });
    expect(b.allows(0.01)).toBe(true);
  });

  test("the spend survives a restart: a new Budget on the same file starts from it", () => {
    const file = budgetFile();
    new Budget({ file, capUsd: CAP, clock: fakeClock(NOON) }).spend(0.4);
    const again = new Budget({ file, capUsd: CAP, clock: fakeClock(NOON + 60_000) });
    expect(again.status().spentUsd).toBeCloseTo(0.4);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ day: "2026-11-07", spent_usd: 0.4 });
  });

  test("yesterday's file counts as nothing spent today", () => {
    const file = budgetFile();
    writeFileSync(file, JSON.stringify({ day: "2026-11-06", spent_usd: 0.5 }));
    const b = new Budget({ file, capUsd: CAP, clock: fakeClock(NOON) });
    expect(b.status().spentUsd).toBe(0);
  });

  test("an unreadable file is treated as fully spent, so a broken counter can't lift the cap", () => {
    const file = budgetFile();
    writeFileSync(file, "not json");
    const b = new Budget({ file, capUsd: CAP, clock: fakeClock(NOON) });
    expect(b.allows(0)).toBe(false);
  });
});
