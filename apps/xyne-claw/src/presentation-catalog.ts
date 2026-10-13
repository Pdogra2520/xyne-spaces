/**
 * Presentation tools as a Spaces-thread default.
 *
 * The presentation tools (post-code-block / post-diff / post-chart / visualize,
 * plus ask-user-question — see packages/xyne-claw-shared/src/tools/presentation.ts)
 * render a CARD inside a Spaces thread: the agent's answer, or the question it
 * needs answered before it can produce one. claw-auth's renderUiWidget
 * (routes/webhook.ts) posts them through /chat/postMessage, so they only mean
 * anything on a run that has a thread to post into.
 *
 * Because they exist for that surface, a thread run gets them regardless of the
 * agent's `tools.custom` selection — the same "framework default, not per-agent
 * config" rationale as the plan tools (todo-write / todo-read) in routes/run.ts.
 * The difference is delivery: plan tools go into the ALWAYS-ACTIVE set, these go
 * into the lazy CATALOG. The agent sees one index line per tool and pulls the
 * schema in with `load-tools` at the point of use, so a thread run pays almost
 * nothing for tools it may never call.
 *
 * How the catalog half already works (nothing here changes it):
 *   - buildToolCatalog tags them with PRESENTATION_CATALOG_SOURCE
 *   - buildFastModeDirectTools AND buildSubagentTools both skip them, so they
 *     never reach fastAlwaysActiveToolNames — which is what keeps them lazy
 *   - routes/run.ts keeps a catalog candidate only if it survived the
 *     `tools.custom` gate, which is the single thing this module unblocks
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { isPresentationToolSource, PRESENTATION_CATALOG_SOURCE } from "xyne-claw-shared";
import { UI_CATALOG, checkUiBlock, describeUiCatalog, findUiBlocks, forEachUiNode, parseUiBlock } from "xyne-claw-shared/gen-ui";
import { toPiSlug } from "./session-skills.js";

/**
 * Dispatch event types that mean "a person is talking to this agent in a Spaces
 * thread right now" — an ALLOWLIST, deliberately.
 *
 * claw-auth's /webhook emits exactly three mention event types (webhook.ts):
 * APP_MENTIONED, DIRECT_MESSAGE and USER_MENTIONED. USER_MENTIONED is absent
 * here on purpose: claw-auth sets responseMode "approval" for it, and
 * renderUiWidget DROPS code/diff/chart cards outside "conversation" mode. That
 * is the digital-twin draft-then-approve flow — it delivers through its own
 * approval surface, never as thread cards. Offering the tools there would be
 * worse than withholding them: the widget POST is fire-and-forget, so the tool
 * reports "Posted to the thread" while nothing ever appears.
 *
 * An allowlist and not "channelId is present, minus known exclusions", because
 * channelId ALONE does not mean Spaces thread. Two other dispatchers forward
 * one and send no eventType at all:
 *   - routes/run-stream.ts — the Ask AI composer (a dashboard chat surface)
 *   - routes/run.ts        — the S2S entry point, whose eventType is
 *                            caller-supplied and may be omitted
 * A deny-list predicate lets both through by default; this one cannot.
 */
export const THREAD_MENTION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "APP_MENTIONED",
  "DIRECT_MESSAGE",
]);

export interface PresentationCatalogRunContext {
  /** Set when the run posts into a Spaces channel. Necessary but NOT
   *  sufficient — see THREAD_MENTION_EVENT_TYPES. */
  channelId: string | undefined;
  /** Dispatch event type. Absent on Studio and Ask AI runs. */
  eventType: string | undefined;
  conversationId: string | undefined;
  /** run.ts's isReadOnlyJob, injected so this module stays dependency-light
   *  and the caller keeps ownership of the scheduled/automation definition. */
  isScheduledOrAutomationRun: (eventType: string | undefined, conversationId: string | undefined) => boolean;
}

/**
 * True when this run should get the presentation catalog for free — i.e. it is
 * an interactive Spaces thread mention with a channel to post cards into.
 *
 * The scheduled/automation check is redundant against the allowlist above (a
 * scheduled run carries eventType "scheduled"/"automation", not a mention type)
 * and is kept only to catch a mention-typed dispatch that is really a scheduled
 * replay — isReadOnlyJob also matches on a `scheduled_` conversationId prefix.
 */
export function presentationCatalogDefaultOn(ctx: PresentationCatalogRunContext): boolean {
  if (!ctx.channelId) return false;
  if (!ctx.eventType || !THREAD_MENTION_EVENT_TYPES.has(ctx.eventType)) return false;
  return !ctx.isScheduledOrAutomationRun(ctx.eventType, ctx.conversationId);
}

/**
 * True when `tool` is a presentation tool that this run gets for free — i.e.
 * the `tools.custom` gate in routes/run.ts should let it through even though
 * the agent never selected it. Returns false when the run isn't a thread run,
 * so the gate keeps its existing behaviour everywhere else.
 */
export function isFreePresentationTool(tool: { source?: string }, defaultOn: boolean): boolean {
  return defaultOn && isPresentationToolSource(tool.source);
}

/**
 * Context primer for a thread run that received the presentation catalog.
 *
 * Two jobs, both needed:
 *
 *  1. Tell the agent WHY it has these tools. The catalog index
 *     (renderToolCatalogForPrompt) lists them but says nothing about
 *     provenance, so an agent whose own tool config never mentioned
 *     post-chart can read the entry as something it is not entitled to and
 *     leave it alone. It is entitled to it — because of the SURFACE, not the
 *     config — and it should be told so plainly.
 *
 *  2. Tell it HOW to answer here. A Spaces thread is a chat surface: the reply
 *     is a message, not a document. Without guidance the common failure is
 *     posting a card AND repeating its contents in the text, which shows the
 *     user the same thing twice.
 *
 * Returns "" when the run's final catalog has no presentation entries — after
 * the read-only strips in routes/run.ts a thread run can still end up without
 * them, and a primer pointing at a catalog that isn't there is worse than
 * silence.
 */
export function buildPresentationPrimer(
  catalogEntries: ReadonlyArray<{ catalog: string }>,
): string {
  const count = catalogEntries.filter((e) => e.catalog === PRESENTATION_CATALOG_SOURCE).length;
  if (count === 0) return "";

  return [
    "## Answering in a Spaces Thread",
    "",
    "You were invoked by a mention in a Spaces thread, so your answer is delivered as",
    "chat messages in that thread — not as a document.",
    "",
    `Every thread run is given the \`${PRESENTATION_CATALOG_SOURCE}\` catalog. You have it because of WHERE`,
    "this run came from, not because this agent was configured with those tools, so",
    "treat them as yours to use. They are not loaded yet — pull in the whole set at once",
    `with \`load-tools\` (catalog \`${PRESENTATION_CATALOG_SOURCE}\`) as soon as you know you need any of them:`,
    "once you know what your answer is, or the moment you find you cannot answer without",
    "asking the user something.",
    "",
    "How to present the answer:",
    "- Blocked on a decision or a missing fact only the user has → ask with the",
    "  question card instead of guessing. Ask BEFORE you do the work, batch related",
    "  questions into one card, and stop your turn there — the answer arrives as a new",
    "  message. Don't spend a card on something you could look up yourself.",
    "- Code the reader will copy or apply (a patch, a config, a query they should run)",
    "  → post it as a card. A change to an existing file → post it as a diff.",
    "- Numbers worth comparing — a trend, a breakdown, a ranking → post a chart.",
    "- Short expressions, names, paths and single values → inline backticks in your",
    "  reply. Do NOT spend a card on them.",
    "- After posting a card, do NOT repeat its contents in your text. The user can",
    "  already see it. Write only what the card cannot say: what it shows and what to",
    "  do about it.",
    "- Prose is still the default. A card has to earn its place; a wall of cards does",
    "  not read as an answer.",
  ].join("\n");
}

// ── Generative UI (```ui blocks) ─────────────────────────────────────────────
//
// The streaming chat surfaces (the dashboard AI screen and AI sidebar, and the
// claw v3 chat) render a fenced ```ui block in a reply as a live interface;
// see packages/xyne-claw-shared/src/gen-ui.ts for the format. Spaces threads,
// DMs, Slack, WhatsApp and every background surface show it as raw JSON, so the
// instructions are opt-in per run: claw-auth sets `generativeUi` only for those
// three surfaces, and an agent can still switch it off with the `generative_ui`
// optimization.

/**
 * Built-in skill bundle with the design rules and worked examples behind the
 * primer, loaded where it exists (local development). Production does not ship
 * it in the image: there the same skill is a dashboard skill on the agent,
 * created from these files with the slug GENERATIVE_UI_SKILL_SLUG.
 */
export const GENERATIVE_UI_SKILL_PATH = "ui-skills";
export const GENERATIVE_UI_SKILL_SLUG = "generative-ui";

/** The built-in bundle for a run that draws blocks, when this checkout or image has it. */
export function generativeUiSkillPaths(packageDir: string, generativeUiOn: boolean): string[] {
  return generativeUiOn && existsSync(join(packageDir, GENERATIVE_UI_SKILL_PATH)) ? [GENERATIVE_UI_SKILL_PATH] : [];
}

/**
 * The run's skills without the generative-ui skill when the run cannot draw
 * blocks. A dashboard skill on the agent arrives with every run, and a Spaces
 * thread, Slack or a scheduled run must not be taught to write ```ui blocks.
 */
export function skillsForRun<T extends { slug?: string | undefined; name: string }>(skills: T[] | undefined, generativeUiOn: boolean): T[] | undefined {
  if (!skills || generativeUiOn) return skills;
  return skills.filter((s) => toPiSlug(s.slug || s.name.replace(/\.md$/i, "")) !== GENERATIVE_UI_SKILL_SLUG);
}

export interface GenerativeUiRunContext {
  /** The run payload's opt-in. Anything but `true` means off. */
  generativeUi: unknown;
  /** Every Spaces, Slack, WhatsApp, scheduled and automation dispatch sets one. */
  eventType: string | undefined;
  conversationId: string | undefined;
  isScheduledOrAutomationRun: (eventType: string | undefined, conversationId: string | undefined) => boolean;
  /** The reply is not a plain chat message: twin delivery, plan or daily-brief
   *  terminal tools, structured output, a task command, an experiment. */
  hasOwnDeliveryContract: boolean;
  /** The agent's `generative_ui` optimization. */
  enabled: boolean;
}

/** True when this run may answer with ```ui blocks and gets the primer and the skill. */
export function generativeUiDefaultOn(ctx: GenerativeUiRunContext): boolean {
  if (ctx.generativeUi !== true || !ctx.enabled || ctx.hasOwnDeliveryContract) return false;
  if (ctx.eventType) return false;
  return !ctx.isScheduledOrAutomationRun(ctx.eventType, ctx.conversationId);
}

/** Complete replies the primer ends with: a concept explained with an explorer, a workspace summary from tool data, a checklist, and things to recognise with pictures found by query. */
const GENERATIVE_UI_EXAMPLES = [
  "Example: explaining a concept (illustrative numbers)",
  "",
  "A cache keeps a copy of data close to where it is used, so most reads skip the slow trip to the source. What decides the speed-up is the **hit rate**: the share of reads the copy can answer.",
  "",
  "```ui",
  '{"title":"How a cache works","state":{"hit":80}}',
  '{"type":"grid","cols":3,"children":[{"type":"card","title":"1. Look in the cache","children":[{"type":"badge","text":"Every read"},{"type":"text","text":"Each read checks the fast copy first.","tone":"muted"}]},{"type":"card","title":"2. Hit","children":[{"type":"badge","text":"About 2 ms","tone":"positive"},{"type":"text","text":"The copy is there, so the answer comes straight back.","tone":"muted"}]},{"type":"card","title":"3. Miss","children":[{"type":"badge","text":"About 80 ms","tone":"warning"},{"type":"text","text":"Fetch from the source, then keep a copy for next time.","tone":"muted"}]}]}',
  '{"type":"card","title":"Try the hit rate","children":[{"type":"grid","cols":2,"children":[{"type":"stat","value":"{{ round(hit / 100 * 2 + (100 - hit) / 100 * 80, 1) }} ms","label":"Average read"},{"type":"stat","value":"{{ round(80 / (hit / 100 * 2 + (100 - hit) / 100 * 80), 1) }}x","label":"Faster than no cache"}]},{"type":"slider","name":"hit","label":"Hit rate","min":0,"max":100,"step":5,"unit":"%"},{"type":"text","text":"Illustrative timings: an in-memory cache in front of a database across the network.","tone":"muted","size":"sm"}]}',
  "```",
  "",
  "Going from 80% to 95% hits cuts the average read from 17.6 ms to 5.9 ms, which is why expiry rules matter more than cache size.",
  "",
  "Example: a workspace summary from tool results (the data is invented for the example; use only what your tools return)",
  "",
  "Your workspace is small and quiet this week; the one thing with a deadline is the login timeout, and it is yours.",
  "",
  "```ui",
  '{"type":"card","title":"Workspace at a glance","sub":"Acme · this week","children":[{"type":"grid","cols":4,"children":[{"type":"stat","label":"Channels","value":"12","note":"3 active today"},{"type":"stat","label":"Boards","value":"2"},{"type":"stat","label":"Open tickets","value":"3","note":"2 on you","tone":"warning"},{"type":"stat","label":"Members","value":"18"}]}]}',
  '{"type":"card","title":"Open tickets","children":[{"type":"list","dividers":true,"items":[{"title":"Fix login timeout","sub":"Platform board","media":{"type":"icon","name":"bug","tone":"danger"},"facts":[{"icon":"calendar","text":"Due Friday"},{"icon":"user","text":"You"}],"badge":{"text":"P0","tone":"danger"}},{"title":"Update onboarding doc","sub":"Docs board","media":{"type":"icon","name":"file"},"facts":[{"icon":"user","text":"You"}],"badge":{"text":"P2"}},{"title":"Quarterly metrics","sub":"Ops board · in review","media":{"type":"icon","name":"chart","tone":"accent"},"facts":[{"icon":"user","text":"Meera"}]}]}]}',
  "```",
  "",
  "I can draft a status update on the login timeout if that helps.",
  "",
  "Example: a checklist from tasks the user listed",
  "",
  "Two of the five launch tasks are done; the demo video is the long pole.",
  "",
  "```ui",
  '{"type":"card","title":"Launch checklist","aside":"{{ len(done) }} of 5 done","children":[{"type":"list","check":"done","dividers":true,"items":[{"id":"freeze","title":"Freeze the feature list","facts":[{"icon":"calendar","text":"Mon"},{"icon":"clock","text":"1h"}],"badge":{"text":"P0","tone":"danger"},"done":true},{"id":"video","title":"Record the demo video","facts":[{"icon":"calendar","text":"Wed"},{"icon":"clock","text":"3h"}],"badge":{"text":"P1","tone":"warning"}},{"id":"post","title":"Write the launch post","facts":[{"icon":"calendar","text":"Thu"},{"icon":"clock","text":"2h"}],"badge":{"text":"P1","tone":"warning"}},{"id":"support","title":"Brief the support team","facts":[{"icon":"calendar","text":"Thu"},{"icon":"clock","text":"1h"}],"badge":{"text":"P2"},"done":true},{"id":"announce","title":"Schedule the announcement","facts":[{"icon":"calendar","text":"Fri"},{"icon":"clock","text":"30m"}],"badge":{"text":"P2"}}]}]}',
  "```",
  "",
  "Example: things to recognise, with pictures found by query",
  "",
  "Three houseplants cope with a dim room, and the **snake plant** is the hardest to kill.",
  "",
  "```ui",
  '{"type":"grid","cols":3,"children":[{"type":"card","title":"Snake plant","children":[{"type":"image","query":"snake plant sansevieria","alt":"A snake plant in a pot","ratio":"3/2"},{"type":"badge","text":"Hardest to kill","tone":"positive"},{"type":"text","text":"Water once a month; fine in a dark corner.","tone":"muted"}]},{"type":"card","title":"ZZ plant","children":[{"type":"image","query":"zz plant zamioculcas","alt":"A ZZ plant with glossy leaves","ratio":"3/2"},{"type":"badge","text":"Glossy leaves"},{"type":"text","text":"Stores water in its roots, so skip a few waterings.","tone":"muted"}]},{"type":"card","title":"Pothos","children":[{"type":"image","query":"pothos houseplant","alt":"A trailing pothos","ratio":"3/2"},{"type":"badge","text":"Fast growing"},{"type":"text","text":"Trails from a shelf and droops when thirsty.","tone":"muted"}]}]}',
  "```",
].join("\n");

/**
 * How to write a ```ui block. Goes into the system prompt so it is identical
 * on every turn and stays in the prompt cache. The catalog is generated from
 * the validator's own table, so the two cannot drift.
 */
export function buildGenerativeUiPrimer(): string {
  return [
    "## Interactive answers (`ui` blocks)",
    "",
    "This chat draws interfaces inside your reply, the way ChatGPT does. Write a fenced code block whose language is `ui` and the chat renders it live while you write: cards, grids, stat tiles, lists with badges, colour swatches, tables, sliders and buttons. People take in a drawn answer much faster than paragraphs, so on this chat **a structured answer is a drawn answer**.",
    "",
    "### When to draw",
    "Draw at least one block whenever the answer has any of these, whether it comes from your own knowledge or from tool results:",
    "- the parts, kinds or properties of something: explaining a concept through its pieces (colour harmonies, the stages of a model, the layers of a protocol);",
    "- two or more things compared on a few attributes;",
    "- steps, a process or a timeline;",
    "- numbers, counts or totals (a workspace summary, usage, prices);",
    "- items that each have a status (tickets, channels, PRs, tasks, people);",
    "- something to look at: colours and palettes, or real things people know by sight (places, breeds, plants, dishes, materials, landmarks), which get photos the chat finds from an image `query`;",
    "- a choice only the user can make, or a value they may want to adjust (a what-if).",
    "",
    "Use plain prose with no block only for greetings and thanks, a one-line fact or a yes/no, a short opinion, writing tasks (an email, a message, a poem, a rewrite), code, or when the user asks for plain text.",
    "",
    'Your other instructions say to just answer conversational questions and to match the form to the content. Both still hold: on this chat a block IS the matching form for structured content, and writing one is not a tool call, so it needs no plan and no tools. "Explain X" and "summarise Y" are the most common places to draw.',
    "",
    "### Shape of the reply",
    "1. Open with one or two sentences that answer the question.",
    "2. Build the rest in sections: a short markdown heading or lead sentence, the block that shows it, then at most one sentence on what to take from it. Use one to three blocks per reply, each with one purpose. Say each fact once: in a block or in prose, never both, and never the same comparison twice.",
    "3. Close with the next step or the one caveat that matters, in prose.",
    "",
    "### Layout recipes",
    "Put parallel things side by side on a grid; stack only what is read in order. A block that summarises something is one `card` with a header: `title`, a `sub` line for its scope (\"Oct 19 – 25 · 5 workdays\") and on the right an `aside` count (\"{{ len(done) }} of 6 completed\") or a `badge` state (\"Week 43\", \"At risk\").",
    "- At a glance (counts, totals, key numbers): that card holding a `grid` with cols 2 or 4 of `stat` tiles (label, value, and a `note` saying what the number means, toned by meaning), then a `progress` with a `note` when there is a goal.",
    "- Kinds or parts of a concept: a `grid` with cols 2 or 3 of `card`s, every card with the same parts in the same order (title, then a visual such as swatches or a badge, then one or two short lines).",
    '- Items with a status (tickets, risks, PRs, people): a `list` with `dividers`; each row gets an icon tile naming its kind (`media` {"type":"icon","name":"bug","tone":"danger"}), a one-line `sub`, `facts` for its date, duration or owner, and a `badge` for its priority or status; a `table` when every item has three or more attributes.',
    "- Tasks and to-dos: a `list` with `check` so each row can be ticked (`done`:true for finished ones), in a card whose `aside` counts them.",
    '- A schedule, agenda or itinerary: a `timeline`, with `groups` (one per day: label "Mon", value its date "19", worked out from today\'s date, or left out) when it spans days; every event has its `time`, and `tone` tints the ones that matter (accent for focus time, warning for a clash).',
    "- Steps or a plan: a `list` with `numbered`, a `meta` line for each step's time and a one-line `sub`, then a `callout` with an `icon` for the one recommendation; a `grid` of numbered cards when the steps are parallel.",
    "- A board (work by status): a `grid` with cols 3 of `stack`s, one per status, each headed by a `row` of a circle-dot `icon` toned for that status (none for to do, accent for in progress, positive for done), the column name and a count `badge`, then one `card` per item: its `title`, a `sub` line, its priority as the card's own `badge`, and a `select` for its status with no label (it is named after its card). End with one send button that saves the changes.",
    "- Explorer or what-if: one `card` with the live result first (a large `swatch`, a `stat` or bold `text` with {{ }}), then the `slider` or `segmented` controls, then a reset button. Every control must visibly change the result, every number beside a control is computed from it, and the start values are a typical, vivid case, never empty or grey.",
    "- Palettes and colour schemes: `list` items whose `media` is an array of swatches.",
    "- Places, things and products to recognise (a trip, a material, a species): a `grid` of `card`s, each opening with an `image` whose `query` names its subject.",
    "- A decision: a `choice` with the recommended option marked, and one send button.",
    'When the answer has one obvious next step you can take (draft, save, schedule), end its card with one full-width button ("full":true) named for that outcome.',
    "",
    "### How to write one",
    "- Inside the fence every line is ONE JSON object (JSON Lines): no commas between lines, no comments. Keep each top-level block on one line. A line appears the moment it ends, so write the most important block first.",
    "- Line 1 (optional): {\"title\":\"...\",\"state\":{\"name\":initialValue}}. `state` declares the values inputs read and write; each key is an input's name. Leave out `title` when a markdown heading already introduces the block, and when the block is a single titled card.",
    '- Every other line: {"type":"<component>", ...props}. Containers take "children":[...]. Write the real text, never a placeholder such as {workspace}.',
    "- Live values: text-like props, table cells, list fields and set values may contain {{ expression }} using state names, numbers, 'strings', + - * / % < > <= >= == != && || ! ?: and round(x, digits), ceil, floor, min, max, clamp(x, lo, hi), abs, pow(x, y), sqrt, fmt(x, digits) (1,234.50), pct(42) (42%), mix('#rrggbb', '#rrggbb', 0-1) and mute('#rrggbb', 0-1) for colours, concat, lower, upper, len. `+` adds numbers (a choice's numeric text counts as a number) and joins other text. \"show\":\"expression\" (no braces) hides a component unless it is true. No expressions in type, kind, tone, name, src or href.",
    '- A button sends by default ("do":"send"): it posts its text plus a "Label: value" line for every visible input as a normal, visible message from the user, which you receive as their next message. "do":"reset" restores the initial state and {"set":{"name":value}} changes state; a value may be an expression, e.g. {"set":{"qty":"{{ qty + 1 }}"}} for a +1 button. A button never does anything hidden.',
    "",
    "### Design rules (the full set and more worked replies are in the `generative-ui` skill)",
    "- Same kind of thing, same component and the same structure: every cell of a grid alike, every list row alike. Never a card inside a card.",
    '- One primary button per group, named for its outcome ("Draft the reply"), never "Submit" or "OK". A destructive action uses kind "danger" and says what will be lost.',
    "- At most 5 options per choice; mark the recommended one and say why. Segmented for 2-4 short options, toggle for yes/no, slider for a range with min, max and unit.",
    "- Ask only for what you cannot infer, prefill what the user told you, and make every default exactly what they asked for.",
    "- Colour only through tone (neutral, accent, positive, warning, danger), always with words; raw colours only in swatch.color. Spacing, sizes and fonts come from the renderer.",
    "- Tone by meaning, the same way everywhere in a reply: danger = blocked, overdue, high or P0; warning = at risk, due soon, medium or P1; positive = done or on track; accent = current or highlighted; no tone for the rest. Icons come only from the icon list, at most one per row or header, and name the kind of thing (bug, calendar, git-pull-request), never decorate.",
    '- Show the inputs next to any computed result, label estimates as estimates, and never invent data: draw only what you know or fetched. Use a citation component for facts you did not compute (inline citation tokens do not render inside a block; keep those in your prose). A table that can be empty gets an "empty" text.',
    '- Pictures: give an `image` a `query`, a few plain words naming a real, public, photographable subject ("Palolem beach Goa", "burnt sienna oil paint"), and the chat finds an openly licensed photo and credits it. Never write a query for a diagram, chart, screenshot or interface, for a person, or with anything private or from the workspace. Use `src` only for an https URL you were given, and always give real alt text. Links must be https.',
    "- Code, diffs and charts are not `ui` blocks: use the code, diff and chart cards or the visualize tool when you have them, and a normal code fence otherwise. A `ui` block is not code either, so any rule about posting code fences as cards does not apply to it: write it directly in this reply, never through post-code-block. If you are blocked before you can start and have ask-user-question, keep using it.",
    "- Only this reply can carry a block. Never put one in anything you send through a tool (thread messages, tickets, emails, files, documents).",
    "",
    "Components (* = required):",
    describeUiCatalog(),
    "",
    GENERATIVE_UI_EXAMPLES,
  ].join("\n");
}

/**
 * Problems with the ```ui blocks in a finished reply, one line each, for the
 * retry nudge. Empty when every block is clean. A prop the chat simply ignores
 * (level "prop") is not worth a whole hidden rewrite: the block draws fine.
 */
export function uiBlockProblems(reply: string): string[] {
  const blocks = findUiBlocks(reply);
  const problems: string[] = [];
  blocks.forEach((block, index) => {
    const where = blocks.length > 1 ? `block ${index + 1}, ` : "";
    if (!block.closed) problems.push(`${where}the block is never closed: end it with a line holding only \`\`\``);
    for (const issue of checkUiBlock(block.text).issues) {
      if (issue.level === "prop") continue;
      problems.push(`${where}${issue.path}: ${issue.message} (fix: ${issue.fix})`);
    }
  });
  return problems.slice(0, 12);
}

/**
 * True when a reply's ```ui block hands the turn back to the user: it has an
 * input, or a button that sends. Like a question, such a reply is finished by
 * design, so nothing may push the agent to "complete" it on the user's behalf.
 */
export function uiBlockAwaitsUser(reply: string): boolean {
  return findUiBlocks(reply).some((block) => {
    let waits = false;
    forEachUiNode(
      parseUiBlock(block.text).blocks.map((b) => b.node),
      (node) => {
        const action = node["do"];
        if (UI_CATALOG[node.type]?.input || (node.type === "button" && (action === undefined || action === "send"))) waits = true;
      },
    );
    return waits;
  });
}

/** The one-shot hidden nudge sent when a reply's ```ui block fails the check. */
export function uiBlockRetryNudge(problems: readonly string[]): string {
  return [
    "Your reply contains a `ui` block the chat cannot show correctly:",
    ...problems.map((problem) => `- ${problem}`),
    "",
    "Write your COMPLETE reply again with the block fixed: the same answer and the same prose, one JSON object per line. If a block cannot express it, answer in plain markdown instead. Do not mention this check and do not apologise.",
  ].join("\n");
}
