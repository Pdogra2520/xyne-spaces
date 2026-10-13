/**
 * Generative UI: the fenced ```ui block an agent writes inside a chat reply.
 *
 * Inside the fence every line is one JSON object (JSON Lines):
 *   line 1 (optional)  {"title": "...", "state": {"name": initialValue}}
 *   every other line   one top-level block {"type": "<component>", ...props}
 *
 * The block streams as ordinary text deltas, so a reader turns each finished
 * line into a final block while the line still being typed renders as a draft.
 * Interactivity stays in the browser: inputs write to state, {{ expressions }}
 * recompute locally, and the only action that leaves the block is "send",
 * which posts a normal, visible user message.
 *
 * Pure data and pure functions with no imports, so the agent runtime (prompt
 * catalog, answer check) and both chat frontends (renderer) read one set of
 * rules. The frontends cannot import workspace packages at build time, so this
 * file is copied verbatim to:
 *   apps/dashboard/src/components/Markdown/GenerativeUi/genUiCore.ts
 *   apps/xyne-claw-auth/frontend/src/v3/components/genui/genUiCore.ts
 * Edit it here, then run `pnpm --filter xyne-claw-shared sync:gen-ui`.
 * gen-ui.test.ts fails while a copy is stale.
 */

export const UI_FENCE_LANG = "ui";

export const UI_LIMITS = {
  /** Text inside one fence. */
  bytes: 32_000,
  /** Long text props (text). */
  str: 4_000,
  /** Every other string prop (labels, titles, options). */
  shortStr: 600,
  depth: 10,
  nodes: 120,
  expr: 400,
  exprDepth: 40,
} as const;

// ── Catalog ─────────────────────────────────────────────────────────────────

export type UiPropType = "string" | "number" | "boolean" | "array" | "object" | "any" | readonly (string | number)[];

export interface UiComponentDef {
  /** Takes `children`. */
  kids?: boolean;
  /** Writes a value to state under its `name`. */
  input?: boolean;
  doc: string;
  hint?: string;
  props: Readonly<Record<string, UiPropType>>;
  required?: readonly string[];
}

export const UI_TONES = ["neutral", "accent", "positive", "warning", "danger"] as const;
export type UiTone = (typeof UI_TONES)[number];
const GAPS = ["xs", "sm", "md", "lg"] as const;

/** Icon names a block may use. Each chat draws them with its own icon set (the dashboard with @xyne/icons). */
export const UI_ICONS = [
  "check", "check-circle", "x-circle", "alert-triangle", "alert-circle", "info", "clock", "calendar", "timer", "hourglass",
  "target", "flag", "lightbulb", "sparkles", "shield", "lock", "key", "star", "heart", "thumbs-up", "award", "trophy",
  "zap", "rocket", "bug", "wrench", "settings", "code", "database", "server", "layers", "layout-grid", "kanban",
  "list-checks", "chart", "pie-chart", "trending-up", "trending-down", "activity", "user", "users", "bot", "message",
  "mail", "bell", "megaphone", "phone", "video", "hash", "ticket", "git-pull-request", "file", "folder", "inbox", "tag",
  "link", "search", "globe", "map-pin", "home", "building", "briefcase", "dollar", "wallet", "credit-card",
  "shopping-cart", "package", "gift", "travel", "car", "utensils", "coffee", "sun", "moon", "camera", "palette", "book",
  "graduation-cap", "monitor", "smartphone", "eye", "pen", "refresh", "arrow-right", "play", "circle-dot",
] as const;
const ICON_SET = new Set<string>(UI_ICONS);

export const UI_CATALOG: Readonly<Record<string, UiComponentDef>> = Object.freeze({
  stack: { kids: true, doc: "Vertical group. The default container.", props: { gap: GAPS, align: ["start", "center", "end"] } },
  row: { kids: true, doc: "Horizontal group that wraps on narrow screens.", props: { gap: GAPS, align: ["start", "center", "end"], wrap: "boolean" } },
  grid: { kids: true, doc: "Equal columns (2, 3, or 4 for stats) that collapse on narrow screens.", hint: "Same component in every cell.", props: { cols: [2, 3, 4], gap: GAPS } },
  card: {
    kids: true,
    doc: "Bordered surface with an optional header: title, sub (a muted line under it), icon before the title, and on the right either aside (muted text such as \"2 of 6 done\") or badge {text,tone}.",
    hint: "One idea per card; never a card inside a card.",
    props: { title: "string", sub: "string", icon: "string", aside: "string", badge: "object", tone: UI_TONES },
  },
  disclosure: { kids: true, doc: "Collapsed-by-default detail (progressive disclosure).", props: { title: "string", open: "boolean" }, required: ["title"] },
  heading: { doc: "Section heading, level 1-4.", props: { text: "string", level: [1, 2, 3, 4] }, required: ["text"] },
  text: {
    doc: 'Paragraph. Inline **bold**, *italic*, `code`, [label](https-url); lines starting "- " become bullets.',
    props: { text: "string", tone: ["default", "muted", "positive", "warning", "danger", "accent"], size: ["sm", "base", "lg"] },
    required: ["text"],
  },
  list: {
    doc: 'Rows. items: strings or objects {title*, meta (small line above the title, e.g. a time), sub (muted line), text, badge:{text,tone} (shown on the right), facts:[{icon,text}] (a row of small details such as a date or a duration), media:{type:"icon",name,tone} (a tinted icon tile) or {type:"image"|"swatch",...} or an array of up to 6 swatches (a palette strip), id, done}. numbered:true draws circled step numbers. check:"stateName" makes every row a checkbox: the state holds the ids (or titles) of the ticked rows, done:true rows start ticked, and ticked rows are struck through.',
    props: { items: "array", dividers: "boolean", numbered: "boolean", check: "string", label: "string" },
    required: ["items"],
  },
  badge: { doc: "Small status pill.", hint: "Badge only the one thing that matters most.", props: { text: "string", tone: UI_TONES }, required: ["text"] },
  stat: {
    doc: "A key figure: value (a number or a short text) drawn large, label saying what it counts, and an optional one-line note (a change, a caveat) coloured by tone.",
    hint: "Put 2-4 stats in a grid for an at-a-glance row.",
    props: { value: "any", label: "string", note: "string", tone: UI_TONES },
    required: ["value", "label"],
  },
  image: {
    doc: 'Picture in a reserved box while it loads. Give query, a few words naming a real, public, photographable subject ("Palolem beach Goa", "burnt sienna oil paint"), and the chat finds a matching openly licensed photo and credits it; or src, an https URL you were given. alt is required.',
    hint: "No query for diagrams, charts, screenshots, people or anything private.",
    props: { src: "string", query: "string", alt: "string", ratio: ["1/1", "4/5", "3/2", "16/9"], caption: "string" },
    required: ["alt"],
  },
  swatch: {
    doc: "A drawn colour or shape mark (circle or square), optionally half or empty; size xl is a large preview tile with the label inside.",
    props: { color: "string", shape: ["circle", "square"], fill: ["full", "half", "empty"], size: ["sm", "md", "lg", "xl"], label: "string" },
    required: ["label"],
  },
  table: {
    doc: 'Comparison table. columns: ["Plan","Price"]; rows: [["Free","$0"],["Pro","$20"]] = an array of arrays with exactly as many cells as columns (**bold** allowed in a cell).',
    props: { columns: "array", rows: "array", empty: "string" },
    required: ["columns", "rows"],
  },
  callout: { doc: "One highlighted note, with an optional icon before its title.", props: { text: "string", title: "string", icon: "string", tone: UI_TONES }, required: ["text"] },
  progress: {
    doc: "Progress bar (value 0-100), or indeterminate when value is omitted. note replaces the percentage on the right (e.g. \"28 of 35 hours · 80%\"); tone colours the bar.",
    props: { value: "number", label: "string", note: "string", tone: UI_TONES },
    required: ["label"],
  },
  icon: {
    doc: `A small icon beside text in a row. name: one of ${UI_ICONS.join(", ")}.`,
    hint: "Icons help scanning; one per row or item, never decoration alone.",
    props: { name: "string", tone: UI_TONES, size: ["sm", "md", "lg"], label: "string" },
    required: ["name"],
  },
  timeline: {
    doc: 'A schedule, itinerary or history. items: [{time, title*, sub, tone, icon}] in order; or groups: [{label:"Mon", value:"19", items:[...]}] for one column per day. tone tints an item (accent = highlight, warning = at risk).',
    props: { items: "array", groups: "array" },
  },
  divider: { doc: "Hairline between groups.", props: {} },
  citation: { doc: "Source chip.", hint: "Use for any fact or number you did not compute yourself.", props: { label: "string", href: "string", count: "number" }, required: ["label"] },
  choice: {
    input: true,
    doc: 'Pick one (radio) or many (checkbox, multiple:true). options is an array of strings, e.g. ["Small","Large"].',
    hint: "At most 5 options; mark one recommended.",
    props: { name: "string", label: "string", options: "array", value: "any", multiple: "boolean", recommended: "string" },
    required: ["name", "options"],
  },
  segmented: { input: true, doc: "Compact exclusive toggle for 2-4 short options.", props: { name: "string", label: "string", options: "array", value: "string" }, required: ["name", "options"] },
  select: { input: true, doc: "Dropdown to pick one of many options (or a compact pick inside a card, such as a status).", props: { name: "string", label: "string", options: "array", value: "string" }, required: ["name", "options"] },
  slider: {
    input: true,
    doc: "Continuous value with min, max, step and unit.",
    props: { name: "string", label: "string", min: "number", max: "number", step: "number", unit: "string", value: "number" },
    required: ["name", "label", "min", "max"],
  },
  input: {
    input: true,
    doc: 'Text, number or email field with a label and optional help. Use inputType:"number" for numbers.',
    props: { name: "string", label: "string", inputType: ["text", "number", "email"], placeholder: "string", help: "string", value: "any" },
    required: ["name", "label"],
  },
  toggle: { input: true, doc: "On/off switch.", props: { name: "string", label: "string", value: "boolean" }, required: ["name", "label"] },
  button: {
    doc: 'Action. do: "send" (the default: posts the button text and the current values as a normal, visible message from the user), "reset", or {"set":{"key":value}} for declared state (a value may be "{{ expression }}", e.g. {"set":{"qty":"{{ qty + 1 }}"}}).',
    hint: "One primary per group, labelled with its outcome.",
    props: { text: "string", kind: ["primary", "secondary", "danger", "link"], full: "boolean", do: "any" },
    required: ["text"],
  },
} satisfies Record<string, UiComponentDef>);

/** Props every component accepts. */
const COMMON_PROPS: Readonly<Record<string, UiPropType>> = { id: "string", show: "string" };
/** Props whose values may contain {{ expressions }}. Enums, URLs, names and types must be literal. */
const EXPR_PROPS = new Set(["text", "title", "sub", "aside", "label", "caption", "help", "placeholder", "unit", "empty", "color", "value", "note", "min", "max", "step", "show"]);
const URL_PROPS = new Set(["src", "href"]);
const LIST_ITEM_KEYS = ["title", "meta", "sub", "text", "badge", "facts", "media", "id", "done"];
const TIMELINE_ITEM_KEYS = ["time", "title", "sub", "tone", "icon"];
/** Props a component cannot be drawn without the right shape of; any other bad prop is ignored. */
const STRUCTURAL_PROPS = new Set(["list.items", "choice.options", "segmented.options", "select.options", "table.columns", "table.rows", "slider.min", "slider.max", "image.src"]);

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isNil = (v: unknown): v is null | undefined => v === null || v === undefined;
const trunc = (s: unknown, n = 40): string => String(s).slice(0, n);

export const isUiComponent = (type: unknown): type is string => typeof type === "string" && has(UI_CATALOG, type);

/** A safe https link or image source. */
export function isSafeUrl(v: unknown): v is string {
  return typeof v === "string" && v.length <= 2_000 && /^https:\/\/[^\s"'<>\\]+$/i.test(v);
}

/**
 * A literal CSS colour the renderer may paint (swatch only). Anything that
 * could fetch (url()), break out of the declaration or read page variables is
 * refused.
 */
export function isSafeColor(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 60) return false;
  const s = v.trim();
  return /^#[0-9a-f]{3,8}$/i.test(s) || /^(?:rgb|hsl)a?\(\s*[-\d.%\s,/deg]+\)$/i.test(s) || /^[a-z]{3,20}$/i.test(s);
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface UiNode {
  type: string;
  [prop: string]: unknown;
}

/** A picture a chat found for an image's `query` (claw-auth GET /genui/image?q=). */
export interface UiImageHit {
  /** https URL to show, sized for a chat column. */
  src: string;
  width?: number;
  height?: number;
  title?: string;
  /** The page the picture comes from, for the credit link. */
  sourceUrl?: string;
  /** Who made it, or the collection it comes from. */
  credit?: string;
  /** "CC BY 2.0", "CC0", "Public domain". */
  license?: string;
  licenseUrl?: string;
}

export interface UiMeta {
  title?: string;
  state?: Record<string, unknown>;
}

export interface UiIssue {
  /** "line 3" or "line 3 › children[1]". */
  path: string;
  message: string;
  fix: string;
  /**
   * fatal: this component cannot be drawn; the chat leaves it out and draws
   *   the rest of the block (see drawableUiLine).
   * prop: drawn without the offending prop, which the renderer ignores or
   *   replaces with its default.
   * reference: renders, but an expression or action points at an undeclared name.
   * ux: renders, but breaks a design rule the agent must follow.
   */
  level: "fatal" | "prop" | "reference" | "ux";
}

// ── Partial JSON (the line still being typed) ───────────────────────────────

const isWs = (c: number): boolean => c === 32 || c === 10 || c === 13 || c === 9;
const COMPLETE_TOKEN = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)$/;

/** Index of the opening quote of the string whose closing quote is s[end-1]. */
function stringStart(s: string, end: number): number {
  for (let i = end - 2; i >= 0; i--) {
    if (s.charCodeAt(i) !== 34) continue;
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && s.charCodeAt(j) === 92; j--) backslashes++;
    if (backslashes % 2 === 0) return i;
  }
  return -1;
}

interface Frame {
  /** 123 "{" or 91 "[" */
  open: number;
  /** 0 expect key, 1 expect colon, 2 expect value, 3 after value, 4 inside a bare token */
  at: number;
}

/**
 * Best-effort parse of a JSON prefix in linear time: closes open strings,
 * arrays and objects, and drops a dangling key or a half-typed token.
 * Returns undefined when nothing sensible can be recovered.
 */
export function parsePartialJson(src: string): unknown {
  if (typeof src !== "string" || src.length === 0 || src.length > UI_LIMITS.bytes) return undefined;
  const stack: Frame[] = [];
  let inStr = false;
  let esc = false;
  let strStart = -1;
  let strIsKey = false;
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    const top = stack[stack.length - 1];
    if (inStr) {
      if (esc) esc = false;
      else if (c === 92) esc = true;
      else if (c === 34) {
        inStr = false;
        if (top) top.at = strIsKey ? 1 : 3;
      }
      continue;
    }
    if (c === 34) {
      inStr = true;
      strStart = i;
      strIsKey = !!top && top.open === 123 && top.at === 0;
    } else if (c === 123) stack.push({ open: 123, at: 0 });
    else if (c === 91) stack.push({ open: 91, at: 2 });
    else if (c === 125 || c === 93) {
      stack.pop();
      const parent = stack[stack.length - 1];
      if (parent) parent.at = 3;
    } else if (c === 58) {
      if (top) top.at = 2;
    } else if (c === 44) {
      if (top) top.at = top.open === 123 ? 0 : 2;
    } else if (!isWs(c)) {
      if (top && top.at === 2) top.at = 4;
    } else if (top && top.at === 4) top.at = 3;
  }
  let out = src;
  let end = src.length;
  if (inStr) {
    if (strIsKey) {
      end = strStart;
      out = src.slice(0, end);
    } else {
      if (esc) out = out.slice(0, -1);
      else {
        // A \uXXXX escape still being typed: leave it out until its four digits arrive.
        const half = /(\\+)u[0-9a-fA-F]{0,3}$/.exec(out);
        const run = half?.[1] ?? "";
        if (half && run.length % 2 === 1) out = out.slice(0, half.index + run.length - 1);
      }
      out += '"';
      end = out.length;
    }
  }
  // Peel dangling tokens off the tail with index arithmetic only.
  for (let guard = 0; guard < 6; guard++) {
    while (end > 0 && isWs(out.charCodeAt(end - 1))) end--;
    const last = end > 0 ? out.charCodeAt(end - 1) : 0;
    if (last === 44) {
      end--;
      continue;
    }
    if (last === 58) {
      end--;
      while (end > 0 && isWs(out.charCodeAt(end - 1))) end--;
      if (end > 0 && out.charCodeAt(end - 1) === 34) {
        const s = stringStart(out, end);
        if (s >= 0) end = s;
      }
      continue;
    }
    if (last === 34) {
      const s = stringStart(out, end);
      if (s >= 0) {
        let k = s;
        while (k > 0 && isWs(out.charCodeAt(k - 1))) k--;
        const before = k > 0 ? out.charCodeAt(k - 1) : 0;
        const top = stack[stack.length - 1];
        if (top && top.open === 123 && (before === 123 || before === 44)) {
          end = s;
          continue;
        }
      }
      break;
    }
    if (last !== 93 && last !== 125 && last !== 123 && last !== 91) {
      let s = end;
      while (s > 0) {
        const c = out.charCodeAt(s - 1);
        if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 45 || c === 46) s--;
        else break;
      }
      if (s < end && !COMPLETE_TOKEN.test(out.slice(s, end))) {
        end = s;
        continue;
      }
    }
    break;
  }
  let res = out.slice(0, end);
  for (let i = stack.length - 1; i >= 0; i--) res += stack[i]?.open === 123 ? "}" : "]";
  try {
    return JSON.parse(res) as unknown;
  } catch {
    return undefined;
  }
}

// ── Reading a block ─────────────────────────────────────────────────────────

export interface UiBlockLine {
  /** 1-based line number inside the fence where the block starts, blank lines not counted. */
  line: number;
  /** Stable and unique within the fence: the line, plus an index when one line holds several blocks. */
  key: string;
  node: UiNode;
}

export interface ParsedUiBlock {
  meta: UiMeta;
  /** Finished top-level blocks, in order. */
  blocks: UiBlockLine[];
  /** The block still being typed (streaming only). */
  draft?: UiNode;
  /** The line number `draft` will have once it is finished, so a renderer can key it stably. */
  draftLine?: number;
  /** Lines that were not one JSON object. */
  badLines: number[];
  /** The fence is over the size limit; lines past it were not read. */
  truncated: boolean;
}

function readMeta(v: Record<string, unknown>): UiMeta {
  const meta: UiMeta = {};
  // {"title","state"}, and the common slip {"meta":{"title"}}.
  const nested = isRecord(v["meta"]) ? v["meta"] : {};
  const title = typeof v["title"] === "string" ? v["title"] : nested["title"];
  if (typeof title === "string") meta.title = title.slice(0, UI_LIMITS.shortStr);
  const state = isRecord(v["state"]) ? v["state"] : nested["state"];
  if (isRecord(state)) meta.state = { ...state };
  return meta;
}

/** The prop a component's shorthand string fills: {"text":"Hi"} is a text, {"swatch":"Red"} a labelled swatch. */
const SHORTHAND_STRING_PROP: Readonly<Record<string, string>> = { image: "src", citation: "label", progress: "label", swatch: "label", toggle: "label", slider: "label", input: "label" };

/**
 * Read the shapes models commonly write instead of {"type": ...}: a component
 * name as the only key ({"card":{...}}, {"text":"..."}, {"row":[...]},
 * {"list":[...]}), and list items given only `text`. Lenient in what we read,
 * strict in what the prompt asks for (Postel's law).
 */
export function normalizeUiNode(value: unknown, depth = 0): unknown {
  if (!isRecord(value) || depth > UI_LIMITS.depth) return value;
  let node: Record<string, unknown> = value;
  const keys = Object.keys(node);
  const only = keys.length === 1 ? keys[0] : undefined;
  if (typeof node["type"] !== "string" && only !== undefined && isUiComponent(only)) {
    const inner = node[only];
    if (isRecord(inner)) node = { ...inner, type: only };
    else if (Array.isArray(inner)) node = only === "list" ? { type: only, items: inner } : { type: only, children: inner };
    else if (typeof inner === "string") node = { type: only, [only === "image" && !/^https?:\/\//i.test(inner) ? "query" : SHORTHAND_STRING_PROP[only] ?? "text"]: inner };
    else if (only === "divider") node = { type: only };
  }
  // A container written without its type: {"title":"Day by day","children":[...]} is a card (a
  // stack when untitled) and {"title":"Tickets","items":[...]} a titled list. Read as the meta
  // line, either would silently lose everything inside it.
  if (typeof node["type"] !== "string" && !isRecord(node["ui"])) {
    const { state: _state, ...rest } = node;
    if (Array.isArray(rest["children"])) node = { ...rest, type: typeof rest["title"] === "string" ? "card" : "stack" };
    else if (Array.isArray(rest["items"])) {
      const { title, ...list } = rest;
      node = typeof title === "string" ? { type: "card", title, children: [{ ...list, type: "list" }] } : { ...list, type: "list" };
    }
  }
  const children = node["children"];
  if (Array.isArray(children)) node = { ...node, children: children.map((child: unknown) => normalizeUiNode(child, depth + 1)) };
  const items = node["items"];
  if (node["type"] === "list" && Array.isArray(items)) {
    node = {
      ...node,
      items: items.map((item: unknown) => {
        if (!isRecord(item)) return item;
        let out = item;
        if (out["title"] === undefined && typeof out["text"] === "string") {
          const { text, ...rest } = out;
          out = { ...rest, title: text };
        }
        const media = out["media"];
        if (isRecord(media)) return { ...out, media: normalizeUiNode(media, depth + 1) };
        if (Array.isArray(media)) return { ...out, media: media.map((m: unknown) => normalizeUiNode(m, depth + 1)) };
        return out;
      }),
    };
  }
  return node;
}

/** Open brackets minus closed ones, outside strings. Positive: the value goes on past this text. */
function bracketDepth(s: string): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (inStr) {
      if (esc) esc = false;
      else if (c === 92) esc = true;
      else if (c === 34) inStr = false;
      continue;
    }
    if (c === 34) inStr = true;
    else if (c === 123 || c === 91) depth++;
    else if (c === 125 || c === 93) depth--;
  }
  return depth;
}

/** JSON.parse that forgives a trailing comma between lines. */
function parseValue(s: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s.replace(/,\s*$/, "")) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Parse the text inside a ```ui fence. With `streaming`, the last line has no
 * terminator yet, so it is parsed leniently into `draft` instead of being
 * judged. One JSON object per line is the format; a value that runs over
 * several lines, a top-level array of blocks and the shorthand shapes in
 * normalizeUiNode are read too, so a model's formatting slip still draws.
 */
export function parseUiBlock(text: string, opts: { streaming?: boolean } = {}): ParsedUiBlock {
  const out: ParsedUiBlock = { meta: {}, blocks: [], badLines: [], truncated: false };
  let src = typeof text === "string" ? text.replace(/\r\n?/g, "\n") : "";
  if (src.length > UI_LIMITS.bytes) {
    src = src.slice(0, src.lastIndexOf("\n", UI_LIMITS.bytes) + 1);
    out.truncated = true;
  }
  const lines = src.split("\n");
  const tail = opts.streaming && !out.truncated ? lines.pop() : undefined;
  let lineNo = 0;
  let entries = 0;
  let pending = "";
  let pendingLine = 0;

  const bad = (line: number): void => {
    if (!out.badLines.includes(line)) out.badLines.push(line);
  };
  const take = (value: unknown, line: number): void => {
    entries++;
    const values = Array.isArray(value) ? value : [value];
    values.forEach((raw: unknown, index: number) => {
      const key = values.length > 1 ? `${line}.${index}` : `${line}`;
      const node = normalizeUiNode(raw);
      if (!isRecord(node)) {
        bad(line);
        return;
      }
      // A typeless container that also carries state: that state is the block's.
      if (isRecord(raw) && typeof raw["type"] !== "string" && typeof node["type"] === "string" && isRecord(raw["state"])) {
        out.meta = { ...out.meta, state: { ...(out.meta.state ?? {}), ...raw["state"] } };
      }
      if (typeof node["type"] === "string") {
        out.blocks.push({ line, key, node: node as UiNode });
        return;
      }
      // The whole-spec shape {"title","state","ui":{...}}: meta plus the root's children.
      const ui = node["ui"];
      if (isRecord(ui)) {
        out.meta = { ...out.meta, ...readMeta(node) };
        const root = normalizeUiNode(ui);
        const kids = isRecord(root) && root["type"] === "stack" && Array.isArray(root["children"]) ? (root["children"] as unknown[]) : [root];
        kids.forEach((kid: unknown, i: number) => {
          if (isRecord(kid) && typeof kid["type"] === "string") out.blocks.push({ line, key: `${key}.${i}`, node: kid as UiNode });
          else bad(line);
        });
        return;
      }
      if (entries === 1 && out.blocks.length === 0 && index === 0) {
        out.meta = readMeta(node);
        return;
      }
      bad(line);
    });
  };
  const fail = (line: number): void => {
    entries++;
    bad(line);
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    lineNo++;
    if (pending) {
      pending += `\n${line}`;
      if (bracketDepth(pending) > 0) continue;
      const parsed = parseValue(pending);
      if (parsed.ok) take(parsed.value, pendingLine);
      else fail(pendingLine);
      pending = "";
      continue;
    }
    const parsed = parseValue(line);
    if (parsed.ok) take(parsed.value, lineNo);
    else if ((line.startsWith("{") || line.startsWith("[")) && bracketDepth(line) > 0) {
      pending = line;
      pendingLine = lineNo;
    } else fail(lineNo);
  }

  const rest = tail?.trim() ?? "";
  const setDraft = (partial: string, line: number): void => {
    const draft = normalizeUiNode(parsePartialJson(partial));
    if (isRecord(draft) && typeof draft["type"] === "string") {
      out.draft = draft as UiNode;
      out.draftLine = line;
    } else if (entries === 0 && isRecord(draft) && !has(draft, "type")) out.meta = readMeta(draft);
  };
  if (pending) {
    const joined = rest ? `${pending}\n${rest}` : pending;
    if (opts.streaming && !out.truncated) setDraft(joined, pendingLine);
    else {
      const parsed = parseValue(joined);
      if (parsed.ok) take(parsed.value, pendingLine);
      else fail(pendingLine);
    }
  } else if (rest) setDraft(rest, lineNo + 1);
  return out;
}

export type ReplySegment = { kind: "markdown"; text: string } | { kind: "ui"; text: string; closed: boolean };

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const UI_OPENER_INFO = /^[ \t]*ui[ \t]*$/;
/** A last line that may still grow into a ```ui opener. */
const PARTIAL_OPENER = /^ {0,3}(`{1,}|~{1,})[ \t]*u?$/;

/**
 * Split a markdown reply into markdown and ```ui segments. A fence that is not
 * closed yet comes back with closed:false. Fences inside other fenced code
 * blocks are left alone. While `streaming`, a trailing line that may still
 * become a ```ui opener is held back so it never flashes as a code block.
 */
export function splitUiFences(markdown: string, opts: { streaming?: boolean } = {}): ReplySegment[] {
  const text = (typeof markdown === "string" ? markdown : "").replace(/\r\n?/g, "\n");
  if (!/^ {0,3}(?:`{3,}|~{3,})[ \t]*ui[ \t]*$/m.test(text)) {
    if (opts.streaming) {
      const cut = text.lastIndexOf("\n");
      if (PARTIAL_OPENER.test(text.slice(cut + 1)) && !insideFence(text.slice(0, cut + 1))) {
        const head = text.slice(0, cut + 1);
        return head.trim() ? [{ kind: "markdown", text: head }] : [];
      }
    }
    return [{ kind: "markdown", text }];
  }
  const lines = text.split("\n");
  const out: ReplySegment[] = [];
  let md: string[] = [];
  let ui: string[] | null = null;
  let uiFence = "";
  let otherFence = "";
  const flushMarkdown = (): void => {
    const chunk = md.join("\n");
    if (chunk.trim()) out.push({ kind: "markdown", text: chunk });
    md = [];
  };
  const closes = (line: string, fence: string): boolean => {
    const m = FENCE_LINE.exec(line);
    const run = m?.[1];
    return !!run && run[0] === fence[0] && run.length >= fence.length && !(m?.[2] ?? "").trim();
  };
  lines.forEach((line, index) => {
    if (ui) {
      if (closes(line, uiFence)) {
        out.push({ kind: "ui", text: ui.join("\n"), closed: true });
        ui = null;
      } else ui.push(line);
      return;
    }
    if (otherFence) {
      md.push(line);
      if (closes(line, otherFence)) otherFence = "";
      return;
    }
    if (opts.streaming && index === lines.length - 1 && PARTIAL_OPENER.test(line)) return;
    const m = FENCE_LINE.exec(line);
    if (m && UI_OPENER_INFO.test(m[2] ?? "")) {
      flushMarkdown();
      ui = [];
      uiFence = m[1] ?? "```";
      return;
    }
    if (m) otherFence = m[1] ?? "";
    md.push(line);
  });
  if (ui) out.push({ kind: "ui", text: (ui as string[]).join("\n"), closed: false });
  else flushMarkdown();
  return out;
}

/** True when `text` ends inside an unclosed fenced code block. */
function insideFence(text: string): boolean {
  let fence = "";
  for (const line of text.split("\n")) {
    const m = FENCE_LINE.exec(line);
    if (!m) continue;
    const run = m[1] ?? "";
    if (!fence) fence = run;
    else if (run[0] === fence[0] && run.length >= fence.length && !(m[2] ?? "").trim()) fence = "";
  }
  return !!fence;
}

// ── Expressions ─────────────────────────────────────────────────────────────

type Scalar = string | number | boolean | null | undefined;
export type UiValue = Scalar | Scalar[];

const hexRgb = (c: unknown): [number, number, number] => {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(typeof c === "string" ? c.trim() : "");
  const hex = m?.[1] ? (m[1].length === 3 ? [...m[1]].map((d) => d + d).join("") : m[1]) : "000000";
  const n = parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgbHex = (rgb: number[]): string => "#" + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
const digits = (d: unknown): number => Math.max(0, Math.min(6, Number.isFinite(Number(d)) ? Math.trunc(Number(d)) : 0));
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));
const unit01 = (v: unknown): number => Math.max(0, Math.min(1, num(v) || 0));

const FUNCTIONS: Readonly<Record<string, (...args: UiValue[]) => UiValue>> = Object.freeze({
  round: (n: UiValue, d: UiValue = 0) => {
    const k = 10 ** digits(d);
    return Math.round(num(n) * k) / k;
  },
  ceil: (n: UiValue) => Math.ceil(num(n)),
  floor: (n: UiValue) => Math.floor(num(n)),
  min: (...a: UiValue[]) => Math.min(...a.map(num)),
  max: (...a: UiValue[]) => Math.max(...a.map(num)),
  clamp: (n: UiValue, lo: UiValue, hi: UiValue) => Math.max(num(lo), Math.min(num(hi), num(n))),
  abs: (n: UiValue) => Math.abs(num(n)),
  // Growth and decay (compound interest, a loan payment). A non-finite result reads as no value.
  pow: (base: UiValue, exponent: UiValue) => {
    const v = num(base) ** num(exponent);
    return Number.isFinite(v) ? v : Number.NaN;
  },
  sqrt: (n: UiValue) => Math.sqrt(num(n)),
  mix: (a: UiValue, b: UiValue, t: UiValue) => {
    const from = hexRgb(a);
    const to = hexRgb(b);
    const k = unit01(t);
    return rgbHex(from.map((v, i) => v + ((to[i] ?? 0) - v) * k));
  },
  mute: (c: UiValue, amount: UiValue) => {
    const rgb = hexRgb(c);
    const grey = (rgb[0] + rgb[1] + rgb[2]) / 3;
    const k = unit01(amount);
    return rgbHex(rgb.map((v) => v + (grey - v) * k));
  },
  pct: (n: UiValue) => {
    const v = num(n);
    return Number.isFinite(v) ? `${Math.round(v)}%` : "";
  },
  fmt: (n: UiValue, d: UiValue = 2) => {
    const v = num(n);
    return Number.isFinite(v) ? v.toLocaleString("en-US", { minimumFractionDigits: digits(d), maximumFractionDigits: digits(d) }) : "";
  },
  concat: (...a: UiValue[]) => a.map(display).join("").slice(0, 2_000),
  lower: (s: UiValue) => display(s).toLowerCase(),
  upper: (s: UiValue) => display(s).toUpperCase(),
  len: (v: UiValue) => (Array.isArray(v) ? v.length : display(v).length),
});

export const UI_EXPR_FUNCTIONS = Object.keys(FUNCTIONS);

type Token = { num: number } | { str: string } | { id: string } | { op: string };

function tokenize(input: string): Token[] {
  const src = input.trim();
  if (src.length > UI_LIMITS.expr) throw new Error(`expression is longer than ${UI_LIMITS.expr} characters`);
  const re = /\s*(?:(\d+(?:\.\d+)?)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|([A-Za-z_][\w.]*)|(==|!=|>=|<=|&&|\|\||[-+*/%()<>!?:,]))/y;
  const out: Token[] = [];
  while (re.lastIndex < src.length) {
    const start = re.lastIndex;
    const m = re.exec(src);
    if (!m || re.lastIndex === start) break;
    if (m[1] !== undefined) out.push({ num: Number(m[1]) });
    else if (m[2] !== undefined) out.push({ str: m[2].slice(1, -1).replace(/\\(.)/g, "$1") });
    else if (m[3] !== undefined) out.push({ id: m[3] });
    else if (m[4] !== undefined) out.push({ op: m[4] });
  }
  const rest = src.slice(re.lastIndex).trim();
  if (rest) throw new Error(`unexpected character near "${rest.slice(0, 8)}"`);
  return out;
}

const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Text that is not a number. `+` joins it; numeric text (a choice or segmented value like "5") adds. */
const isWords = (v: UiValue): boolean => typeof v === "string" && v.trim() !== "" && !Number.isFinite(Number(v));

/** Loose equality without coercion surprises: a slider writes numbers, a segmented control strings. */
function looseEquals(a: UiValue, b: UiValue): boolean {
  if (isNil(a) || isNil(b)) return isNil(a) && isNil(b);
  if (typeof a === typeof b) return Array.isArray(a) || Array.isArray(b) ? display(a) === display(b) : a === b;
  return display(a) === display(b);
}

export interface EvalOptions {
  /** Check the syntax and report identifiers without evaluating. */
  dry?: boolean;
  onIdent?: (name: string) => void;
}

/**
 * Evaluate one expression against `scope`. No eval, no Function, own
 * properties only, bounded length and depth. Throws on syntax errors.
 */
export function evalUiExpr(src: string, scope: Readonly<Record<string, unknown>> = {}, opts: EvalOptions = {}): UiValue {
  const tokens = tokenize(src);
  let p = 0;
  let depth = 0;
  const isOp = (t: Token | undefined, op: string): boolean => !!t && "op" in t && t.op === op;
  const eat = (op: string): boolean => {
    if (!isOp(tokens[p], op)) return false;
    p++;
    return true;
  };
  const expect = (op: string): void => {
    if (!eat(op)) throw new Error(`expected "${op}"`);
  };
  const nested = <T>(fn: () => T): T => {
    if (++depth > UI_LIMITS.exprDepth) throw new Error("expression is nested too deeply");
    try {
      return fn();
    } finally {
      depth--;
    }
  };
  const lookup = (name: string): UiValue => {
    const parts = name.split(".");
    opts.onIdent?.(parts[0] ?? name);
    if (opts.dry) return 1;
    let cur: unknown = scope;
    for (const key of parts) {
      if (cur === null || typeof cur !== "object" || BLOCKED_KEYS.has(key) || !has(cur, key)) return undefined;
      cur = (cur as Record<string, unknown>)[key];
    }
    if (isNil(cur) || typeof cur === "string" || typeof cur === "number" || typeof cur === "boolean") return cur;
    if (Array.isArray(cur)) return cur.filter((x): x is Scalar => isNil(x) || ["string", "number", "boolean"].includes(typeof x));
    return undefined;
  };
  const primary = (): UiValue => {
    const t = tokens[p++];
    if (!t) throw new Error("unexpected end of expression");
    if ("num" in t) return t.num;
    if ("str" in t) return t.str;
    if ("id" in t) {
      if (t.id === "true") return true;
      if (t.id === "false") return false;
      if (t.id === "null") return null;
      if (!eat("(")) return lookup(t.id);
      return nested(() => {
        const args: UiValue[] = [];
        if (!eat(")")) {
          do args.push(ternary());
          while (eat(","));
          expect(")");
        }
        const fn = has(FUNCTIONS, t.id) ? FUNCTIONS[t.id] : undefined;
        if (!fn) throw new Error(`unknown function ${t.id}`);
        return opts.dry ? 1 : fn(...args);
      });
    }
    if (t.op === "(") {
      return nested(() => {
        const v = ternary();
        expect(")");
        return v;
      });
    }
    if (t.op === "-") return nested(() => -num(primary()));
    if (t.op === "!") return nested(() => !primary());
    throw new Error(`unexpected "${t.op}"`);
  };
  type Binary = (a: UiValue, b: UiValue) => UiValue;
  const level =
    (next: () => UiValue, ops: Record<string, Binary>) =>
    (): UiValue => {
      let left = next();
      for (;;) {
        const t = tokens[p];
        const op = t && "op" in t && has(ops, t.op) ? ops[t.op] : undefined;
        if (!op) return left;
        p++;
        left = op(left, next());
      }
    };
  const product = level(primary, { "*": (a, b) => num(a) * num(b), "/": (a, b) => num(a) / num(b), "%": (a, b) => num(a) % num(b) });
  const sum = level(product, {
    "+": (a, b) => (isWords(a) || isWords(b) ? display(a) + display(b) : num(a) + num(b)),
    "-": (a, b) => num(a) - num(b),
  });
  const compare = level(sum, {
    "<": (a, b) => num(a) < num(b),
    ">": (a, b) => num(a) > num(b),
    "<=": (a, b) => num(a) <= num(b),
    ">=": (a, b) => num(a) >= num(b),
  });
  const equality = level(compare, { "==": (a, b) => looseEquals(a, b), "!=": (a, b) => !looseEquals(a, b) });
  const and = level(equality, { "&&": (a, b) => a && b });
  const or = level(and, { "||": (a, b) => a || b });
  function ternary(): UiValue {
    return nested(() => {
      const cond = or();
      if (!eat("?")) return cond;
      const yes = ternary();
      expect(":");
      const no = ternary();
      return cond ? yes : no;
    });
  }
  const value = ternary();
  if (p < tokens.length) throw new Error("unexpected trailing input");
  return value;
}

type Segment = { lit: string } | { expr: string };

function exprSegments(s: string): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  while (i < s.length) {
    const a = s.indexOf("{{", i);
    if (a === -1) {
      out.push({ lit: s.slice(i) });
      break;
    }
    if (a > i) out.push({ lit: s.slice(i, a) });
    const b = s.indexOf("}}", a + 2);
    if (b === -1) {
      out.push({ lit: s.slice(a) });
      break;
    }
    out.push({ expr: s.slice(a + 2, b) });
    i = b + 2;
  }
  return out;
}

/** A value as text: no float noise (0.30000000000000004), arrays joined, nullish empty. */
export function display(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isFinite(v) ? String(Math.round(v * 1e6) / 1e6) : "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return v.map(display).join(", ");
  return "";
}

/**
 * Replace {{ expressions }} in a text prop. A prop that is exactly one
 * expression keeps its native type (a number, a colour). A broken expression
 * renders as empty, never as an error in the user's face.
 */
export function interpolate(value: unknown, scope: Readonly<Record<string, unknown>>): unknown {
  if (typeof value !== "string" || value.length > UI_LIMITS.str || !value.includes("{{")) return value;
  const segments = exprSegments(value);
  const safe = (e: string): UiValue => {
    try {
      return evalUiExpr(e, scope);
    } catch {
      return "";
    }
  };
  const only = segments.length === 1 ? segments[0] : undefined;
  if (only && "expr" in only) return safe(only.expr);
  return segments
    .map((s) => ("expr" in s ? display(safe(s.expr)) : s.lit))
    .join("")
    .slice(0, UI_LIMITS.str);
}

/** Evaluate a node's `show` condition. A condition that fails to evaluate shows the node. */
export function isShown(node: Readonly<Record<string, unknown>>, scope: Readonly<Record<string, unknown>>): boolean {
  const cond = node["show"];
  if (typeof cond !== "string" || !cond.trim()) return true;
  try {
    return !!evalUiExpr(cond.replace(/^\s*\{\{([\s\S]*)\}\}\s*$/, "$1"), scope);
  } catch {
    return true;
  }
}

// ── State ───────────────────────────────────────────────────────────────────

/** Children of a node in render order, including list media and badges. */
function nodeKids(n: Record<string, unknown>, path: string): { node: unknown; path: string }[] {
  const kids: { node: unknown; path: string }[] = [];
  const children = n["children"];
  if (Array.isArray(children)) children.forEach((c, i) => kids.push({ node: c, path: `${path} › children[${i}]` }));
  const items = n["items"];
  if (n["type"] === "list" && Array.isArray(items)) {
    items.forEach((it, i) => {
      if (!isRecord(it)) return;
      const media = it["media"];
      if (isRecord(media)) kids.push({ node: media, path: `${path} › items[${i}].media` });
      else if (Array.isArray(media)) media.forEach((m, j) => kids.push({ node: m, path: `${path} › items[${i}].media[${j}]` }));
      if (isRecord(it["badge"])) kids.push({ node: { type: "badge", ...it["badge"] }, path: `${path} › items[${i}].badge` });
    });
  }
  return kids;
}

/** Visit every component under `roots`, depth first, bounded by the depth and node limits. */
export function forEachUiNode(roots: readonly unknown[], visit: (node: UiNode, depth: number) => void): void {
  let count = 0;
  const walk = (node: unknown, depth: number): void => {
    if (!isRecord(node) || depth > UI_LIMITS.depth || ++count > UI_LIMITS.nodes * 2) return;
    if (typeof node["type"] === "string") visit(node as UiNode, depth);
    for (const k of nodeKids(node, "")) walk(k.node, depth + 1);
  };
  for (const root of roots) walk(root, 1);
}

/** Every name state can hold: meta.state keys plus every input's `name`. */
export function declaredNames(parsed: Pick<ParsedUiBlock, "meta" | "blocks">): Set<string> {
  const names = new Set<string>(Object.keys(parsed.meta.state ?? {}));
  forEachUiNode(
    parsed.blocks.map((b) => b.node),
    (node) => {
      if (UI_CATALOG[node.type]?.input && typeof node["name"] === "string") names.add(node["name"]);
      if (node.type === "list" && typeof node["check"] === "string") names.add(node["check"]);
    },
  );
  return names;
}

/** The key a checkable list row is ticked under: its id, else its title. */
export function listItemKey(item: unknown): string {
  if (typeof item === "string") return item;
  if (!isRecord(item)) return "";
  const id = item["id"];
  return typeof id === "string" || typeof id === "number" ? String(id) : display(item["title"]);
}

/**
 * Initial state: meta.state, then each input's own `value` for names the meta
 * line did not set. An input value that is an expression is read against
 * meta.state.
 */
export function initialUiState(parsed: Pick<ParsedUiBlock, "meta" | "blocks" | "draft">): Record<string, unknown> {
  const state: Record<string, unknown> = { ...(parsed.meta.state ?? {}) };
  const base = { ...state };
  const roots: unknown[] = parsed.blocks.map((b) => b.node);
  if (parsed.draft) roots.push(parsed.draft);
  forEachUiNode(roots, (node) => {
    const check = node["check"];
    if (node.type === "list" && typeof check === "string" && !BLOCKED_KEYS.has(check) && !has(state, check)) {
      const items = Array.isArray(node["items"]) ? (node["items"] as unknown[]) : [];
      state[check] = items.filter((it) => isRecord(it) && it["done"] === true).map(listItemKey);
      return;
    }
    const def = UI_CATALOG[node.type];
    const name = node["name"];
    if (!def?.input || typeof name !== "string" || BLOCKED_KEYS.has(name) || has(state, name)) return;
    const value = interpolate(node["value"], base);
    if (value !== undefined) state[name] = value;
    else if (node.type === "choice" && node["multiple"] === true) state[name] = [];
    else if (node.type === "toggle") state[name] = false;
    else if (node.type === "slider" && typeof node["min"] === "number") state[name] = node["min"];
  });
  return state;
}

/**
 * What a send button reports: every visible input in order, labelled by its
 * own label, else the title of the card it sits in, else its name. A
 * checklist reports the titles of its ticked rows.
 */
export function uiSendFields(roots: readonly unknown[], scope: Readonly<Record<string, unknown>>): { label: string; value: unknown; unit?: string }[] {
  const fields: { label: string; value: unknown; unit?: string }[] = [];
  const say = (v: unknown): string => display(interpolate(v, scope));
  const visit = (node: unknown, depth: number, within: string): void => {
    if (!isRecord(node) || depth > UI_LIMITS.depth || !isShown(node, scope)) return;
    const type = node["type"];
    const name = node["name"];
    if (typeof type === "string" && UI_CATALOG[type]?.input && typeof name === "string" && !BLOCKED_KEYS.has(name)) {
      const unit = type === "slider" ? say(node["unit"]) : "";
      fields.push({ label: say(node["label"]) || within || name, value: scope[name], ...(unit ? { unit } : {}) });
    }
    const check = node["check"];
    if (type === "list" && typeof check === "string" && !BLOCKED_KEYS.has(check) && Array.isArray(node["items"])) {
      const ticked = new Set(Array.isArray(scope[check]) ? (scope[check] as unknown[]).map(display) : []);
      const titles = (node["items"] as unknown[]).filter((item) => ticked.has(listItemKey(item))).map((item) => say(isRecord(item) ? item["title"] : item));
      fields.push({ label: say(node["label"]) || within || "Done", value: titles });
    }
    const title = type === "card" ? say(node["title"]) : "";
    const children = node["children"];
    if (Array.isArray(children)) for (const child of children) visit(child, depth + 1, title || within);
  };
  for (const root of roots) visit(root, 1, "");
  return fields;
}

/**
 * The visible message a "send" button posts: its own text, then one
 * "Label: value" line per filled input, in the order they appear.
 */
export function buildUiSendMessage(buttonText: string, fields: readonly { label: string; value: unknown; unit?: string }[]): string {
  const lines = [buttonText.trim()];
  for (const f of fields) {
    let value: string;
    if (typeof f.value === "boolean") value = f.value ? "Yes" : "No";
    else value = display(f.value).trim();
    if (!value) continue;
    if (f.unit) value += /^[%°]/.test(f.unit) ? f.unit : ` ${f.unit}`;
    lines.push(`${f.label.trim() || "Value"}: ${value}`);
  }
  return lines.join("\n");
}

// ── Validation ──────────────────────────────────────────────────────────────

function editDistance(a: string, b: string): number {
  const x = a.slice(0, 40);
  const y = b.slice(0, 40);
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[y.length] ?? 99;
}

function didYouMean(word: unknown, options: readonly string[]): string | null {
  let best: string | null = null;
  let bestDistance = 99;
  for (const option of options.slice(0, 60)) {
    const d = editDistance(String(word), option);
    if (d < bestDistance) {
      bestDistance = d;
      best = option;
    }
  }
  return bestDistance <= 3 ? best : null;
}

const typeMatches = (v: unknown, t: UiPropType): boolean => {
  if (t === "any") return true;
  if (t === "array") return Array.isArray(v);
  if (t === "object") return isRecord(v);
  if (typeof t !== "string") return (t as readonly unknown[]).includes(v);
  return typeof v === t;
};

type Report = (path: string, message: string, fix: string, level?: UiIssue["level"]) => void;

/**
 * Check one top-level block. Total: never throws. The renderer skips a block
 * with a "fatal" issue; the agent-side check reports every level.
 */
export function validateUiNode(root: unknown, rootPath: string, declared: ReadonlySet<string>): UiIssue[] {
  const issues: UiIssue[] = [];
  const report: Report = (path, message, fix, level = "fatal") => {
    if (issues.length < 40) issues.push({ path, message, fix, level });
  };
  const declaredList = (): string => [...declared].slice(0, 12).join(", ") || "(none)";
  const checkExpr = (path: string, where: string, e: string): void => {
    try {
      evalUiExpr(e, {}, {
        dry: true,
        onIdent: (name) => {
          if (declared.has(name)) return;
          const dm = didYouMean(name, [...declared]);
          report(
            path,
            `${where} uses "${trunc(name)}" but no state or input has that name`,
            dm ? `did you mean "${dm}"? declared: ${declaredList()}` : `declare it in the first line's "state". declared: ${declaredList()}`,
            "reference",
          );
        },
      });
    } catch (x) {
      report(path, `expression in ${where} is not valid: ${trunc(x instanceof Error ? x.message : x, 80)}`, `allowed: state names, numbers, 'strings', + - * / % < > <= >= == != && || ! ?: and ${UI_EXPR_FUNCTIONS.join(", ")}`);
    }
  };

  let count = 0;
  const ids = new Set<string>();
  const stack: { node: unknown; path: string; depth: number }[] = [{ node: root, path: rootPath, depth: 1 }];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) break;
    const { node: n, path, depth } = cur;
    if (++count > UI_LIMITS.nodes) {
      report(rootPath, `more than ${UI_LIMITS.nodes} components in one block`, "split the content or cut it");
      break;
    }
    if (depth > UI_LIMITS.depth) {
      report(path, `nesting is deeper than ${UI_LIMITS.depth}`, "flatten the layout");
      continue;
    }
    if (!isRecord(n)) {
      report(path, "every component must be a JSON object", 'use {"type": "...", ...}');
      continue;
    }
    const type = n["type"];
    if (!isUiComponent(type)) {
      const dm = typeof type === "string" ? didYouMean(type, Object.keys(UI_CATALOG)) : null;
      report(path, `unknown component type "${trunc(type)}"`, dm ? `did you mean "${dm}"?` : `known: ${Object.keys(UI_CATALOG).join(", ")}`);
      continue;
    }
    const def = UI_CATALOG[type];
    if (!def) continue;
    if (n["children"] !== undefined && !def.kids) report(path, `${type} cannot have children`, "wrap them in a stack, row or card", "prop");
    if (def.kids && n["children"] !== undefined && !Array.isArray(n["children"])) report(path, "children must be an array", 'use "children": [ ... ]', "prop");
    for (const key of Object.keys(n)) {
      if (key === "type" || key === "children") continue;
      const v = n[key];
      const want = has(def.props, key) ? def.props[key] : has(COMMON_PROPS, key) ? COMMON_PROPS[key] : undefined;
      if (want === undefined) {
        const dm = didYouMean(key, Object.keys(def.props));
        report(path, `${type} has no prop "${trunc(key)}"`, dm ? `did you mean "${dm}"?` : `allowed: ${[...Object.keys(def.props), ...Object.keys(COMMON_PROPS)].join(", ")}`, "prop");
        continue;
      }
      if (typeof v === "string") {
        const max = key === "text" || key === "value" ? UI_LIMITS.str : URL_PROPS.has(key) ? 2_000 : UI_LIMITS.shortStr;
        if (v.length > max) report(path, `${type}.${key} is ${v.length} characters, over ${max}`, "shorten it", "prop");
        if (key === "show") {
          // isShown reads the whole string as ONE expression (optionally wrapped in {{ }}).
          const inner = /^\s*\{\{([\s\S]*)\}\}\s*$/.exec(v)?.[1];
          if (v.includes("{{") && (inner === undefined || inner.includes("{{") || inner.includes("}}"))) {
            report(path, `${type}.show must be one expression`, `write it without braces, e.g. "show":"mode == 'muted'"`, "prop");
          } else checkExpr(path, `${type}.show`, inner ?? v);
          continue;
        }
        if (v.includes("{{")) {
          if (!EXPR_PROPS.has(key)) {
            report(path, `${type}.${key} cannot contain an expression`, "enums, URLs, names and types must be literal values", type === "image" && key === "src" ? "fatal" : "prop");
            continue;
          }
          for (const s of exprSegments(v)) if ("expr" in s) checkExpr(path, `${type}.${key}`, s.expr);
          continue;
        }
        if (URL_PROPS.has(key) && !isSafeUrl(v)) report(path, `${type}.${key} must be an https URL`, "only https links and images are allowed", type === "image" && key === "src" ? "fatal" : "prop");
        if (key === "color" && !isSafeColor(v)) report(path, `swatch.color "${trunc(v, 20)}" is not a colour`, 'use a hex colour like "#3b82f6", rgb(...) or hsl(...)', "prop");
        if (key === "name" && BLOCKED_KEYS.has(v)) report(path, `"${v}" cannot be a name`, "pick another name", "prop");
      }
      if (!typeMatches(v, want)) {
        report(path, `${type}.${key} should be ${typeof want === "string" ? want : `one of ${(want as readonly unknown[]).join("|")}`}`, `got ${trunc(JSON.stringify(v))}`, STRUCTURAL_PROPS.has(`${type}.${key}`) ? "fatal" : "prop");
      }
    }
    for (const r of def.required ?? []) if (n[r] === undefined) report(path, `${type} needs "${r}"`, `add ${r}`);
    if (type === "image" && n["src"] === undefined && n["query"] === undefined) report(path, 'image needs "query" or "src"', 'add "query": a few words naming what to show');
    if (type === "image" && typeof n["query"] === "string" && n["query"].trim().length < 2) report(path, "image.query is empty", "name what to show in a few words");
    const id = n["id"];
    if (typeof id === "string") {
      if (ids.has(id)) report(path, `duplicate id "${trunc(id)}"`, "ids must be unique", "prop");
      ids.add(id);
    }
    checkShape(n, type, path, report, declared, (where, text) => {
      if (typeof text !== "string" || !text.includes("{{")) return;
      for (const s of exprSegments(text)) if ("expr" in s) checkExpr(path, where, s.expr);
    });
    const kids = nodeKids(n, path);
    for (let i = kids.length - 1; i >= 0; i--) {
      const k = kids[i];
      if (k) stack.push({ node: k.node, path: k.path, depth: depth + 1 });
    }
  }
  return issues;
}

export interface DrawableUiLine {
  /** What the chat can draw of the line; null when nothing is left. */
  node: UiNode | null;
  /** Components (and list rows) left out because they could not be drawn. */
  dropped: number;
}

/** Props an unknown leaf component is read from when it degrades to text. */
const DEGRADE_TEXT_KEYS = ["title", "text", "label", "value", "caption", "sub"];
const without = (o: Record<string, unknown>, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));

/**
 * The part of one block line the chat can draw. A component with a problem of
 * its own that stops it drawing is left out while its parent and siblings stay,
 * so one bad stat no longer blanks a whole card. A component type this renderer
 * does not know (an agent ahead of the chat, or a made-up name) degrades
 * instead: a container keeps its children in a stack, a leaf with text becomes
 * text. A plain string where a component belongs becomes text too. The answer
 * check still reports every problem to the agent.
 */
export function drawableUiLine(line: unknown, path: string, declared: ReadonlySet<string>): DrawableUiLine {
  const issues = validateUiNode(line, path, declared);
  // Too big or too deep to walk safely: the whole line goes.
  if (issues.some((i) => i.level === "fatal" && i.path === path && /^more than \d+ components/.test(i.message))) return { node: null, dropped: 1 };
  const fatal = new Set(issues.filter((i) => i.level === "fatal").map((i) => i.path));
  let dropped = 0;
  const visit = (node: unknown, at: string, depth: number): UiNode | null => {
    if (typeof node === "string") return node.trim() ? { type: "text", text: node } : null;
    if (!isRecord(node) || depth > UI_LIMITS.depth) {
      dropped++;
      return null;
    }
    if (!isUiComponent(node["type"])) {
      const children = node["children"];
      if (Array.isArray(children)) {
        const kids = children.flatMap((child: unknown, i: number) => {
          const sub = drawableUiLine(child, `${at} › children[${i}]`, declared);
          dropped += sub.dropped;
          return sub.node ? [sub.node] : [];
        });
        return kids.length > 0 ? { type: "stack", children: kids } : null;
      }
      const words = DEGRADE_TEXT_KEYS.map((k) => node[k])
        .filter((v): v is string | number => typeof v === "string" || typeof v === "number")
        .map((v) => String(v).trim())
        .filter(Boolean);
      if (words.length > 0) return { type: "text", text: words.join(" · ") };
      dropped++;
      return null;
    }
    if (fatal.has(at)) {
      dropped++;
      return null;
    }
    const out: UiNode = { ...node, type: node["type"] };
    const children = node["children"];
    if (Array.isArray(children)) {
      out["children"] = children.flatMap((child: unknown, i: number) => {
        const kid = visit(child, `${at} › children[${i}]`, depth + 1);
        return kid ? [kid] : [];
      });
    }
    const items = node["items"];
    if (node["type"] === "list" && Array.isArray(items)) {
      out["items"] = items.flatMap((item: unknown, i: number) => {
        const itemAt = `${at} › items[${i}]`;
        if (fatal.has(itemAt)) {
          dropped++;
          return [];
        }
        if (!isRecord(item)) return [item];
        let kept: Record<string, unknown> = item;
        const media = kept["media"];
        if (fatal.has(`${itemAt}.media`)) {
          kept = without(kept, "media");
        } else if (Array.isArray(media)) {
          kept = { ...kept, media: media.filter((_m: unknown, j: number) => !fatal.has(`${itemAt}.media[${j}]`)) };
        }
        if (fatal.has(`${itemAt}.badge`)) kept = without(kept, "badge");
        return [kept];
      });
    }
    return out;
  };
  return { node: visit(line, path, 1), dropped };
}

/** Checks the {{ }} expressions inside a string that is not itself a prop (a table cell, a list field, a set value). */
type TextCheck = (where: string, text: unknown) => void;

function checkShape(n: Record<string, unknown>, type: string, path: string, report: Report, declared: ReadonlySet<string>, checkText: TextCheck): void {
  const isStr = (x: unknown): x is string => typeof x === "string";
  const isCell = (x: unknown): boolean => typeof x === "string" || typeof x === "number" || typeof x === "boolean";
  const iconName = (where: string, v: unknown): void => {
    if (v !== undefined && !(typeof v === "string" && ICON_SET.has(v))) report(path, `${where} "${trunc(v)}" is not an icon`, `use one of: ${UI_ICONS.slice(0, 24).join(", ")}, ...`, "prop");
  };
  if (type === "icon") iconName("icon.name", n["name"]);
  if (type === "card" || type === "callout") iconName(`${type}.icon`, n["icon"]);
  if (type === "card" && n["badge"] !== undefined && (!isRecord(n["badge"]) || !isStr(n["badge"]["text"]))) report(path, "card.badge must be {text, tone?}", 'e.g. {"text":"Week 43","tone":"accent"}', "prop");
  if (type === "card" && isRecord(n["badge"])) checkText("card.badge.text", n["badge"]["text"]);
  if (type === "timeline") {
    const groups = n["groups"];
    const lists: { at: string; items: unknown }[] = Array.isArray(groups)
      ? groups.slice(0, 14).map((g: unknown, i: number) => ({ at: `groups[${i}].items`, items: isRecord(g) ? g["items"] : undefined }))
      : Array.isArray(n["items"])
        ? [{ at: "items", items: n["items"] }]
        : [];
    if (lists.length === 0) report(path, "timeline needs items or groups", 'items: [{"time":"09:00","title":"Planning"}]');
    for (const { at, items } of lists) {
      if (!Array.isArray(items)) {
        report(path, `timeline.${at} must be an array`, 'items: [{"time":"09:00","title":"Planning"}]', "prop");
        continue;
      }
      items.slice(0, 60).forEach((it: unknown, i: number) => {
        if (!isRecord(it) || !isStr(it["title"])) {
          report(path, `timeline.${at}[${i}] needs a title`, 'e.g. {"time":"09:00","title":"Planning","sub":"09:00-10:00"}', "prop");
          return;
        }
        for (const k of Object.keys(it)) if (!TIMELINE_ITEM_KEYS.includes(k)) report(path, `timeline.${at}[${i}] has no key "${trunc(k)}"`, `allowed: ${TIMELINE_ITEM_KEYS.join(", ")}`, "prop");
        if (it["tone"] !== undefined && !(UI_TONES as readonly unknown[]).includes(it["tone"])) report(path, `timeline.${at}[${i}].tone should be one of ${UI_TONES.join("|")}`, "use a tone name", "prop");
        if (it["icon"] !== undefined) iconName(`timeline.${at}[${i}].icon`, it["icon"]);
        for (const k of ["time", "title", "sub"]) checkText(`timeline.${at}[${i}].${k}`, it[k]);
      });
    }
  }
  if (type === "stat" && n["value"] !== undefined && typeof n["value"] !== "string" && typeof n["value"] !== "number") {
    report(path, "stat.value must be a number or a short text", 'e.g. "value":"27" or "value":"{{ fmt(total, 0) }}"');
  }
  const rows = n["rows"];
  const columns = n["columns"];
  if (type === "table" && Array.isArray(rows) && Array.isArray(columns)) {
    if (!columns.every(isStr)) report(path, "table.columns must be an array of strings", 'e.g. ["Name","Price"]', "prop");
    columns.forEach((c: unknown, i: number) => checkText(`table.columns[${i}]`, c));
    rows.slice(0, 200).forEach((r: unknown, i: number) => {
      if (!Array.isArray(r)) report(path, `table.rows[${i}] must be an array of cells, got ${typeof r}`, 'rows is an array of arrays: [["a","b"],["c","d"]]', "prop");
      else if (r.length !== columns.length) report(path, `table.rows[${i}] has ${r.length} cells but there are ${columns.length} columns`, "make every row as long as columns", "prop");
      else if (!r.every(isCell)) report(path, `table.rows[${i}] has a cell that is not text or a number`, "cells are strings or numbers", "prop");
      else r.forEach((cell: unknown, j: number) => checkText(`table.rows[${i}][${j}]`, cell));
    });
  }
  const items = n["items"];
  if (type === "list" && Array.isArray(items)) {
    items.slice(0, 200).forEach((it: unknown, i: number) => {
      if (isStr(it)) return;
      // Item problems sit on the item, so the chat drops that row, not the list.
      const at = `${path} › items[${i}]`;
      if (!isRecord(it)) {
        report(at, `list.items[${i}] must be a string or an object`, `object keys: ${LIST_ITEM_KEYS.join(", ")}`);
        return;
      }
      for (const k of Object.keys(it)) if (!LIST_ITEM_KEYS.includes(k)) report(at, `list.items[${i}] has no key "${trunc(k)}"`, `allowed: ${LIST_ITEM_KEYS.join(", ")}`, "prop");
      if (it["title"] === undefined) report(at, `list.items[${i}] needs "title"`, "add title");
      for (const k of ["title", "meta", "sub", "text"]) {
        if (it[k] !== undefined && !isStr(it[k])) report(at, `list.items[${i}].${k} must be a string`, "use text", "prop");
        else checkText(`list.items[${i}].${k}`, it[k]);
      }
      const facts = it["facts"];
      if (facts !== undefined) {
        if (!Array.isArray(facts) || facts.length > 6) report(at, `list.items[${i}].facts must be an array of up to 6 {icon, text}`, 'facts: [{"icon":"calendar","text":"Wed, Oct 21"}]', "prop");
        else
          facts.forEach((f: unknown, j: number) => {
            if (isStr(f)) return checkText(`list.items[${i}].facts[${j}]`, f);
            if (!isRecord(f) || !isStr(f["text"])) return report(at, `list.items[${i}].facts[${j}] must be text or {icon, text}`, 'e.g. {"icon":"clock","text":"4h"}', "prop");
            if (f["icon"] !== undefined) iconName(`list.items[${i}].facts[${j}].icon`, f["icon"]);
            checkText(`list.items[${i}].facts[${j}].text`, f["text"]);
          });
      }
      const badge = it["badge"];
      if (badge !== undefined && (!isRecord(badge) || !isStr(badge["text"]))) report(`${at}.badge`, `list.items[${i}].badge must be {text, tone?}`, 'e.g. {"text":"Recommended","tone":"positive"}');
      const media = it["media"];
      if (Array.isArray(media)) {
        if (media.length === 0 || media.length > 6 || !media.every((m: unknown) => isRecord(m) && m["type"] === "swatch")) {
          report(`${at}.media`, `list.items[${i}].media as an array must hold 1-6 swatches`, 'media: [{"type":"swatch","color":"#2563eb","label":"Blue"}, ...]');
        }
      } else if (media !== undefined && !(isRecord(media) && (media["type"] === "image" || media["type"] === "swatch" || media["type"] === "icon"))) {
        report(`${at}.media`, `list.items[${i}].media must be an icon, image or swatch component`, 'media: {"type":"icon","name":"target","tone":"positive"}');
      }
    });
  }
  const options = n["options"];
  if ((type === "choice" || type === "segmented" || type === "select") && Array.isArray(options)) {
    if (!options.every(isStr)) report(path, `${type}.options must be an array of strings`, 'e.g. ["Small","Large"]', "prop");
    if (options.length < 2) report(path, `${type} needs at least 2 options`, "use a toggle for yes/no", "prop");
    if (options.length > 12) report(path, `${type} has ${options.length} options`, "offer at most 5 and put the rest in prose", "prop");
  }
  const action = n["do"];
  if (type === "button" && action !== undefined) {
    const set = isRecord(action) ? action["set"] : undefined;
    if (action !== "send" && action !== "reset" && !isRecord(set)) report(path, 'button.do must be "send", "reset" or {"set": {...}}', `got ${trunc(JSON.stringify(action))}`, "prop");
    if (isRecord(set)) {
      for (const [k, v] of Object.entries(set)) {
        if (!declared.has(k)) report(path, `button sets "${trunc(k)}" but no state or input has that name`, `declared: ${[...declared].slice(0, 12).join(", ") || "(none)"}`, "reference");
        if (v !== null && typeof v === "object") report(path, `button.do.set.${trunc(k)} must be a plain value`, "numbers, strings or booleans only", "prop");
        else checkText(`button.do.set.${trunc(k)}`, v);
      }
    }
  }
  const min = n["min"];
  const max = n["max"];
  if (type === "slider" && typeof min === "number" && typeof max === "number" && min >= max) report(path, "slider.min must be less than max", "swap them");
}

/**
 * Design rules the agent must follow that a renderer can still draw. Only
 * rules with no false positives belong here: each costs the user a retry.
 */
function checkDesign(parsed: ParsedUiBlock, report: Report): void {
  const inputTypes = new Map<string, string>();
  const visitGroup = (children: unknown, path: string): void => {
    if (!Array.isArray(children)) return;
    const primaries = children.filter((c) => isRecord(c) && c["type"] === "button" && c["kind"] === "primary").length;
    if (primaries > 1) report(path, `${primaries} primary buttons in one group`, "keep exactly one primary action (Hick's law); make the others secondary or link", "ux");
  };
  visitGroup(
    parsed.blocks.map((b) => b.node),
    "block",
  );
  for (const { line, node } of parsed.blocks) {
    forEachUiNode([node], (n) => {
      const path = `line ${line}`;
      visitGroup(n["children"], `${path} › ${n.type}`);
      const name = n["name"];
      if (UI_CATALOG[n.type]?.input && typeof name === "string") {
        const seen = inputTypes.get(name);
        if (seen && seen !== n.type) report(path, `two different inputs are both named "${trunc(name)}"`, "give every input its own name", "ux");
        inputTypes.set(name, n.type);
      }
      const rows = n["rows"];
      if (n.type === "table" && Array.isArray(rows) && rows.length === 0 && typeof n["empty"] !== "string") {
        report(path, "table has no rows and no empty message", 'add "empty": "<why there is nothing and what to do next>"', "ux");
      }
      const items = n["items"];
      if (n.type === "list" && Array.isArray(items) && items.length === 0) report(path, "list has no items", "say in text why it is empty, or leave the list out", "ux");
      const options = n["options"];
      if (n.type === "choice" && Array.isArray(options) && options.length > 7 && typeof n["recommended"] !== "string") {
        report(path, `choice has ${options.length} options and none is recommended`, "offer at most 5, or mark the recommended one (choice overload)", "ux");
      }
    });
  }
}

export interface UiBlockCheck {
  parsed: ParsedUiBlock;
  issues: UiIssue[];
}

/** Parse and check a whole fence, every issue level. Used by the agent-side answer check. */
export function checkUiBlock(text: string): UiBlockCheck {
  const parsed = parseUiBlock(text);
  const issues: UiIssue[] = [];
  const report: Report = (path, message, fix, level = "fatal") => {
    if (issues.length < 40) issues.push({ path, message, fix, level });
  };
  if (parsed.truncated) report("block", `is over ${UI_LIMITS.bytes} characters`, "split it or cut content");
  for (const line of parsed.badLines) report(`line ${line}`, "is not one JSON object", "write exactly one JSON object per line and keep each top-level block on a single line");
  if (parsed.blocks.length === 0 && parsed.badLines.length === 0) report("block", "has no components", 'add at least one line like {"type":"text","text":"..."}');
  const declared = declaredNames(parsed);
  for (const b of parsed.blocks) issues.push(...validateUiNode(b.node, `line ${b.line}`, declared));
  checkDesign(parsed, report);
  return { parsed, issues: issues.slice(0, 40) };
}

/** Every ```ui fence in a finished reply, in order, with whether it was closed. */
export function findUiBlocks(markdown: string): { text: string; closed: boolean }[] {
  return splitUiFences(markdown).flatMap((s) => (s.kind === "ui" ? [{ text: s.text, closed: s.closed }] : []));
}

/**
 * A reply with each ```ui block turned into readable plain text, for places
 * that cannot draw one (notification previews, copy to clipboard): the title,
 * headings, text, list and table rows, options and values at their initial
 * state, and sources. Buttons and pure decoration are left out.
 */
export function uiFencesAsText(markdown: string): string {
  return splitUiFences(markdown)
    .map((segment) => (segment.kind === "markdown" ? segment.text.trim() : uiBlockAsText(segment.text)))
    .filter(Boolean)
    .join("\n\n");
}

/** One ```ui block's content as readable plain text (see uiFencesAsText). */
export function uiBlockAsText(text: string): string {
  const parsed = parseUiBlock(text);
  const scope = initialUiState(parsed);
  const say = (v: unknown): string => display(interpolate(v, scope)).trim();
  const lines: string[] = [];
  const push = (...parts: string[]): void => {
    const line = parts.filter(Boolean).join(" ");
    if (line) lines.push(line);
  };
  if (parsed.meta.title) push(parsed.meta.title);
  forEachUiNode(
    parsed.blocks.map((b) => b.node),
    (n) => {
      const label = say(n["label"]);
      switch (n.type) {
        case "card":
        case "disclosure":
          push(say(n["title"]), isRecord(n["badge"]) ? `(${say(n["badge"]["text"])})` : say(n["aside"]));
          push(say(n["sub"]));
          break;
        case "stat":
          push(`${say(n["label"])}: ${say(n["value"])}`, say(n["note"]) ? `(${say(n["note"])})` : "");
          break;
        case "timeline": {
          const groups = Array.isArray(n["groups"]) ? (n["groups"] as unknown[]) : [{ items: n["items"] }];
          for (const g of groups) {
            if (!isRecord(g)) continue;
            const head = [say(g["label"]), say(g["value"])].filter(Boolean).join(" ");
            if (head) push(head);
            for (const it of Array.isArray(g["items"]) ? (g["items"] as unknown[]) : []) {
              if (isRecord(it)) push(`- ${[say(it["time"]), say(it["title"])].filter(Boolean).join(" ")}${say(it["sub"]) ? `: ${say(it["sub"])}` : ""}`);
            }
          }
          break;
        }
        case "heading":
        case "text":
          push(say(n["text"]));
          break;
        case "callout":
          push(say(n["title"]), say(n["text"]));
          break;
        case "progress":
          push(label);
          break;
        case "citation":
          push(label ? `Source: ${label}` : "");
          break;
        case "list":
          for (const item of Array.isArray(n["items"]) ? (n["items"] as unknown[]) : []) {
            if (typeof item === "string") push(`- ${say(item)}`);
            else if (isRecord(item)) {
              const badge = isRecord(item["badge"]) ? say(item["badge"]["text"]) : "";
              const sub = say(item["sub"]);
              const meta = say(item["meta"]);
              const facts = Array.isArray(item["facts"]) ? (item["facts"] as unknown[]).map((f) => (isRecord(f) ? say(f["text"]) : say(f))).filter(Boolean) : [];
              const checked = typeof n["check"] === "string" && Array.isArray(scope[n["check"]]) && (scope[n["check"]] as unknown[]).map(display).includes(listItemKey(item));
              push(`- ${checked ? "[x] " : typeof n["check"] === "string" ? "[ ] " : ""}${meta ? `${meta} ` : ""}${say(item["title"])}${badge ? ` (${badge})` : ""}${sub ? `: ${sub}` : ""}${facts.length ? ` · ${facts.join(" · ")}` : ""}`, say(item["text"]));
            }
          }
          break;
        case "table": {
          const columns = Array.isArray(n["columns"]) ? (n["columns"] as unknown[]).map(say) : [];
          if (columns.length) push(columns.join(" | "));
          for (const row of Array.isArray(n["rows"]) ? (n["rows"] as unknown[]) : []) {
            if (Array.isArray(row)) push(row.map(say).join(" | "));
          }
          break;
        }
        case "choice":
        case "segmented":
        case "select":
          push(`${label || say(n["name"])}:`, (Array.isArray(n["options"]) ? (n["options"] as unknown[]).map(say) : []).join(" / "));
          break;
        case "slider":
        case "input":
        case "toggle": {
          const name = n["name"];
          const value = typeof name === "string" ? scope[name] : undefined;
          push(`${label}:`, typeof value === "boolean" ? (value ? "Yes" : "No") : display(value), n.type === "slider" ? say(n["unit"]) : "");
          break;
        }
        default:
          break;
      }
    },
  );
  return lines.join("\n").replace(/\*\*([^*\n]+)\*\*/g, "$1");
}

// ── Agent-facing catalog ────────────────────────────────────────────────────

/** One line per component, generated from UI_CATALOG so the prompt cannot drift from the validator. */
export function describeUiCatalog(): string {
  return Object.entries(UI_CATALOG)
    .map(([name, d]) => {
      const props = Object.entries(d.props)
        .map(([k, v]) => `${k}${(d.required ?? []).includes(k) ? "*" : ""}:${typeof v === "string" ? v : (v as readonly unknown[]).join("|")}`)
        .join(", ");
      return `- ${name}${d.kids ? " [children]" : ""}${d.input ? " [input]" : ""}: ${d.doc}${d.hint ? ` ${d.hint}` : ""} Props: ${props || "(none)"}`;
    })
    .join("\n");
}
