/**
 * Logical clock in unix seconds. Defaults to wall time but supports an offset so
 * scripts can fast-forward (e.g. past a credit due date) to demo repayment and
 * default handling deterministically.
 */
export class Clock {
  private offset = 0;

  now(): number {
    return Math.floor(Date.now() / 1000) + this.offset;
  }

  /** Advance the clock by N seconds (demo only). */
  advance(seconds: number): void {
    this.offset += seconds;
  }
}
