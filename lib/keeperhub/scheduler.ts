/**
 * AutonomousScheduler — the "forever" in the last mile.
 *
 * The keeper reacts to a margin call and automations fire on a trigger, but both
 * still need something to CALL them on a cadence. This is that something: a
 * KeeperHub-cron-style loop that runs registered jobs on their own interval, so the
 * whole system operates unattended — decide → execute → on a schedule, forever.
 *
 * The core is a deterministic `tick(now)` (pure, testable): it runs every job whose
 * interval has elapsed, with a per-job overlap guard so a slow run is never started
 * twice. `start()` merely wires a real timer to `tick(Date.now())`; nothing about the
 * scheduling logic depends on wall-clock timers, so it is fully reproducible in tests.
 *
 * This maps to KeeperHub's scheduled-workflow surface (`create_workflow` with a cron,
 * `validate_cron`): a Cred402 job is a local mirror of a KeeperHub cron trigger.
 */

export interface ScheduledJobDef {
  name: string;
  /** How often to run, in seconds. */
  interval_sec: number;
  /** The work to run each interval. Its return is summarized into the run history. */
  run: () => Promise<unknown> | unknown;
  enabled?: boolean;
}

export interface JobRun {
  job: string;
  at: number;
  ok: boolean;
  ms: number;
  /** A short summary of the job's result (e.g. "2 executed"). */
  summary?: string;
  error?: string;
}

interface JobState {
  def: ScheduledJobDef;
  enabled: boolean;
  last_run_at?: number;
  running: boolean;
  runs: number;
}

export interface SchedulerStatus {
  started: boolean;
  jobs: Array<{ name: string; interval_sec: number; enabled: boolean; running: boolean; last_run_at?: number; runs: number; next_due_at?: number }>;
  recent_runs: JobRun[];
}

const HISTORY_CAP = 100;

export class AutonomousScheduler {
  private readonly jobs = new Map<string, JobState>();
  private readonly history: JobRun[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private started = false;

  constructor(
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    /** How the run result is turned into a one-line summary for the history. */
    private readonly summarize: (jobName: string, result: unknown) => string | undefined = defaultSummarize,
  ) {}

  addJob(def: ScheduledJobDef): void {
    this.jobs.set(def.name, { def, enabled: def.enabled ?? true, running: false, runs: 0 });
  }

  setEnabled(name: string, enabled: boolean): boolean {
    const j = this.jobs.get(name);
    if (!j) return false;
    j.enabled = enabled;
    return true;
  }

  /**
   * Run every job whose interval has elapsed. Returns the runs that executed this
   * tick. A job already running (slow previous run) is skipped, never double-started.
   */
  async tick(now = this.now()): Promise<JobRun[]> {
    const due: JobState[] = [];
    for (const j of this.jobs.values()) {
      if (!j.enabled || j.running) continue;
      if (j.last_run_at === undefined || now - j.last_run_at >= j.def.interval_sec) due.push(j);
    }
    const runs: JobRun[] = [];
    for (const j of due) {
      // Re-guard: mark running BEFORE the await so a concurrent tick can't double-run.
      if (j.running) continue;
      // Re-check the interval at execution time too: while this tick was parked on an
      // earlier job's await, an overlapping tick (real timer firing faster than a slow
      // job) may have already run this one — a stale `due` entry must not re-execute.
      if (j.last_run_at !== undefined && now - j.last_run_at < j.def.interval_sec) continue;
      j.running = true;
      const started = this.now();
      const run: JobRun = { job: j.def.name, at: now, ok: false, ms: 0 };
      try {
        const result = await j.def.run();
        run.ok = true;
        run.summary = this.summarize(j.def.name, result);
      } catch (err) {
        // Never let the error handler itself throw (a job may reject with null/undefined
        // or a non-Error) — that would abort the rest of the tick's due jobs.
        run.error = err instanceof Error ? err.message : String(err);
      } finally {
        run.ms = Math.max(0, this.now() - started);
        j.last_run_at = now;
        j.runs += 1;
        j.running = false;
        this.record(run);
        runs.push(run);
      }
    }
    return runs;
  }

  /** Start a real timer that ticks every `intervalMs`. Idempotent. */
  start(intervalMs = 15_000): void {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, intervalMs);
    // Do not keep the process alive solely for the scheduler.
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.started = false;
  }

  isStarted(): boolean {
    return this.started;
  }

  status(): SchedulerStatus {
    return {
      started: this.started,
      jobs: [...this.jobs.values()].map((j) => ({
        name: j.def.name,
        interval_sec: j.def.interval_sec,
        enabled: j.enabled,
        running: j.running,
        last_run_at: j.last_run_at,
        runs: j.runs,
        next_due_at: j.last_run_at === undefined ? undefined : j.last_run_at + j.def.interval_sec,
      })),
      recent_runs: [...this.history].slice(-25).reverse(),
    };
  }

  private record(run: JobRun): void {
    this.history.push(run);
    if (this.history.length > HISTORY_CAP) this.history.splice(0, this.history.length - HISTORY_CAP);
  }
}

function defaultSummarize(_jobName: string, result: unknown): string | undefined {
  if (result == null) return undefined;
  if (typeof result === "string") return result;
  const r = result as Record<string, unknown>;
  // Common shapes from the keeper fleet + automation tick.
  if (r.summary && typeof r.summary === "object") {
    const s = r.summary as Record<string, unknown>;
    return `evaluated ${s.evaluated ?? "?"}, executed ${s.executed ?? s.actioned ?? 0}`;
  }
  if (Array.isArray(r.runs)) return `${(r.runs as unknown[]).length} automation(s) fired`;
  if (Array.isArray(result)) return `${result.length} run(s)`;
  return undefined;
}
