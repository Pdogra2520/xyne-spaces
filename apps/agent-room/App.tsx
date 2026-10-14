import { useEffect, useRef, useState } from 'react';
import { spaces } from './lib/xyne';
import { useXyneContext } from './lib/xyne-context';
import { createMockBackend, createSpacesBackend, type RoomBackend } from './room/backend';
import { estimateRuns, RoomRunner, validateRoom } from './room/engine';
import { formatTurnMessage } from './room/format';
import { getPattern, PATTERNS, PERSONA_TEMPLATES } from './room/patterns';
import type { DecisionRecord, OutcomeContract, RoomConfig, RoomEvent, RoomStatus, Seat, Turn } from './room/types';
import { DEFAULT_LIMITS } from './room/types';

const OUTCOMES: { id: OutcomeContract; label: string }[] = [
  { id: 'go-no-go', label: 'Go / no-go' },
  { id: 'choose-one', label: 'Choose one option' },
  { id: 'ranked-list', label: 'Ranked list' },
  { id: 'risk-register', label: 'Risk register' },
  { id: 'recommendation', label: 'Recommendation' },
];

const HISTORY_KEY = 'agent-room:history';
interface HistoryItem { title: string; threadId: string | null; decision: string | null; at: string }

function loadHistory(): HistoryItem[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') as HistoryItem[]; } catch { return []; }
}
function saveHistory(items: HistoryItem[]) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 30))); } catch { /* storage unavailable */ }
}

const uid = () => Math.random().toString(36).slice(2, 9);

function emptyRoom(channelId = ''): RoomConfig {
  const p = PATTERNS[0];
  return {
    version: 1, title: '', question: '', context: '', constraints: '', channelId,
    patternId: p.id, outcome: p.defaultOutcome, options: [], seats: [],
    limits: { ...DEFAULT_LIMITS }, judgeAgent: 'agent-room-judge', personaAgent: 'agent-room-persona',
  };
}

const input = 'w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm';
const btn = 'rounded px-3 py-1.5 text-sm font-medium border border-neutral-300 hover:bg-neutral-100 disabled:opacity-50';
const btnPrimary = 'rounded px-3 py-1.5 text-sm font-medium bg-neutral-900 text-white hover:bg-neutral-700 disabled:opacity-50';

export default function App() {
  const ctx = useXyneContext();
  const ctxChannel = ctx?.surface === 'channel' ? ctx.channel.id : '';
  const [mock, setMock] = useState(false);
  const [view, setView] = useState<'home' | 'setup' | 'live'>('home');
  const [cfg, setCfg] = useState<RoomConfig>(() => emptyRoom());
  const [history, setHistory] = useState<HistoryItem[]>(loadHistory);
  const [owner, setOwner] = useState('the room owner');

  const [status, setStatus] = useState<RoomStatus>('idle');
  const [statusDetail, setStatusDetail] = useState('');
  const [round, setRound] = useState<{ n: number; name: string; thinking: string[] } | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [runs, setRuns] = useState({ used: 0, max: DEFAULT_LIMITS.maxRuns });
  const [decision, setDecision] = useState<{ record: DecisionRecord; canvasUrl: string | null } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [fact, setFact] = useState('');
  const runner = useRef<RoomRunner | null>(null);

  useEffect(() => {
    spaces.users.me().then((u) => { if (u?.name) setOwner(u.name); }).catch(() => undefined);
  }, []);

  const pattern = getPattern(cfg.patternId);
  const problems = validateRoom(cfg);

  function onEvent(e: RoomEvent) {
    switch (e.type) {
      case 'status': setStatus(e.status); setStatusDetail(e.detail ?? ''); break;
      case 'round-start': setRound({ n: e.round, name: e.roundName, thinking: e.seatIds }); break;
      case 'turn':
        setTurns((t) => [...t, e.turn]);
        setRound((r) => (r ? { ...r, thinking: r.thinking.filter((id) => id !== e.turn.seatId) } : r));
        break;
      case 'runs': setRuns({ used: e.used, max: e.max }); break;
      case 'decision': setDecision({ record: e.record, canvasUrl: e.canvasUrl }); break;
      case 'error': setErrors((x) => [...x, e.message]); break;
    }
  }

  async function start() {
    let be: RoomBackend;
    try { be = mock ? createMockBackend() : createSpacesBackend(spaces); }
    catch (e) { setErrors([e instanceof Error ? e.message : String(e)]); return; }
    setTurns([]); setDecision(null); setErrors([]); setRound(null); setStatus('idle');
    setView('live');
    const r = new RoomRunner(cfg, be, onEvent, owner);
    runner.current = r;
    await r.start();
    const item: HistoryItem = { title: cfg.title, threadId: r.threadId, decision: null, at: new Date().toISOString() };
    setHistory((h) => { const next = [item, ...h]; saveHistory(next); return next; });
  }

  function update<K extends keyof RoomConfig>(k: K, v: RoomConfig[K]) { setCfg((c) => ({ ...c, [k]: v })); }
  function setSeat(id: string, patch: Partial<Seat>) {
    setCfg((c) => ({ ...c, seats: c.seats.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));
  }
  function addPersona(i: number) {
    const p = PERSONA_TEMPLATES[i];
    update('seats', [...cfg.seats, { id: uid(), label: p.name, kind: 'persona', persona: { ...p }, patternRole: pattern.roles[0].id }]);
  }
  function addAgent() {
    update('seats', [...cfg.seats, { id: uid(), label: 'Claw agent', kind: 'agent', agentSlug: '', patternRole: pattern.roles[0].id }]);
  }

  const header = (
    <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-3">
      <button className="text-base font-semibold" onClick={() => setView('home')}>🏛️ Agent Room</button>
      <label className="flex items-center gap-2 text-xs text-neutral-600">
        <input type="checkbox" checked={mock} onChange={(e) => setMock(e.target.checked)} />
        Mock mode (no agent runs)
      </label>
    </div>
  );

  if (view === 'home') {
    return (
      <div className="min-h-screen bg-neutral-50 text-neutral-900">
        {header}
        <div className="mx-auto max-w-3xl p-4">
          <p className="mb-4 text-sm text-neutral-600">
            Set a question, choose agents and personas, pick how they challenge each other, and get a decision record.
          </p>
          <button className={btnPrimary} onClick={() => { setCfg(emptyRoom(ctxChannel)); setView('setup'); }}>New room</button>
          <h2 className="mb-2 mt-6 text-sm font-semibold">Recent rooms on this device</h2>
          {history.length === 0 && <p className="text-sm text-neutral-500">No rooms yet.</p>}
          <ul className="space-y-1">
            {history.map((h, i) => (
              <li key={i} className="rounded border border-neutral-200 bg-white px-3 py-2 text-sm">
                <span className="font-medium">{h.title}</span>
                <span className="ml-2 text-neutral-500">{new Date(h.at).toLocaleString()}</span>
                {h.threadId && <span className="ml-2 text-xs text-neutral-400">thread {h.threadId}</span>}
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  if (view === 'setup') {
    const rounds = Math.min(pattern.maxRounds, cfg.limits.maxRounds);
    return (
      <div className="min-h-screen bg-neutral-50 text-neutral-900">
        {header}
        <div className="mx-auto max-w-3xl space-y-5 p-4">
          <section className="space-y-2">
            <h2 className="text-sm font-semibold">1. Brief</h2>
            <input className={input} placeholder="Room title" value={cfg.title} onChange={(e) => update('title', e.target.value)} />
            <textarea className={input} rows={2} placeholder="The question to decide" value={cfg.question} onChange={(e) => update('question', e.target.value)} />
            <textarea className={input} rows={4} placeholder="Context: background, links, data" value={cfg.context} onChange={(e) => update('context', e.target.value)} />
            <textarea className={input} rows={2} placeholder="Constraints (deadline, budget, must-haves)" value={cfg.constraints} onChange={(e) => update('constraints', e.target.value)} />
            <input className={input} placeholder="Channel ID for the room thread" value={cfg.channelId} onChange={(e) => update('channelId', e.target.value.trim())} />
            {ctx?.surface === 'channel' && <p className="text-xs text-neutral-500">Defaults to #{ctx.channel.name}, where the app is open.</p>}
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-semibold">2. Pattern and outcome</h2>
            <div className="grid gap-2 sm:grid-cols-3">
              {PATTERNS.map((p) => (
                <button
                  key={p.id}
                  className={`rounded border p-2 text-left text-xs ${p.id === cfg.patternId ? 'border-neutral-900 bg-white' : 'border-neutral-200 bg-white/60'}`}
                  onClick={() => setCfg((c) => ({
                    ...c, patternId: p.id, outcome: p.defaultOutcome,
                    seats: c.seats.map((s) => ({ ...s, patternRole: p.roles.some((r) => r.id === s.patternRole) ? s.patternRole : p.roles[0].id })),
                  }))}
                >
                  <div className="text-sm font-medium">{p.name}</div>
                  <div className="text-neutral-600">{p.description}</div>
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <select className={input} value={cfg.outcome} onChange={(e) => update('outcome', e.target.value as OutcomeContract)}>
                {OUTCOMES.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
              <select className={input} value={cfg.limits.maxRounds} onChange={(e) => update('limits', { ...cfg.limits, maxRounds: Number(e.target.value) })}>
                {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>Max {n} rounds</option>)}
              </select>
            </div>
            {(cfg.outcome === 'choose-one' || cfg.outcome === 'ranked-list') && (
              <textarea className={input} rows={3} placeholder="One option per line" value={cfg.options.join('\n')}
                onChange={(e) => update('options', e.target.value.split('\n').map((x) => x.trim()).filter(Boolean))} />
            )}
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-semibold">3. Seats ({cfg.seats.length}/{DEFAULT_LIMITS.maxSeats})</h2>
            <div className="flex flex-wrap gap-1">
              {PERSONA_TEMPLATES.map((p, i) => (
                <button key={p.name} className={btn} disabled={cfg.seats.length >= DEFAULT_LIMITS.maxSeats} onClick={() => addPersona(i)}>+ {p.name}</button>
              ))}
              <button className={btn} disabled={cfg.seats.length >= DEFAULT_LIMITS.maxSeats} onClick={addAgent}>+ Existing Claw agent</button>
            </div>
            {cfg.seats.map((s) => (
              <div key={s.id} className="space-y-1 rounded border border-neutral-200 bg-white p-2">
                <div className="flex gap-2">
                  <input className={input} value={s.label} onChange={(e) => setSeat(s.id, { label: e.target.value })} />
                  <select className={input} value={s.patternRole} onChange={(e) => setSeat(s.id, { patternRole: e.target.value })}>
                    {pattern.roles.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                  </select>
                  <button className={btn} onClick={() => update('seats', cfg.seats.filter((x) => x.id !== s.id))}>Remove</button>
                </div>
                {s.kind === 'agent' ? (
                  <>
                    <input className={input} placeholder="Claw agent slug, e.g. xyne-spaces-architect" value={s.agentSlug ?? ''}
                      onChange={(e) => setSeat(s.id, { agentSlug: e.target.value.trim() })} />
                    <p className="text-xs text-amber-700">Existing agents run with your permissions. Prefer agents without write tools.</p>
                  </>
                ) : (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-neutral-600">Edit persona</summary>
                    {(['role', 'goals', 'biases', 'redLines'] as const).map((k) => (
                      <textarea key={k} className={`${input} mt-1`} rows={2} placeholder={k} value={s.persona?.[k] ?? ''}
                        onChange={(e) => setSeat(s.id, { persona: { ...(s.persona ?? PERSONA_TEMPLATES[0]), [k]: e.target.value } })} />
                    ))}
                  </details>
                )}
              </div>
            ))}
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-semibold">4. Helper agents</h2>
            <div className="flex gap-2">
              <input className={input} value={cfg.personaAgent} onChange={(e) => update('personaAgent', e.target.value.trim())} placeholder="Persona-runner agent slug" />
              <input className={input} value={cfg.judgeAgent} onChange={(e) => update('judgeAgent', e.target.value.trim())} placeholder="Judge agent slug" />
            </div>
          </section>

          <div className="flex items-center justify-between border-t border-neutral-200 pt-3">
            <div className="text-xs text-neutral-600">
              Up to {estimateRuns(cfg)} agent runs · about {Math.ceil((rounds + 1) * 0.75)}–{(rounds + 1) * 2} min
              {problems.length > 0 && <ul className="mt-1 list-disc pl-4 text-red-700">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
            </div>
            <button className={btnPrimary} disabled={problems.length > 0} onClick={start}>Start room</button>
          </div>
          {errors.length > 0 && <div className="rounded bg-red-50 p-2 text-xs text-red-800">{errors.join(' ')}</div>}
        </div>
      </div>
    );
  }

  const seatLabel = (id: string) => cfg.seats.find((s) => s.id === id)?.label ?? id;
  const busy = status === 'running' || status === 'judging';

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      {header}
      <div className="mx-auto max-w-3xl space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-semibold">{cfg.title}</span>
          <span className="rounded bg-neutral-200 px-2 py-0.5 text-xs">{status}{statusDetail ? `: ${statusDetail}` : ''}</span>
          <span className="text-xs text-neutral-500">runs {runs.used}/{runs.max}</span>
          {round && <span className="text-xs text-neutral-500">round {round.n} · {round.name}</span>}
          <div className="ml-auto flex gap-1">
            {status === 'running' && <button className={btn} onClick={() => runner.current?.pause()}>Pause after round</button>}
            {status === 'paused' && <button className={btn} onClick={() => runner.current?.resume()}>Resume</button>}
            {(status === 'running' || status === 'paused') && <button className={btn} onClick={() => runner.current?.stop()}>End debate, rule now</button>}
            {status === 'failed' && runner.current?.threadId && (
              <button className={btn} onClick={() => { void runner.current?.judge(); }}>Retry ruling</button>
            )}
          </div>
        </div>

        {round && round.thinking.length > 0 && busy && (
          <div className="text-xs text-neutral-600">Thinking… {round.thinking.map(seatLabel).join(', ')}</div>
        )}
        {status === 'judging' && <div className="text-xs text-neutral-600">The judge is writing the decision…</div>}

        {(status === 'paused' || status === 'running') && (
          <div className="flex gap-2">
            <input className={input} placeholder="Add a fact or constraint agents will see next round" value={fact} onChange={(e) => setFact(e.target.value)} />
            <button className={btn} disabled={!fact.trim()} onClick={async () => { await runner.current?.addFact(fact); setFact(''); }}>Add</button>
          </div>
        )}

        {decision && (
          <div className="rounded border-2 border-neutral-900 bg-white p-3 text-sm">
            <div className="font-semibold">⚖️ {decision.record.decision}</div>
            <div className="text-xs text-neutral-600">Confidence: {decision.record.confidence}</div>
            <p className="mt-2 whitespace-pre-wrap">{decision.record.rationale}</p>
            {decision.record.dissent.length > 0 && <div className="mt-2 text-xs"><b>Dissent:</b> {decision.record.dissent.join(' · ')}</div>}
            {decision.canvasUrl
              ? <a className="mt-2 block text-xs underline" href={decision.canvasUrl} target="_blank" rel="noreferrer">Open decision record</a>
              : <div className="mt-2 text-xs text-neutral-500">Full record posted in the room thread.</div>}
          </div>
        )}

        {errors.length > 0 && <div className="rounded bg-red-50 p-2 text-xs text-red-800">{errors.join(' ')}</div>}

        <ol className="space-y-2">
          {turns.map((t) => (
            <li key={t.id} className={`rounded border bg-white p-2 text-sm ${t.status === 'ok' ? 'border-neutral-200' : 'border-red-200'}`}>
              <pre className="whitespace-pre-wrap font-sans">{formatTurnMessage(t).replace(/\*\*/g, '')}</pre>
            </li>
          ))}
        </ol>
        {(status === 'done' || status === 'stopped' || status === 'failed') && (
          <button className={btn} onClick={() => setView('setup')}>Edit and run again</button>
        )}
      </div>
    </div>
  );
}
