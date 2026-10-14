import type { Pattern, Persona, RoundDef } from './types';

export const PATTERNS: Pattern[] = [
  {
    id: 'red-blue',
    name: 'Red team / Blue team',
    description: 'Blue proposes and defends; Red attacks. Rebuttals repeat until positions settle.',
    roles: [
      { id: 'blue', label: 'Blue (proposer)', min: 1, brief: 'Build the strongest case for the proposal and defend it.' },
      { id: 'red', label: 'Red (attacker)', min: 1, brief: 'Find the ways the proposal fails: risks, costs, wrong assumptions.' },
    ],
    rounds: [
      { name: 'Opening case', speakers: ['blue'], visibility: 'all', task: 'State the proposal and your strongest 3 reasons it is right.' },
      { name: 'Attack', speakers: ['red'], visibility: 'all', task: 'Attack the opening case. Name the 3 most serious weaknesses, citing turn ids.' },
    ],
    repeat: [
      { name: 'Rebuttal', speakers: ['blue'], visibility: 'all', task: 'Answer the attacks directly. Concede what you cannot defend and propose conditions.' },
      { name: 'Counter', speakers: ['red'], visibility: 'all', task: 'Say which of your objections are now answered and which still stand.' },
    ],
    maxRounds: 5,
    stopWhenStable: true,
    defaultOutcome: 'go-no-go',
  },
  {
    id: 'devils-advocate',
    name: "Devil's advocate",
    description: 'Panelists state views blind; an advocate attacks the emerging consensus; panelists revise.',
    roles: [
      { id: 'panelist', label: 'Panelist', min: 2, brief: 'Give your honest expert view from your role.' },
      { id: 'advocate', label: "Devil's advocate", min: 1, brief: 'Argue against whatever the majority believes, as strongly as you can.' },
    ],
    rounds: [
      { name: 'Independent positions', speakers: ['panelist'], visibility: 'none', task: 'Give your position without seeing anyone else.' },
      { name: 'Challenge', speakers: ['advocate'], visibility: 'all', task: 'Find the consensus and attack its weakest assumption.' },
      { name: 'Revise', speakers: ['panelist'], visibility: 'all', task: 'Respond to the challenge. Keep or change your stance and say why.' },
    ],
    repeat: [
      { name: 'Challenge again', speakers: ['advocate'], visibility: 'all', task: 'Attack what survived the last revision.' },
      { name: 'Final revise', speakers: ['panelist'], visibility: 'all', task: 'Give your final stance and the one condition that would change it.' },
    ],
    maxRounds: 5,
    stopWhenStable: true,
    defaultOutcome: 'recommendation',
  },
  {
    id: 'pre-mortem',
    name: 'Pre-mortem',
    description: 'Assume it already failed. Each panelist explains why, then the room ranks causes and mitigations.',
    roles: [{ id: 'panelist', label: 'Panelist', min: 2, brief: 'Imagine the decision failed badly 6 months from now.' }],
    rounds: [
      { name: 'Failure stories', speakers: ['panelist'], visibility: 'none', task: 'It is 6 months later and this failed. Write the most likely story of why, from your role.' },
      { name: 'Rank causes', speakers: ['panelist'], visibility: 'all', task: 'Rank the 3 most likely failure causes across all stories, citing turn ids.' },
      { name: 'Mitigations', speakers: ['panelist'], visibility: 'all', task: 'For the top causes, propose a cheap early signal and a mitigation.' },
    ],
    maxRounds: 3,
    stopWhenStable: false,
    defaultOutcome: 'risk-register',
  },
];

export function getPattern(id: string): Pattern {
  return PATTERNS.find((p) => p.id === id) ?? PATTERNS[0];
}

export function buildSchedule(p: Pattern, maxRounds: number): RoundDef[] {
  const cap = Math.max(1, Math.min(p.maxRounds, maxRounds));
  const out = p.rounds.slice(0, cap);
  if (p.repeat?.length) {
    for (let i = 0; out.length < cap; i++) out.push(p.repeat[i % p.repeat.length]);
  }
  return out;
}

export const PERSONA_TEMPLATES: Persona[] = [
  { name: 'Growth PM', role: 'Product manager who owns adoption and revenue', goals: 'Ship fast, learn from real users, hit the quarter goal', biases: 'Underweights long-term maintenance cost', redLines: 'Will not accept a plan with no way to measure impact' },
  { name: 'Platform PM', role: 'Product manager who owns shared platform and APIs', goals: 'Stable contracts, reuse, fewer one-offs', biases: 'Prefers general solutions even when a narrow one would do', redLines: 'No breaking changes to public contracts without migration' },
  { name: 'Designer', role: 'Product designer for the affected flows', goals: 'Clear, consistent experience; users understand what happened', biases: 'Pushes back on anything that adds steps or jargon', redLines: 'No silent failures or states the user cannot see' },
  { name: 'Architect', role: 'Principal engineer for the system', goals: 'Simple ownership, observable, reversible changes', biases: 'Sceptical of new infrastructure and dual sources of truth', redLines: 'No design without a rollback path' },
  { name: 'Customer Success', role: 'Owns the relationship with key customers', goals: 'Fewer tickets, no surprises for customers', biases: 'Weighs loud customers heavily', redLines: 'No change that breaks a workflow customers rely on without notice' },
  { name: 'QA Lead', role: 'Owns release quality', goals: 'Testable scope, clear acceptance criteria', biases: 'Assumes edge cases will happen in production', redLines: 'No launch without a test plan for failure paths' },
  { name: 'SecOps', role: 'Security and operations engineer', goals: 'Least privilege, auditability, safe defaults', biases: 'Treats every input as hostile', redLines: 'No new path that bypasses auth or exposes credentials' },
];
