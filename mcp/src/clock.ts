// The time seam (#54): code that waits or counts days asks a Clock instead of
// calling Date.now() or setTimeout itself, so a test can pass a fake that jumps
// ahead instantly. The sessions tools (`wait_turn`) and the triage budget use it.

export type Clock = {
  now(): number; // milliseconds since the epoch, like Date.now()
  sleep(ms: number): Promise<void>;
};

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => Bun.sleep(ms),
};
