// The triage tools' daily spending cap (#8: $0.50/day). The counter is saved in
// a file, so restarting the MCP server doesn't reset the day's spend. The day
// turns at midnight UTC, the same on the Mac and in CI.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Clock } from "../clock";

// The file's shape, in snake_case like the repo's other recorded JSON.
type Saved = { day: string; spent_usd: number };

export type BudgetStatus = { day: string; spentUsd: number; capUsd: number; leftUsd: number };

export class Budget {
  private readonly file: string;
  private readonly capUsd: number;
  private readonly clock: Clock;

  // A constructor that takes one options object reads clearly at the call site:
  // `new Budget({ file, capUsd: 0.5, clock })`.
  constructor(opts: { file: string; capUsd: number; clock: Clock }) {
    this.file = opts.file;
    this.capUsd = opts.capUsd;
    this.clock = opts.clock;
  }

  // `toISOString()` is always UTC, so its first 10 characters are the UTC date.
  private today(): string {
    return new Date(this.clock.now()).toISOString().slice(0, 10);
  }

  // Today's spend. A file from another day counts as 0; a file that can't be
  // read counts as the whole cap, so a broken counter can't lift the limit.
  private spentToday(): number {
    let saved: Saved;
    try {
      saved = JSON.parse(readFileSync(this.file, "utf8")) as Saved;
    } catch (error) {
      // No file yet is a normal first run; anything else is a broken counter.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      return this.capUsd;
    }
    if (typeof saved?.spent_usd !== "number" || typeof saved.day !== "string") return this.capUsd;
    return saved.day === this.today() ? saved.spent_usd : 0;
  }

  status(): BudgetStatus {
    const spentUsd = this.spentToday();
    return { day: this.today(), spentUsd, capUsd: this.capUsd, leftUsd: Math.max(0, this.capUsd - spentUsd) };
  }

  // Whether a call estimated at `estimateUsd` still fits under the cap. Once the
  // cap is reached, nothing fits, not even a call estimated at $0.
  allows(estimateUsd: number): boolean {
    const spent = this.spentToday();
    return spent < this.capUsd && spent + estimateUsd <= this.capUsd + 1e-12;
  }

  spend(usd: number): void {
    const saved: Saved = { day: this.today(), spent_usd: this.spentToday() + usd };
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(saved));
  }
}
