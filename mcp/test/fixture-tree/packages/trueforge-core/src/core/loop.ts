// The loop that runs Turns.
export class Loop {
  run(turns: number): number {
    return turns + 1;
  }
}

export function startLoop(): Loop {
  return new Loop();
}

export interface LoopOptions {
  maxTurns: number;
  onTurn(turn: number): void;
}
