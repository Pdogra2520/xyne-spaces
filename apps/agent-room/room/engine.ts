import type { RoomBackend } from './backend';
import { TimeoutError } from './backend';
import {
  formatConfigMessage, formatDecisionMarkdown, formatDecisionMessage,
  formatIntervention, formatRoundHeader, formatTurnMessage,
} from './format';
import { buildSchedule, getPattern } from './patterns';
import { buildJudgeTask, buildTurnTask, parseDecision, parseTurn } from './prompts';
import type { DecisionRecord, Intervention, Limits, RoomConfig, RoomEvent, RoomStatus, Seat, Turn } from './types';
import { HARD_LIMITS } from './types';

export function clampLimits(l: Partial<Limits>): Limits {
  const clamp = (v: number | undefined, max: number, min: number) =>
    Math.max(min, Math.min(max, typeof v === 'number' && Number.isFinite(v) ? v : max));
  return {
    maxSeats: clamp(l.maxSeats, HARD_LIMITS.maxSeats, 2),
    maxRounds: clamp(l.maxRounds, HARD_LIMITS.maxRounds, 1),
    maxRuns: clamp(l.maxRuns, HARD_LIMITS.maxRuns, 3),
    turnTimeoutMs: clamp(l.turnTimeoutMs, HARD_LIMITS.turnTimeoutMs, 10_000),
  };
}

/** Agent runs needed in the worst case (no early stop, no retries), including the judge. */
export function estimateRuns(cfg: RoomConfig): number {
  const pattern = getPattern(cfg.patternId);
  const schedule = buildSchedule(pattern, clampLimits(cfg.limits).maxRounds);
  const perRound = schedule.map((r) => cfg.seats.filter((s) => r.speakers.includes(s.patternRole)).length);
  return perRound.reduce((a, b) => a + b, 0) + 1;
}

/** Validate a room before it starts. Returns a list of problems (empty = OK). */
export function validateRoom(cfg: RoomConfig): string[] {
  const errs: string[] = [];
  const pattern = getPattern(cfg.patternId);
  const limits = clampLimits(cfg.limits);
  if (!cfg.title.trim()) errs.push('Give the room a title.');
  if (!cfg.question.trim()) errs.push('Write the question the room must decide.');
  if (!cfg.channelId.trim()) errs.push('Choose the channel the room thread goes in.');
  if (cfg.seats.length > limits.maxSeats) errs.push(`At most ${limits.maxSeats} seats.`);
  for (const role of pattern.roles) {
    const n = cfg.seats.filter((s) => s.patternRole === role.id).length;
    if (n < role.min) errs.push(`${pattern.name} needs at least ${role.min} ${role.label} seat(s).`);
  }
  for (const s of cfg.seats) {
    if (s.kind === 'agent' && !s.agentSlug?.trim()) errs.push(`Seat "${s.label}" needs a Claw agent slug.`);
  }
  if (cfg.seats.some((s) => s.kind === 'persona') && !cfg.personaAgent.trim()) errs.push('Set the persona-runner agent slug.');
  if (!cfg.judgeAgent.trim()) errs.push('Set the judge agent slug.');
  if ((cfg.outcome === 'choose-one' || cfg.outcome === 'ranked-list') && cfg.options.length < 2) {
    errs.push('List at least 2 options for this outcome.');
  }
  const est = estimateRuns(cfg);
  if (est > limits.maxRuns) errs.push(`This room needs about ${est} agent runs; the limit is ${limits.maxRuns}.`);
  return errs;
}

export class RoomRunner {
  readonly cfg: RoomConfig;
  private readonly backend: RoomBackend;
  private readonly emit: (e: RoomEvent) => void;
  private readonly limits: Limits;
  private readonly ownerName: string;
  private conversationId: string | null = null;
  private turns: Turn[] = [];
  private interventions: Intervention[] = [];
  private runsUsed = 0;
  private status: RoomStatus = 'idle';
  private pauseRequested = false;
  private stopRequested = false;
  private resumeWaiter: (() => void) | null = null;

  constructor(cfg: RoomConfig, backend: RoomBackend, emit: (e: RoomEvent) => void, ownerName = 'the room owner') {
    this.cfg = cfg;
    this.backend = backend;
    this.emit = emit;
    this.limits = clampLimits(cfg.limits);
    this.ownerName = ownerName;
  }

  get threadId(): string | null { return this.conversationId; }

  pause(): void { if (this.status === 'running') this.pauseRequested = true; }

  resume(): void {
    this.pauseRequested = false;
    const w = this.resumeWaiter;
    this.resumeWaiter = null;
    w?.();
  }

  /** Stop after the current round; the judge still rules on what exists. */
  stop(): void { this.stopRequested = true; this.resume(); }

  /** Add an owner fact. Agents see it from the next round on. */
  async addFact(text: string): Promise<void> {
    const item: Intervention = { afterRound: this.turns.reduce((m, t) => Math.max(m, t.round), 0), text: text.trim() };
    if (!item.text) return;
    this.interventions.push(item);
    if (this.conversationId) await this.backend.post(this.conversationId, formatIntervention(item, this.ownerName));
  }

  getTurns(): Turn[] { return [...this.turns]; }

  private setStatus(status: RoomStatus, detail?: string) {
    this.status = status;
    this.emit({ type: 'status', status, detail });
  }

  private async checkpoint(): Promise<void> {
    if (!this.pauseRequested || this.stopRequested) return;
    this.setStatus('paused');
    await new Promise<void>((r) => { this.resumeWaiter = r; });
    if (!this.stopRequested) this.setStatus('running');
  }

  private agentFor(seat: Seat): string {
    return seat.kind === 'agent' ? (seat.agentSlug ?? '') : this.cfg.personaAgent;
  }

  private useRun(): boolean {
    if (this.runsUsed >= this.limits.maxRuns) return false;
    this.runsUsed += 1;
    this.emit({ type: 'runs', used: this.runsUsed, max: this.limits.maxRuns });
    return true;
  }

  private async runSeat(seat: Seat, task: string, round: number, roundName: string): Promise<Turn> {
    const id = `R${round}-S${this.cfg.seats.indexOf(seat) + 1}`;
    const base = { id, round, roundName, seatId: seat.id, seatLabel: seat.label, patternRole: seat.patternRole };
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      // Always keep one run in reserve for the judge.
      if (this.runsUsed >= this.limits.maxRuns - 1 || !this.useRun()) break;
      try {
        const text = await this.backend.runAgent(this.agentFor(seat), task, this.limits.turnTimeoutMs);
        return { ...base, ...parseTurn(text), text, status: 'ok' };
      } catch (e) {
        lastErr = e;
        if (e instanceof TimeoutError) break; // do not burn another 2 minutes
      }
    }
    return {
      ...base,
      stance: 'unknown',
      changedMind: false,
      text: lastErr instanceof Error ? lastErr.message : 'run limit reached',
      status: lastErr instanceof TimeoutError ? 'timeout' : 'error',
    };
  }

  async start(): Promise<void> {
    const errs = validateRoom(this.cfg);
    if (errs.length) {
      this.emit({ type: 'error', message: errs.join(' ') });
      this.setStatus('failed', errs[0]);
      return;
    }
    const pattern = getPattern(this.cfg.patternId);
    const schedule = buildSchedule(pattern, this.limits.maxRounds);
    const cycleLen = pattern.repeat?.length ?? 0;

    try {
      this.setStatus('running');
      const threadId = await this.backend.createThread(this.cfg.channelId, formatConfigMessage(this.cfg));
      this.conversationId = threadId;

      for (let i = 0; i < schedule.length; i++) {
        if (this.stopRequested) break;
        await this.checkpoint();
        if (this.stopRequested) break;

        const roundNumber = i + 1;
        const round = schedule[i];
        const speakers = this.cfg.seats.filter((s) => round.speakers.includes(s.patternRole));
        this.emit({ type: 'round-start', round: roundNumber, roundName: round.name, seatIds: speakers.map((s) => s.id) });
        await this.backend.post(threadId, formatRoundHeader(roundNumber, schedule.length, round.name));

        // Everyone in a round sees the same snapshot, so parallel seats cannot read each other.
        const snapshot = [...this.turns];
        const facts = [...this.interventions];
        const runOne = async (seat: Seat) => {
          const task = buildTurnTask({
            cfg: this.cfg, round, roundNumber, totalRounds: schedule.length, seat, turns: snapshot, interventions: facts,
          });
          const turn = await this.runSeat(seat, task, roundNumber, round.name);
          this.turns.push(turn);
          this.emit({ type: 'turn', turn });
          await this.backend.post(threadId, formatTurnMessage(turn));
        };

        if (round.parallel !== false) await Promise.all(speakers.map(runOne));
        else for (const s of speakers) await runOne(s);

        if (this.runsUsed >= this.limits.maxRuns - 1) break;

        // Early stop: a full repeat cycle passed and nobody changed their mind.
        if (pattern.stopWhenStable && cycleLen > 0 && roundNumber >= pattern.rounds.length + cycleLen) {
          const recent = this.turns.filter((t) => t.round > roundNumber - cycleLen && t.status === 'ok');
          if (recent.length && recent.every((t) => !t.changedMind)) break;
        }
      }

      await this.judge();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.emit({ type: 'error', message });
      this.setStatus('failed', message);
    }
  }

  /** Ask the judge for a decision record; one corrective retry if the shape is wrong. */
  async judge(): Promise<DecisionRecord | null> {
    const threadId = this.conversationId;
    if (!threadId) return null;
    this.setStatus('judging');
    let previousError: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      // The judge always gets its run, even if a retry pushes past the cap by one.
      if (!this.useRun()) { this.runsUsed -= 1; this.useRun(); }
      try {
        const text = await this.backend.runAgent(
          this.cfg.judgeAgent,
          buildJudgeTask(this.cfg, this.turns, this.interventions, previousError),
          this.limits.turnTimeoutMs,
        );
        const record = parseDecision(text, this.cfg, this.turns);
        const md = formatDecisionMarkdown(this.cfg, record, this.turns);
        const canvasUrl = await this.backend.createCanvas(`Decision: ${this.cfg.title}`, md, this.cfg.channelId);
        await this.backend.post(threadId, formatDecisionMessage(record, canvasUrl));
        if (!canvasUrl) await this.backend.post(threadId, md); // keep the full record in the thread
        this.emit({ type: 'decision', record, canvasUrl });
        this.setStatus(this.stopRequested ? 'stopped' : 'done');
        return record;
      } catch (e) {
        previousError = e instanceof Error ? e.message : String(e);
      }
    }
    const msg = `The judge could not produce a valid decision: ${previousError}. Use "Retry ruling".`;
    this.emit({ type: 'error', message: msg });
    this.setStatus('failed', msg);
    return null;
  }
}
