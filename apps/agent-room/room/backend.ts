/**
 * The only file that talks to the Spaces SDK. Everything else uses RoomBackend.
 *
 * Verified against @xyne/spaces-sdk source:
 *   conversations.create({ channelId, content }) -> { conversationId, messageId }
 *   messages.send({ conversationId, content })   -> { messageId }
 *   claw.runAndWait({ agent, task, timeoutMs })   -> ClawRun { sessionId, status, result?, error? }
 *     terminal statuses: completed | failed | cancelled; throws SdkError code 'timeout'
 *   canvases.createFromMarkdown({ title, markdown, channelId }) -> { id, url, ... }
 */
import type { SlimSpacesClient } from '../lib/vendor/spaces-sdk';

export interface RoomBackend {
  createThread(channelId: string, content: string): Promise<string>;
  post(conversationId: string, content: string): Promise<void>;
  runAgent(agent: string, task: string, timeoutMs: number): Promise<string>;
  /** Returns a link to the canvas, or null if it could not be created. */
  createCanvas(title: string, markdown: string, channelId: string): Promise<string | null>;
}

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${Math.round(ms / 1000)}s`);
    this.name = 'TimeoutError';
  }
}

interface ClawRunLike {
  sessionId: string;
  status: string;
  result?: string;
  error?: string;
}

/** Turn a finished Claw run into the agent's reply text, or throw. */
export function runText(run: ClawRunLike): string {
  if (run.status !== 'completed') {
    throw new Error(`agent run ${run.status}${run.error ? `: ${run.error}` : ''}`);
  }
  const text = (run.result ?? '').trim();
  if (!text) throw new Error('agent returned an empty reply');
  return text;
}

function isSdkTimeout(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: unknown }).code === 'timeout';
}

export function createSpacesBackend(sdk: SlimSpacesClient): RoomBackend {
  if (typeof sdk?.claw?.runAndWait !== 'function') {
    throw new Error(
      "sdk.claw is not in this app's SDK bundle. Add ClawResource to scripts/slim-spaces-entry.js and lib/vendor/spaces-sdk.d.ts, then run `npm run bundle:sdk`.",
    );
  }
  return {
    async createThread(channelId, content) {
      const { conversationId } = await sdk.conversations.create({ channelId, content });
      return conversationId;
    },

    async post(conversationId, content) {
      await sdk.messages.send({ conversationId, content });
    },

    async runAgent(agent, task, timeoutMs) {
      try {
        const run = await sdk.claw.runAndWait({ agent, task, timeoutMs });
        return runText(run);
      } catch (e) {
        if (isSdkTimeout(e)) throw new TimeoutError(timeoutMs);
        throw e;
      }
    },

    async createCanvas(title, markdown, channelId) {
      if (typeof sdk.canvases?.createFromMarkdown !== 'function') return null;
      try {
        const canvas = await sdk.canvases.createFromMarkdown({ title, markdown, channelId, visibility: 'PUBLIC' });
        return canvas.url;
      } catch {
        // Not a member of the channel, or canvases unavailable: caller posts the record to the thread.
        return null;
      }
    },
  };
}

/** In-memory backend for local UI work without spending agent runs. */
export function createMockBackend(): RoomBackend {
  let n = 0;
  const stances = ['for', 'against', 'conditional'];
  const fence = '`'.repeat(3);
  return {
    async createThread() { return `mock-thread-${Date.now()}`; },
    async post(_id, content) { console.info('[mock post]', content.slice(0, 120)); },
    async runAgent(agent, task) {
      await new Promise((r) => setTimeout(r, 400 + Math.random() * 800));
      if (task.includes('FINAL RULING')) {
        const ids = Array.from(task.matchAll(/\[(R\d+-S\d+) /g)).map((m) => m[1]);
        return `${fence}json\n${JSON.stringify({
          decision: 'GO WITH CONDITIONS: ship behind a flag to 10% first',
          rationale: 'Mock ruling for local testing.',
          strongestFor: ['Faster learning'],
          strongestAgainst: ['Rollback is untested'],
          dissent: ['SecOps — wants a pen test first'],
          openRisks: ['Flag cleanup debt'],
          confidence: 'medium',
          followUps: ['Write rollback runbook'],
          citedTurns: ids.slice(0, 3),
        })}\n${fence}`;
      }
      n += 1;
      return `STANCE: ${stances[n % 3]}\nCHANGED_MIND: ${n % 4 === 0 ? 'yes' : 'no'} — mock\nPOINTS:\n1. Mock point from ${agent}.\n2. Another mock point.`;
    },
    async createCanvas() { return null; },
  };
}
