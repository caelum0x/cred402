import { test } from "node:test";
import assert from "node:assert/strict";

import { AutonomousScheduler } from "../lib/keeperhub/scheduler.js";

/**
 * Deterministic tests for the AutonomousScheduler core. The whole point of the
 * scheduler is that `tick(now)` is pure w.r.t. wall-clock time: we inject the
 * clock via the constructor (`new AutonomousScheduler(() => T)`) and always pass
 * an explicit `now` to `tick`, so nothing here depends on real timers.
 */

// A mutable clock closure — flip `T` between assertions to advance "wall time".
function fakeClock() {
  let t = 0;
  const now = () => t;
  return { now, set: (v: number) => (t = v) };
}

// ---------------------------------------------------------------------------
// Interval scheduling
// ---------------------------------------------------------------------------

test("scheduler: interval logic runs each job only when its interval has elapsed", async () => {
  const clock = fakeClock();
  const sched = new AutonomousScheduler(clock.now);

  let aRuns = 0;
  let bRuns = 0;
  sched.addJob({ name: "A", interval_sec: 30, run: () => void aRuns++ });
  sched.addJob({ name: "B", interval_sec: 60, run: () => void bRuns++ });

  // First tick: neither has ever run → both due.
  const r1 = await sched.tick(1000);
  assert.equal(r1.length, 2);
  assert.equal(aRuns, 1);
  assert.equal(bRuns, 1);

  // t=1030: A due (1030-1000=30 >= 30); B not due (1030-1000=30 < 60).
  const r2 = await sched.tick(1030);
  assert.equal(r2.length, 1);
  assert.equal(r2[0]!.job, "A");
  assert.equal(aRuns, 2);
  assert.equal(bRuns, 1);

  // t=1060: A due (1060-1030=30 >= 30); B due (1060-1000=60 >= 60).
  const r3 = await sched.tick(1060);
  assert.equal(r3.length, 2);
  assert.equal(aRuns, 3);
  assert.equal(bRuns, 2);

  // status() reflects the exact run counts + due bookkeeping.
  const status = sched.status();
  const a = status.jobs.find((j) => j.name === "A")!;
  const b = status.jobs.find((j) => j.name === "B")!;

  assert.equal(a.runs, 3);
  assert.equal(a.last_run_at, 1060);
  assert.equal(a.next_due_at, 1060 + 30); // last_run_at + interval_sec

  assert.equal(b.runs, 2);
  assert.equal(b.last_run_at, 1060);
  assert.equal(b.next_due_at, 1060 + 60);
});

// ---------------------------------------------------------------------------
// First-run
// ---------------------------------------------------------------------------

test("scheduler: a fresh job (last_run_at undefined) is always due on the first tick", async () => {
  const clock = fakeClock();
  const sched = new AutonomousScheduler(clock.now);

  let ran = 0;
  sched.addJob({ name: "fresh", interval_sec: 999_999, run: () => void ran++ });

  // Even with a huge interval, a never-run job fires on the very first tick.
  const runs = await sched.tick(5);
  assert.equal(runs.length, 1);
  assert.equal(ran, 1);

  const j = sched.status().jobs.find((x) => x.name === "fresh")!;
  assert.equal(j.last_run_at, 5);
  assert.equal(j.next_due_at, 5 + 999_999);
});

// ---------------------------------------------------------------------------
// Disabled jobs
// ---------------------------------------------------------------------------

test("scheduler: a disabled job does not run; re-enabling makes it due again", async () => {
  const clock = fakeClock();
  const sched = new AutonomousScheduler(clock.now);

  let ranEnabledFalse = 0;
  let ranToggled = 0;

  // Disabled at registration time.
  sched.addJob({ name: "off", interval_sec: 10, enabled: false, run: () => void ranEnabledFalse++ });
  // Enabled, then flipped off via setEnabled.
  sched.addJob({ name: "toggle", interval_sec: 10, run: () => void ranToggled++ });

  assert.equal(sched.setEnabled("toggle", false), true);
  assert.equal(sched.setEnabled("does-not-exist", false), false);

  // Neither should run while disabled.
  const r1 = await sched.tick(100);
  assert.equal(r1.length, 0);
  assert.equal(ranEnabledFalse, 0);
  assert.equal(ranToggled, 0);

  // Re-enable both → both are due (still never run).
  assert.equal(sched.setEnabled("off", true), true);
  assert.equal(sched.setEnabled("toggle", true), true);

  const r2 = await sched.tick(200);
  assert.equal(r2.length, 2);
  assert.equal(ranEnabledFalse, 1);
  assert.equal(ranToggled, 1);
});

// ---------------------------------------------------------------------------
// Result summaries (defaultSummarize)
// ---------------------------------------------------------------------------

test("scheduler: run results are summarized into a one-line history entry", async () => {
  const clock = fakeClock();
  const sched = new AutonomousScheduler(clock.now);

  sched.addJob({ name: "fleet", interval_sec: 1, run: () => ({ summary: { evaluated: 2, executed: 1 } }) });
  sched.addJob({ name: "autos", interval_sec: 1, run: () => ({ runs: [1, 2] }) });
  sched.addJob({ name: "verbatim", interval_sec: 1, run: () => "deleveraged 3 positions" });

  const runs = await sched.tick(1);
  const byJob = new Map(runs.map((r) => [r.job, r]));

  // { summary: { evaluated, executed } } → "evaluated N, executed M"
  assert.equal(byJob.get("fleet")!.summary, "evaluated 2, executed 1");
  // { runs: [...] } → "N automation(s) fired"
  assert.equal(byJob.get("autos")!.summary, "2 automation(s) fired");
  // a raw string is used verbatim
  assert.equal(byJob.get("verbatim")!.summary, "deleveraged 3 positions");

  // All succeeded.
  for (const r of runs) assert.equal(r.ok, true);
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

test("scheduler: a throwing job fails in isolation; other due jobs still run", async () => {
  const clock = fakeClock();
  const sched = new AutonomousScheduler(clock.now);

  let okRuns = 0;
  sched.addJob({
    name: "boom",
    interval_sec: 5,
    run: () => {
      throw new Error("kaboom");
    },
  });
  sched.addJob({ name: "survivor", interval_sec: 5, run: () => void okRuns++ });

  const runs = await sched.tick(10);
  assert.equal(runs.length, 2);

  const boom = runs.find((r) => r.job === "boom")!;
  const survivor = runs.find((r) => r.job === "survivor")!;

  // The failing job is reported not-ok with its error message.
  assert.equal(boom.ok, false);
  assert.equal(boom.error, "kaboom");

  // The other due job in the SAME tick still ran to completion.
  assert.equal(survivor.ok, true);
  assert.equal(okRuns, 1);

  // The failed run is retained in the history.
  const recent = sched.status().recent_runs;
  const recordedBoom = recent.find((r) => r.job === "boom");
  assert.ok(recordedBoom, "failed run should be recorded in recent_runs");
  assert.equal(recordedBoom!.ok, false);
  assert.equal(recordedBoom!.error, "kaboom");
});

// ---------------------------------------------------------------------------
// Overlap guard
// ---------------------------------------------------------------------------

test("scheduler: a job still running is never double-started by a concurrent tick", async () => {
  const clock = fakeClock();
  const sched = new AutonomousScheduler(clock.now);

  // A manually-controlled deferred so we can hold the run mid-flight.
  let resolve!: () => void;
  const pending = new Promise<void>((r) => (resolve = r));

  let starts = 0;
  sched.addJob({
    name: "slow",
    interval_sec: 1,
    run: () => {
      starts += 1; // counted at the START of the run
      return pending;
    },
  });

  // tick #1 — start it but DO NOT await; the job is now mid-run (running=true).
  const tick1 = sched.tick(100);
  // Yield a microtask so tick #1 reaches the `await j.def.run()` point.
  await Promise.resolve();
  assert.equal(starts, 1, "the slow job should have started exactly once");
  assert.equal(sched.status().jobs.find((j) => j.name === "slow")!.running, true);

  // tick #2 at the SAME now — the overlap guard must skip the running job.
  const runs2 = await sched.tick(100);
  assert.equal(runs2.length, 0, "concurrent tick must not start the running job");
  assert.equal(starts, 1, "the job must not have been started a second time");

  // Release the pending run and let tick #1 finish.
  resolve();
  const runs1 = await tick1;
  assert.equal(runs1.length, 1);
  assert.equal(runs1[0]!.ok, true);
  assert.equal(starts, 1, "the job ran exactly once end-to-end");

  const j = sched.status().jobs.find((x) => x.name === "slow")!;
  assert.equal(j.running, false);
  assert.equal(j.runs, 1);
});

// ---------------------------------------------------------------------------
// start() / stop() — no real timer must be left running
// ---------------------------------------------------------------------------

test("scheduler: start() is idempotent and stop() clears the started flag", async () => {
  const clock = fakeClock();
  const sched = new AutonomousScheduler(clock.now);

  assert.equal(sched.isStarted(), false);
  assert.equal(sched.status().started, false);

  try {
    // Huge interval so the timer never actually fires during the test.
    sched.start(1_000_000);
    assert.equal(sched.isStarted(), true);
    assert.equal(sched.status().started, true);

    // Idempotent: a second start() is a no-op (still exactly one timer).
    sched.start(1_000_000);
    assert.equal(sched.isStarted(), true);
  } finally {
    // CRITICAL: never leave a timer running or node:test will hang.
    sched.stop();
  }

  assert.equal(sched.isStarted(), false);
  assert.equal(sched.status().started, false);

  // stop() is safe to call again.
  sched.stop();
  assert.equal(sched.isStarted(), false);
});

// ---------------------------------------------------------------------------
// History ordering — recent_runs is newest-first
// ---------------------------------------------------------------------------

test("scheduler: recent_runs is newest-first", async () => {
  const clock = fakeClock();
  const sched = new AutonomousScheduler(clock.now);

  sched.addJob({ name: "solo", interval_sec: 1, run: () => undefined });

  await sched.tick(1);
  await sched.tick(2);
  await sched.tick(3);

  const recent = sched.status().recent_runs;
  assert.equal(recent.length, 3);
  // Newest first: the most recent tick (at=3) leads.
  assert.deepEqual(
    recent.map((r) => r.at),
    [3, 2, 1],
  );
});

test("scheduler: a job rejecting with null/undefined does NOT abort the rest of the tick", async () => {
  const sched = new AutonomousScheduler(() => 0);
  let survivorRan = 0;
  sched.addJob({ name: "bad-null", interval_sec: 1, run: () => Promise.reject() }); // rejects with undefined
  sched.addJob({ name: "bad-str", interval_sec: 1, run: () => Promise.reject("boom") }); // non-Error
  sched.addJob({
    name: "survivor",
    interval_sec: 1,
    run: () => {
      survivorRan += 1;
    },
  });

  const runs = await sched.tick(0); // must not throw
  assert.equal(survivorRan, 1, "the survivor job must still run after failing jobs");
  const byJob = Object.fromEntries(runs.map((r) => [r.job, r]));
  assert.equal(byJob["bad-null"]!.ok, false);
  assert.equal(byJob["bad-null"]!.error, "undefined"); // safely stringified, not a crash
  assert.equal(byJob["bad-str"]!.error, "boom");
  assert.equal(byJob["survivor"]!.ok, true);
});

test("scheduler: overlapping ticks never double-run a stale due job (interval re-check)", async () => {
  const sched = new AutonomousScheduler(() => 100);
  let slowResolve!: () => void;
  const slowGate = new Promise<void>((r) => (slowResolve = r));
  let slowRan = 0;
  let fastRan = 0;
  sched.addJob({
    name: "slow",
    interval_sec: 10,
    run: async () => {
      slowRan += 1;
      await slowGate;
    },
  });
  sched.addJob({
    name: "fast",
    interval_sec: 10,
    run: () => {
      fastRan += 1;
    },
  });

  // Tick #1 at now=100: slow starts and parks on the gate; fast is next in its due list.
  const t1 = sched.tick(100);
  // Tick #2 at now=100: slow is running (skipped); fast is due and runs to completion.
  await sched.tick(100);
  assert.equal(fastRan, 1, "fast ran once via tick #2");
  // Release slow; tick #1 resumes and reaches 'fast' in its STALE due list — the interval
  // re-check (fast.last_run_at now set to 100) must prevent a second execution.
  slowResolve();
  await t1;
  assert.equal(slowRan, 1);
  assert.equal(fastRan, 1, "fast must NOT run a second time from the stale due list");
});
