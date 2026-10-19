/**
 * Time abstraction so services can be unit-tested deterministically.
 */
export interface Clock {
  /** Current time as a Date. */
  now(): Date;
  /** Current time in milliseconds since the Unix epoch. */
  nowMs(): number;
  /** Current time in whole seconds since the Unix epoch. */
  nowUnix(): number;
}

export const systemClock: Clock = {
  now: () => new Date(),
  nowMs: () => Date.now(),
  nowUnix: () => Math.floor(Date.now() / 1000),
};

/** Clock pinned to a fixed instant; `advance()` moves it forward (tests). */
export class FixedClock implements Clock {
  constructor(private currentMs: number) {}

  now(): Date {
    return new Date(this.currentMs);
  }

  nowMs(): number {
    return this.currentMs;
  }

  nowUnix(): number {
    return Math.floor(this.currentMs / 1000);
  }

  set(date: Date | number): void {
    this.currentMs = typeof date === "number" ? date : date.getTime();
  }

  advance(ms: number): void {
    this.currentMs += ms;
  }
}
