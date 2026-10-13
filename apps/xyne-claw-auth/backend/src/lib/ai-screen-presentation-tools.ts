/**
 * Surface-default presentation tools for the Xyne AI chat — same per-run
 * injection pattern as Slack's subagent (surfaces/slack/dispatch.ts). claw frees
 * these only for Spaces thread/DM mentions, so an agent with a curated
 * `tools.custom` otherwise cannot post a card here. Applied on run/stream only.
 */

import { resolveAgentToolsConfig } from "xyne-claw-shared";

/** `visualize` is excluded: no presentation `source`, no UiWidget of its own. */
export const AI_SCREEN_PRESENTATION_TOOL_SLUGS = [
  "ask-user-question",
  "post-code-block",
  "post-diff",
  "post-chart",
] as const;

/**
 * `storedTools` is separate because the config Spaces forwards has no `tools`
 * key: startRun merges stored-then-body, so the widened copy must ride in on
 * the body to win.
 *
 * The grant follows the same rule claw enforces (resolveAgentToolsConfig):
 * only an orchestrator with nothing selected is unrestricted, so only it is
 * left alone. A standard agent with nothing selected is granted NOTHING by
 * claw, so it must get an explicit `{ custom: [...] }` here — otherwise the
 * cards are filtered out before the model ever sees them.
 */
export function withAiScreenPresentationTools(
  config: Record<string, unknown>,
  storedTools: unknown,
  delegationTier?: string | null,
): Record<string, unknown> {
  const stored = storedTools && typeof storedTools === "object" && !Array.isArray(storedTools)
    ? storedTools as Record<string, unknown>
    : undefined;
  const enforced = resolveAgentToolsConfig(stored ? { tools: stored } : {}, delegationTier ?? "standard");
  if (!enforced) return config;
  const toolsObj = enforced as Record<string, unknown>;
  const custom = Array.isArray(toolsObj["custom"])
    ? (toolsObj["custom"] as unknown[]).filter((value): value is string => typeof value === "string")
    : [];
  const missing = AI_SCREEN_PRESENTATION_TOOL_SLUGS.filter((slug) => !custom.includes(slug));
  if (missing.length === 0) return config;
  return { ...config, tools: { ...toolsObj, custom: [...custom, ...missing] } };
}

/** Xyne AI counterpart to claw's buildPresentationPrimer, which only fires for
 *  thread runs. These are catalog entries, so without guidance the model never
 *  spends the `load-tools` turn. */
const INSTRUCTIONS_HEAD = [
  "## Artifact cards in this chat",
  "",
  "You can render cards into this conversation with `ask-user-question`,",
  "`post-code-block`, `post-diff` and `post-chart`. You have them because of WHERE",
  "this run came from, not because this agent was configured with them, so treat",
  "them as yours to use. They are NOT loaded yet — pull the set in with",
  "`load-tools` as soon as you know you need any of them: once you know what your",
  "answer is, or the moment you find you cannot answer without asking the user",
  "something.",
  "",
  "When to use which:",
  "- Blocked on a decision, or on a fact only the user has → ask with",
  "  `ask-user-question` instead of guessing. Ask BEFORE doing the work, batch",
  "  related questions into ONE card, and stop your turn there — the answer",
  "  arrives as a new message and a fresh run continues the task. Don't spend a",
  "  card on something you could look up yourself.",
];

const CODE_CARD_RULE = [
  "- Multi-line code ALWAYS goes in a card — this is not a judgement call. If you",
  "  are about to type a ``` fence in your reply, stop: call `load-tools` and post",
  "  it with `post-code-block` instead. A change to an existing file →",
  "  `post-diff`. This holds even for a short answer or a question outside your",
  "  usual scope.",
];

/** Generative UI requested: the no-fences rule is about CODE fences only, so it
 *  cannot be read as forbidding a ```ui block. How to write one is claw's call
 *  (its primer), since claw alone decides whether the run gets it. */
const CODE_CARD_RULE_GENERATIVE_UI = [
  "- Multi-line CODE ALWAYS goes in a card — this is not a judgement call. If you",
  "  are about to type a code ``` fence in your reply, stop: call `load-tools` and post",
  "  it with `post-code-block` instead. A change to an existing file →",
  "  `post-diff`. This holds even for a short answer or a question outside your",
  "  usual scope.",
];

const INSTRUCTIONS_TAIL = [
  "- Numbers worth comparing — a trend, a breakdown, a ranking → `post-chart`.",
  "- Short expressions, names, paths and single values → inline backticks in your",
  "  reply. Do NOT spend a card on them.",
  "- After posting a card, do NOT repeat its contents in your text. Write only",
  "  what the card cannot say: what it shows and what to do about it.",
];

const PROSE_DEFAULT_RULE = [
  "- Prose is the default for everything else (explanations, names, paths, single",
  "  values). Code blocks are the exception above, not a card to be earned.",
];

/** Generative UI requested: when an answer is drawn is claw's call (its primer
 *  draws structured answers, explanations included), so this list must not
 *  name prose as the default for explanations. The eval behind the primer saw
 *  this line keep explanations in prose. */
const PROSE_DEFAULT_RULE_GENERATIVE_UI = [
  "- Code blocks are the exception above, not a card to be earned.",
];

function buildPresentationInstructions(generativeUi: boolean): string {
  return [
    ...INSTRUCTIONS_HEAD,
    ...(generativeUi ? CODE_CARD_RULE_GENERATIVE_UI : CODE_CARD_RULE),
    ...INSTRUCTIONS_TAIL,
    ...(generativeUi ? PROSE_DEFAULT_RULE_GENERATIVE_UI : PROSE_DEFAULT_RULE),
  ].join("\n");
}

export const AI_SCREEN_PRESENTATION_INSTRUCTIONS = buildPresentationInstructions(false);

export function withAiScreenPresentationInstructions(
  existing: string | undefined,
  opts?: { generativeUi?: boolean },
): string {
  const base = typeof existing === "string" ? existing.trim() : "";
  const instructions = opts?.generativeUi === true
    ? buildPresentationInstructions(true)
    : AI_SCREEN_PRESENTATION_INSTRUCTIONS;
  return base ? `${base}\n\n${instructions}` : instructions;
}
