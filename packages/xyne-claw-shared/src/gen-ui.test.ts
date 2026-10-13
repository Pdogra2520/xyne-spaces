import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  UI_CATALOG,
  UI_ICONS,
  buildUiSendMessage,
  checkUiBlock,
  declaredNames,
  describeUiCatalog,
  display,
  drawableUiLine,
  evalUiExpr,
  findUiBlocks,
  initialUiState,
  interpolate,
  isSafeColor,
  isSafeUrl,
  isShown,
  listItemKey,
  normalizeUiNode,
  parsePartialJson,
  parseUiBlock,
  splitUiFences,
  uiFencesAsText,
  uiSendFields,
  validateUiNode,
} from "./gen-ui.js";

const lines = (...rows: unknown[]): string => rows.map((r) => JSON.stringify(r)).join("\n");

describe("parsePartialJson", () => {
  it("closes an object whose string is still being typed", () => {
    expect(parsePartialJson('{"type":"text","text":"Hel')).toEqual({ type: "text", text: "Hel" });
  });

  it("holds back a \\u escape until its four digits arrive", () => {
    for (const tail of ["\\u", "\\u0", "\\u00", "\\u00e"]) expect(parsePartialJson(`{"type":"text","text":"caf${tail}`), tail).toEqual({ type: "text", text: "caf" });
    expect(parsePartialJson('{"type":"text","text":"caf\\u00e9')).toEqual({ type: "text", text: "café" });
    // An escaped backslash followed by "u00" is plain text, not an escape.
    expect(parsePartialJson('{"text":"a\\\\u00')).toEqual({ text: "a\\u00" });
  });

  it("drops a key that has no value yet", () => {
    expect(parsePartialJson('{"type":"card","title":"A","tone"')).toEqual({ type: "card", title: "A" });
    expect(parsePartialJson('{"type":"card","title":"A","tone":')).toEqual({ type: "card", title: "A" });
  });

  it("drops a half-typed literal but keeps complete numbers", () => {
    expect(parsePartialJson('{"type":"slider","min":0,"open":tr')).toEqual({ type: "slider", min: 0 });
    expect(parsePartialJson('{"type":"slider","min":10')).toEqual({ type: "slider", min: 10 });
  });

  it("closes nested arrays", () => {
    expect(parsePartialJson('{"type":"stack","children":[{"type":"text","text":"a"},{"type":"te')).toEqual({
      type: "stack",
      children: [{ type: "text", text: "a" }, { type: "te" }],
    });
  });

  it("returns undefined for nothing usable", () => {
    expect(parsePartialJson("")).toBeUndefined();
    expect(parsePartialJson("nonsense")).toBeUndefined();
  });
});

describe("parseUiBlock", () => {
  const text = lines({ title: "Pick", state: { slot: "Tue" } }, { type: "text", text: "Hi" }, { type: "divider" });

  it("reads the meta line and one block per line", () => {
    const parsed = parseUiBlock(text);
    expect(parsed.meta).toEqual({ title: "Pick", state: { slot: "Tue" } });
    expect(parsed.blocks.map((b) => b.node.type)).toEqual(["text", "divider"]);
    expect(parsed.blocks.map((b) => b.line)).toEqual([2, 3]);
    expect(parsed.badLines).toEqual([]);
  });

  it("treats the unterminated last line as a draft while streaming", () => {
    const parsed = parseUiBlock(`${lines({ type: "text", text: "Hi" })}\n{"type":"callout","text":"Wa`, { streaming: true });
    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.draft).toEqual({ type: "callout", text: "Wa" });
  });

  it("judges the last line once the fence is complete", () => {
    const parsed = parseUiBlock(`${lines({ type: "text", text: "Hi" })}\n{"type":"callout","text":"Wa`);
    expect(parsed.draft).toBeUndefined();
    expect(parsed.badLines).toEqual([2]);
  });

  it("reports lines that are not one JSON object", () => {
    expect(parseUiBlock('{"type":"text","text":"a"} trailing\n[1,2]\n{"type":"divider"}').badLines).toEqual([1, 2]);
  });

  it("reads the shapes models write instead of the format", () => {
    // A real reply from a run that never got the format instructions.
    const block = [
      '{"state":{},"meta":{"title":"Ultramarine vs Phthalo"}}',
      '{"grid":{"cols":2,"children":[',
      '  {"card":{"title":"Ultramarine blue","children":[',
      '     {"row":{"gap":"sm","children":[',
      '        {"swatch":{"color":"#120a8f","label":"Ultramarine pure"}},',
      '        {"swatch":{"color":"#7a7a3a","label":"+ yellow (olive)"}}',
      "     ]}},",
      '     {"list":[',
      '        {"text":"Warm, leans red / violet"},',
      '        {"text":"Moderate tinting strength"}',
      "     ]}",
      "  ]}},",
      '  {"card":{"title":"Phthalo blue","children":[{"text":"Cool and very strong"}]}}',
      "]}}",
    ].join("\n");
    const parsed = parseUiBlock(block);
    expect(parsed.meta.title).toBe("Ultramarine vs Phthalo");
    expect(parsed.badLines).toEqual([]);
    expect(parsed.blocks).toHaveLength(1);
    const grid = parsed.blocks[0]!.node;
    expect(grid).toMatchObject({ type: "grid", cols: 2 });
    const first = (grid["children"] as Record<string, unknown>[])[0]!;
    expect(first).toMatchObject({ type: "card", title: "Ultramarine blue" });
    expect((first["children"] as Record<string, unknown>[])[1]).toEqual({
      type: "list",
      items: [{ title: "Warm, leans red / violet" }, { title: "Moderate tinting strength" }],
    });
    expect(checkUiBlock(block).issues.filter((i) => i.level !== "ux")).toEqual([]);
  });

  it("reads a titled container written without its type as a card, never as the meta line", () => {
    const parsed = parseUiBlock(
      lines(
        { title: "Your week", state: { hours: 28 }, children: [{ type: "stat", label: "Focus", value: "{{ hours }}h" }] },
        { children: [{ type: "text", text: "Loose" }] },
        { title: "Open tickets", items: [{ title: "Fix login" }], dividers: true },
      ),
    );
    expect(parsed.meta).toEqual({ state: { hours: 28 } });
    expect(parsed.blocks.map((b) => b.node)).toEqual([
      { type: "card", title: "Your week", children: [{ type: "stat", label: "Focus", value: "{{ hours }}h" }] },
      { type: "stack", children: [{ type: "text", text: "Loose" }] },
      { type: "card", title: "Open tickets", children: [{ type: "list", items: [{ title: "Fix login" }], dividers: true }] },
    ]);
    // A real meta line stays the meta line.
    expect(parseUiBlock(lines({ title: "Plan", state: { n: 1 } }, { type: "text", text: "x" })).meta).toEqual({ title: "Plan", state: { n: 1 } });
  });

  it("streams a value that runs over several lines as a growing draft", () => {
    const parsed = parseUiBlock('{"card":{"title":"A","children":[\n{"text":"one"},\n{"text":"tw', { streaming: true });
    expect(parsed.blocks).toEqual([]);
    expect(parsed.draft).toMatchObject({ type: "card", title: "A", children: [{ type: "text", text: "one" }, { type: "text", text: "tw" }] });
    expect(parsed.draftLine).toBe(1);
  });

  it("reads a top-level array, the whole-spec shape and trailing commas", () => {
    expect(parseUiBlock('[{"type":"divider"},{"text":"hi"}]').blocks.map((b) => [b.key, b.node.type])).toEqual([["1.0", "divider"], ["1.1", "text"]]);
    const spec = parseUiBlock('{"title":"T","state":{"n":1},"ui":{"type":"stack","children":[{"type":"text","text":"a"},{"type":"divider"}]}}');
    expect(spec.meta).toEqual({ title: "T", state: { n: 1 } });
    expect(spec.blocks.map((b) => b.node.type)).toEqual(["text", "divider"]);
    expect(parseUiBlock('{"type":"text","text":"a"},\n{"type":"divider"},').blocks).toHaveLength(2);
  });

  it("stops reading at the size limit", () => {
    const big = Array.from({ length: 900 }, () => JSON.stringify({ type: "text", text: "x".repeat(40) })).join("\n");
    const parsed = parseUiBlock(big);
    expect(parsed.truncated).toBe(true);
    expect(parsed.blocks.length).toBeLessThan(900);
  });
});

describe("splitUiFences", () => {
  it("splits prose and a closed ui fence", () => {
    const md = "Intro\n\n```ui\n{\"type\":\"divider\"}\n```\n\nAfter";
    expect(splitUiFences(md)).toEqual([
      { kind: "markdown", text: "Intro\n" },
      { kind: "ui", text: '{"type":"divider"}', closed: true },
      { kind: "markdown", text: "\nAfter" },
    ]);
  });

  it("returns an open fence while it streams", () => {
    expect(splitUiFences('Intro\n```ui\n{"type":"div', { streaming: true })).toEqual([
      { kind: "markdown", text: "Intro" },
      { kind: "ui", text: '{"type":"div', closed: false },
    ]);
  });

  it("holds back a trailing line that may become a ui opener", () => {
    expect(splitUiFences("Intro\n```", { streaming: true })).toEqual([{ kind: "markdown", text: "Intro\n" }]);
    expect(splitUiFences("Intro\n```u", { streaming: true })).toEqual([{ kind: "markdown", text: "Intro\n" }]);
    expect(splitUiFences("```", { streaming: true })).toEqual([]);
  });

  it("keeps the closing fence of another code block", () => {
    const md = "```js\nlet a = 1\n```";
    expect(splitUiFences(md, { streaming: true })).toEqual([{ kind: "markdown", text: md }]);
  });

  it("leaves a ui fence inside another fence alone", () => {
    const md = '````md\n```ui\n{"type":"divider"}\n```\n````';
    expect(splitUiFences(md)).toEqual([{ kind: "markdown", text: md }]);
  });

  it("splits replies with Windows line endings", () => {
    expect(splitUiFences('Intro\r\n```ui\r\n{"type":"divider"}\r\n```\r\nAfter').map((s) => s.kind)).toEqual(["markdown", "ui", "markdown"]);
  });

  it("accepts tilde fences and other languages untouched", () => {
    expect(splitUiFences('~~~ui\n{"type":"divider"}\n~~~').map((s) => s.kind)).toEqual(["ui"]);
    expect(splitUiFences("```chart\n{}\n```")).toEqual([{ kind: "markdown", text: "```chart\n{}\n```" }]);
  });

  it("finds every fence in a finished reply", () => {
    expect(findUiBlocks('a\n```ui\n{"type":"divider"}\n```\nb\n```ui\n{"type":"divider"}')).toEqual([
      { text: '{"type":"divider"}', closed: true },
      { text: '{"type":"divider"}', closed: false },
    ]);
  });
});

describe("expressions", () => {
  const scope = { price: 12.5, qty: 3, mode: "muted", on: true, picked: ["a", "b"] };

  it("does arithmetic, comparison, logic and ternaries", () => {
    expect(evalUiExpr("price * qty", scope)).toBe(37.5);
    expect(evalUiExpr("qty > 2 && on ? 'many' : 'few'", scope)).toBe("many");
    expect(evalUiExpr("-(qty - 5) % 2", scope)).toBe(0);
    expect(evalUiExpr("mode == 'muted'", scope)).toBe(true);
    expect(evalUiExpr("qty == '3'", scope)).toBe(true);
    expect(evalUiExpr("missing == null", scope)).toBe(true);
  });

  it("calls the allowed functions", () => {
    expect(evalUiExpr("round(price / 3, 2)", scope)).toBe(4.17);
    expect(evalUiExpr("mix('#000000', '#ffffff', 0.5)", scope)).toBe("#808080");
    expect(evalUiExpr("fmt(1234.5, 1)", scope)).toBe("1,234.5");
    expect(evalUiExpr("pct(42.4)", scope)).toBe("42%");
    expect(evalUiExpr("len(picked)", scope)).toBe(2);
    expect(evalUiExpr("concat('a', 1, null)", scope)).toBe("a1");
    expect(evalUiExpr("round(10000 * pow(1 + 7 / 100, 10), 0)", scope)).toBe(19672);
    expect(evalUiExpr("sqrt(16)", scope)).toBe(4);
    expect(evalUiExpr("fmt(pow(10, 400), 0)", scope)).toBe("");
  });

  it("refuses unknown functions, prototype keys and junk", () => {
    expect(() => evalUiExpr("alert(1)", scope)).toThrow(/unknown function/);
    expect(evalUiExpr("constructor", scope)).toBeUndefined();
    expect(evalUiExpr("price.constructor", scope)).toBeUndefined();
    expect(evalUiExpr("__proto__", scope)).toBeUndefined();
    expect(() => evalUiExpr("price; qty", scope)).toThrow();
    expect(() => evalUiExpr("(".repeat(60) + "1" + ")".repeat(60), scope)).toThrow(/nested/);
  });

  it("interpolates text and keeps a lone expression's type", () => {
    expect(interpolate("Total: {{ price * qty }}", scope)).toBe("Total: 37.5");
    expect(interpolate("{{ qty }}", scope)).toBe(3);
    expect(interpolate("{{ 0.1 + 0.2 }} and {{ broken( }}", scope)).toBe("0.3 and ");
    expect(interpolate("no braces", scope)).toBe("no braces");
  });

  it("shows a node only when its condition holds", () => {
    expect(isShown({ show: "on" }, scope)).toBe(true);
    expect(isShown({ show: "{{ !on }}" }, scope)).toBe(false);
    expect(isShown({ show: "qty >" }, scope)).toBe(true);
    expect(isShown({}, scope)).toBe(true);
  });

  it("adds numeric text from choices but joins words", () => {
    expect(evalUiExpr("size + 1", { size: "5" })).toBe(6);
    expect(evalUiExpr("'$' + price", { price: 12 })).toBe("$12");
    expect(evalUiExpr("qty + ' seats'", { qty: 3 })).toBe("3 seats");
    expect(evalUiExpr("empty + 2", { empty: "" })).toBe(2);
  });

  it("guards pct and expands short hex colours", () => {
    expect(evalUiExpr("pct(1 / 0)")).toBe("");
    expect(evalUiExpr("mix('#000', '#fff', 0.5)")).toBe("#808080");
    expect(evalUiExpr("mute('#ff0000', 1)")).toBe("#555555");
  });

  it("displays values without float noise", () => {
    expect(display(0.1 + 0.2)).toBe("0.3");
    expect(display(["a", 2])).toBe("a, 2");
    expect(display(undefined)).toBe("");
  });
});

describe("validation", () => {
  const declared = new Set(["qty"]);

  it("accepts a well-formed block", () => {
    const node = { type: "card", title: "Order", children: [{ type: "slider", name: "qty", label: "Qty", min: 1, max: 9 }, { type: "text", text: "{{ qty * 2 }}" }] };
    expect(validateUiNode(node, "line 1", declared)).toEqual([]);
  });

  it("names unknown types and props with a suggestion", () => {
    const issues = validateUiNode({ type: "buton", text: "Go" }, "line 1", declared);
    expect(issues[0]).toMatchObject({ level: "fatal", message: 'unknown component type "buton"', fix: 'did you mean "button"?' });
    const prop = validateUiNode({ type: "text", txt: "a", text: "b" }, "line 1", declared);
    expect(prop[0]?.fix).toBe('did you mean "text"?');
  });

  it("checks required props, enums and shapes", () => {
    const messages = (node: unknown): string[] => validateUiNode(node, "line 1", declared).map((i) => i.message);
    expect(messages({ type: "heading" })).toContain('heading needs "text"');
    expect(messages({ type: "badge", text: "x", tone: "red" })).toContain("badge.tone should be one of neutral|accent|positive|warning|danger");
    expect(messages({ type: "table", columns: ["a", "b"], rows: [["1"]] })).toContain("table.rows[0] has 1 cells but there are 2 columns");
    expect(messages({ type: "choice", name: "x", options: ["only"] })).toContain("choice needs at least 2 options");
    expect(messages({ type: "text", text: "a", children: [] })).toContain("text cannot have children");
  });

  it("refuses unsafe URLs and colours and expressions where they cannot go", () => {
    const messages = (node: unknown): string[] => validateUiNode(node, "line 1", declared).map((i) => i.message);
    expect(messages({ type: "image", src: "http://x.test/a.png", alt: "A cat" })).toContain("image.src must be an https URL");
    expect(messages({ type: "image", src: "javascript:alert(1)", alt: "A cat" })).toContain("image.src must be an https URL");
    expect(messages({ type: "image", src: "{{ qty }}", alt: "A cat" })).toContain("image.src cannot contain an expression");
    expect(messages({ type: "swatch", label: "x", color: "url(/a.png)" })).toContain('swatch.color "url(/a.png)" is not a colour');
  });

  it("marks undeclared names as reference issues, not fatal ones", () => {
    const issues = validateUiNode({ type: "text", text: "{{ qtyy * 2 }}" }, "line 1", declared);
    expect(issues).toEqual([expect.objectContaining({ level: "reference", fix: expect.stringContaining('did you mean "qty"?') })]);
  });

  it("reports a broken expression as fatal", () => {
    expect(validateUiNode({ type: "text", text: "{{ qty * }}" }, "line 1", declared)[0]?.level).toBe("fatal");
  });

  it("checks show as one expression", () => {
    expect(validateUiNode({ type: "text", text: "a", show: "{{ qty > 1 }}" }, "line 1", declared)).toEqual([]);
    expect(validateUiNode({ type: "text", text: "a", show: "{{ qty }} > {{ qty }}" }, "line 1", declared)[0]?.message).toBe("text.show must be one expression");
  });

  it("checks expressions inside table cells, list fields and set values", () => {
    const refs = (node: unknown): string[] =>
      validateUiNode(node, "line 1", declared)
        .filter((i) => i.level === "reference")
        .map((i) => i.message);
    expect(refs({ type: "table", columns: ["Total"], rows: [["{{ missing * 2 }}"]] })).toEqual(['table.rows[0][0] uses "missing" but no state or input has that name']);
    expect(refs({ type: "list", items: [{ title: "{{ nope }}" }] })).toEqual(['list.items[0].title uses "nope" but no state or input has that name']);
    expect(refs({ type: "button", text: "+1", do: { set: { qty: "{{ qty + one }}" } } })).toEqual(['button.do.set.qty uses "one" but no state or input has that name']);
  });

  it("allows long URLs and prefilled values up to their own limits", () => {
    const url = `https://example.com/${"a".repeat(1_500)}`;
    expect(validateUiNode({ type: "citation", label: "Doc", href: url }, "line 1", declared)).toEqual([]);
    expect(validateUiNode({ type: "input", name: "notes", label: "Notes", value: "x".repeat(2_000) }, "line 1", declared)).toEqual([]);
  });

  it("validates list media and badges", () => {
    const issues = validateUiNode({ type: "list", items: [{ title: "a", badge: { text: "b", tone: "loud" } }, { sub: "no title" }] }, "line 1", declared);
    expect(issues.map((i) => i.message)).toEqual(expect.arrayContaining(["badge.tone should be one of neutral|accent|positive|warning|danger", 'list.items[1] needs "title"']));
  });

  it("accepts stats in a 4-column grid and a palette strip as list media", () => {
    const stats = { type: "grid", cols: 4, children: [{ type: "stat", value: 27, label: "Channels" }, { type: "stat", value: "{{ qty * 2 }}", label: "Seats", note: "Up 2", tone: "positive" }] };
    expect(validateUiNode(stats, "line 1", declared)).toEqual([]);
    const palette = { type: "list", items: [{ title: "Complementary", media: [{ type: "swatch", color: "#2563eb", label: "Blue" }, { type: "swatch", color: "#f97316", label: "Orange" }] }] };
    expect(validateUiNode(palette, "line 1", declared)).toEqual([]);
  });

  it("draws a picture from a query or a URL, and needs one of them", () => {
    expect(validateUiNode({ type: "image", query: "Palolem beach Goa", alt: "Palolem beach" }, "line 1", declared)).toEqual([]);
    expect(validateUiNode({ type: "image", src: "https://x.test/a.png", alt: "A" }, "line 1", declared)).toEqual([]);
    const messages = validateUiNode({ type: "image", alt: "Nothing to show" }, "line 1", declared).map((i) => i.message);
    expect(messages).toContain('image needs "query" or "src"');
    expect(normalizeUiNode({ image: "burnt sienna oil paint" })).toEqual({ type: "image", query: "burnt sienna oil paint" });
    expect(normalizeUiNode({ image: "https://x.test/a.png" })).toEqual({ type: "image", src: "https://x.test/a.png" });
  });

  it("refuses a stat without a printable value and a palette that is not all swatches", () => {
    const messages = (node: unknown): string[] => validateUiNode(node, "line 1", declared).map((i) => i.message);
    expect(messages({ type: "stat", value: { n: 1 }, label: "x" })).toContain("stat.value must be a number or a short text");
    expect(messages({ type: "list", items: [{ title: "a", media: [{ type: "image", src: "https://x.test/a.png", alt: "A" }] }] })).toContain("list.items[0].media as an array must hold 1-6 swatches");
  });

  it("accepts widget headers, icons, checklists, timelines and selects", () => {
    const ok = (node: unknown): void => expect(validateUiNode(node, "line 1", declared), JSON.stringify(node).slice(0, 60)).toEqual([]);
    ok({ type: "card", title: "Weekly overview", sub: "Oct 19-25", icon: "calendar", badge: { text: "Week 43", tone: "accent" }, children: [{ type: "text", text: "x" }] });
    ok({ type: "card", title: "My tasks", aside: "{{ qty }} of 6 completed", children: [{ type: "text", text: "x" }] });
    ok({ type: "progress", value: 80, label: "Focus hours", note: "28 of 35 hours · 80%", tone: "positive" });
    ok({ type: "callout", icon: "lightbulb", title: "Recommendation", text: "Block focus time before noon.", tone: "accent" });
    ok({ type: "row", children: [{ type: "icon", name: "clock", tone: "warning", label: "Due soon" }, { type: "text", text: "Due Friday" }] });
    ok({
      type: "list",
      check: "done",
      numbered: true,
      items: [
        { id: "t1", title: "Ship the release notes", meta: "9:00 - 10:30", badge: { text: "P0", tone: "danger" }, facts: [{ icon: "calendar", text: "Wed, Oct 21" }, "4h"], done: true },
        { title: "Review the API change", media: { type: "icon", name: "git-pull-request", tone: "accent" } },
      ],
    });
    ok({ type: "timeline", items: [{ time: "09:00", title: "Planning", sub: "Room 4", tone: "accent", icon: "users" }] });
    ok({ type: "timeline", groups: [{ label: "Mon", value: "19", items: [{ time: "10:00", title: "Design review" }] }, { label: "Tue", value: "20", items: [] }] });
    ok({ type: "select", name: "qty", label: "Status", options: ["To do", "In progress", "Done"], value: "To do" });
    ok({ type: "button", text: "Send the update", kind: "secondary", full: true, do: "send" });
  });

  it("treats a wrong icon or a bad timeline row as a detail, and an empty timeline as broken", () => {
    const issues = (node: unknown) => validateUiNode(node, "line 1", declared);
    const iconIssues = issues({ type: "card", icon: "unicorn", children: [{ type: "icon", name: "sparkle" }] });
    expect(iconIssues.map((i) => i.message)).toEqual(['card.icon "unicorn" is not an icon', 'icon.name "sparkle" is not an icon']);
    expect(iconIssues.every((i) => i.level === "prop")).toBe(true);
    const rows = issues({ type: "timeline", items: [{ time: "9" }, { title: "Ok", tone: "loud", when: "x" }] });
    expect(rows.map((i) => i.message)).toEqual([
      "timeline.items[0] needs a title",
      'timeline.items[1] has no key "when"',
      "timeline.items[1].tone should be one of neutral|accent|positive|warning|danger",
    ]);
    expect(rows.every((i) => i.level === "prop")).toBe(true);
    expect(issues({ type: "timeline" })).toEqual([expect.objectContaining({ level: "fatal", message: "timeline needs items or groups" })]);
    expect(issues({ type: "list", items: [{ title: "a", facts: [{ icon: "clock" }] }] }).map((i) => i.message)).toEqual(["list.items[0].facts[0] must be text or {icon, text}"]);
    expect(issues({ type: "card", badge: "Week 43", children: [] }).map((i) => i.message)).toContain("card.badge must be {text, tone?}");
  });

  it("caps depth and size", () => {
    let deep: Record<string, unknown> = { type: "text", text: "x" };
    for (let i = 0; i < 12; i++) deep = { type: "stack", children: [deep] };
    expect(validateUiNode(deep, "line 1", declared).some((i) => i.message.startsWith("nesting is deeper"))).toBe(true);
  });
});

describe("drawableUiLine", () => {
  const declared = new Set(["qty"]);

  it("leaves out only the component that cannot be drawn", () => {
    const line = { type: "card", title: "Plan", children: [{ type: "stat", value: "{{ qty * }}", label: "Broken" }, { type: "text", text: "Kept" }] };
    const { node, dropped } = drawableUiLine(line, "line 1", declared);
    expect(dropped).toBe(1);
    expect(node).toEqual({ type: "card", title: "Plan", children: [{ type: "text", text: "Kept" }] });
  });

  it("draws what an unknown component holds, and a plain string as text", () => {
    expect(drawableUiLine({ type: "panel", children: [{ type: "text", text: "Inside" }, "Loose words"] }, "line 1", declared).node).toEqual({
      type: "stack",
      children: [{ type: "text", text: "Inside" }, { type: "text", text: "Loose words" }],
    });
    expect(drawableUiLine({ type: "chart", title: "Signups", label: "by week" }, "line 1", declared).node).toEqual({ type: "text", text: "Signups · by week" });
    expect(drawableUiLine({ type: "chart", data: [1, 2] }, "line 1", declared)).toEqual({ node: null, dropped: 1 });
  });

  it("keeps a component whose only problem is a prop the renderer ignores", () => {
    const line = { type: "card", variant: "outline", tone: "loud", children: [{ type: "text", text: "Fine" }] };
    const issues = validateUiNode(line, "line 1", declared);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.level === "prop")).toBe(true);
    expect(drawableUiLine(line, "line 1", declared)).toEqual({ node: line, dropped: 0 });
  });

  it("drops a broken list row, a broken badge and a bad swatch, not the list", () => {
    const line = {
      type: "list",
      items: [
        { sub: "no title" },
        { title: "Kept", badge: { tone: "positive" }, media: [{ type: "swatch", color: "#2563eb", label: "Blue" }, { type: "swatch", color: "#f97316" }] },
      ],
    };
    const { node, dropped } = drawableUiLine(line, "line 1", declared);
    expect(dropped).toBe(1);
    expect(node).toEqual({ type: "list", items: [{ title: "Kept", media: [{ type: "swatch", color: "#2563eb", label: "Blue" }] }] });
  });
});

describe("checkUiBlock", () => {
  it("passes a good block", () => {
    const text = lines(
      { title: "Plan", state: { seats: 5 } },
      { type: "text", text: "Pro costs **$20** a seat." },
      { type: "slider", name: "seats", label: "Seats", min: 1, max: 50 },
      { type: "text", text: "Total: ${{ seats * 20 }} a month" },
      { type: "button", text: "Start the Pro trial", kind: "primary" },
    );
    expect(checkUiBlock(text).issues).toEqual([]);
  });

  it("reports bad lines, empty blocks and design rule breaks", () => {
    expect(checkUiBlock("").issues[0]?.message).toBe("has no components");
    expect(checkUiBlock("{oops}").issues[0]).toMatchObject({ path: "line 1", message: "is not one JSON object" });
    const twoPrimary = lines({ type: "row", children: [{ type: "button", text: "A", kind: "primary" }, { type: "button", text: "B", kind: "primary" }] });
    expect(checkUiBlock(twoPrimary).issues).toEqual([expect.objectContaining({ level: "ux", message: "2 primary buttons in one group" })]);
    const emptyTable = lines({ type: "table", columns: ["a"], rows: [] });
    expect(checkUiBlock(emptyTable).issues[0]?.message).toBe("table has no rows and no empty message");
    const clash = lines({ type: "toggle", name: "x", label: "X" }, { type: "input", name: "x", label: "X" });
    expect(checkUiBlock(clash).issues[0]?.message).toBe('two different inputs are both named "x"');
  });
});

describe("state and sending", () => {
  it("seeds state from meta and input values", () => {
    const parsed = parseUiBlock(
      lines(
        { state: { base: 4 } },
        { type: "slider", name: "base", label: "Base", min: 0, max: 9, value: 7 },
        { type: "input", name: "double", label: "Double", value: "{{ base * 2 }}" },
        { type: "choice", name: "tags", options: ["a", "b"], multiple: true },
        { type: "toggle", name: "on", label: "On" },
      ),
    );
    expect(initialUiState(parsed)).toEqual({ base: 4, double: 8, tags: [], on: false });
    expect([...declaredNames(parsed)].sort()).toEqual(["base", "double", "on", "tags"]);
  });

  it("seeds a checklist from its done rows, keyed by id or title", () => {
    const parsed = parseUiBlock(
      lines(
        { type: "list", check: "done", items: [{ id: "a", title: "Write", done: true }, { title: "Review", done: true }, { title: "Ship" }, "Celebrate"] },
        { type: "text", text: "{{ len(done) }} of 4 done" },
      ),
    );
    expect(initialUiState(parsed)).toEqual({ done: ["a", "Review"] });
    expect([...declaredNames(parsed)]).toEqual(["done"]);
    expect(checkUiBlock(lines({ type: "list", check: "done", items: [{ title: "x" }] }, { type: "text", text: "{{ len(done) }} done" })).issues).toEqual([]);
    expect([listItemKey({ id: 7, title: "t" }), listItemKey({ title: "t" }), listItemKey("plain"), listItemKey(null)]).toEqual(["7", "t", "plain", ""]);
  });

  it("reports ticked rows by title and names an unlabelled input after its card", () => {
    const roots = [
      { type: "list", check: "done", label: "Finished", items: [{ id: "a", title: "Write" }, { title: "Review" }, "Ship"] },
      { type: "card", title: "Fix login loop", children: [{ type: "select", name: "s1", options: ["To do", "Done"] }] },
      { type: "card", title: "Hidden", show: "{{ false }}", children: [{ type: "select", name: "s2", label: "Status", options: ["a", "b"] }] },
      { type: "slider", name: "hours", label: "Hours", min: 0, max: 9, unit: "h" },
    ];
    expect(uiSendFields(roots, { done: ["a", "Ship"], s1: "Done", s2: "b", hours: 4 })).toEqual([
      { label: "Finished", value: ["Write", "Ship"] },
      { label: "Fix login loop", value: "Done" },
      { label: "Hours", value: 4, unit: "h" },
    ]);
    expect(buildUiSendMessage("Save", uiSendFields(roots, { done: [], s1: "Done", hours: 4 }))).toBe("Save\nFix login loop: Done\nHours: 4 h");
  });

  it("refuses prototype keys as state names", () => {
    const parsed = parseUiBlock(lines({ type: "input", name: "__proto__", label: "x", value: "y" }));
    expect(Object.keys(initialUiState(parsed))).toEqual([]);
  });

  it("writes the visible message a send button posts", () => {
    expect(
      buildUiSendMessage("Book the room", [
        { label: "Time", value: "Tue 11:00" },
        { label: "Size", value: 40, unit: "%" },
        { label: "Seats", value: 6, unit: "people" },
        { label: "Remind me", value: true },
        { label: "Notes", value: "" },
        { label: "Tags", value: ["a", "b"] },
      ]),
    ).toBe("Book the room\nTime: Tue 11:00\nSize: 40%\nSeats: 6 people\nRemind me: Yes\nTags: a, b");
  });
});

describe("uiFencesAsText", () => {
  it("turns a block into readable lines for previews and copy", () => {
    const reply = `Here you go.\n\n\`\`\`ui\n${lines(
      { title: "Plans", state: { seats: 3 } },
      { type: "text", text: "**Team** fits best." },
      { type: "table", columns: ["Plan", "Price"], rows: [["Team", "$14"]] },
      { type: "list", items: [{ title: "SSO", sub: "Included", badge: { text: "New" } }] },
      { type: "choice", name: "plan", label: "Plan", options: ["Team", "Pro"] },
      { type: "slider", name: "seats", label: "Seats", min: 1, max: 9, unit: "seats" },
      { type: "button", text: "Buy" },
      { type: "citation", label: "Pricing page" },
    )}\n\`\`\`\n\nDone.`;
    expect(uiFencesAsText(reply)).toBe(
      "Here you go.\n\nPlans\nTeam fits best.\nPlan | Price\nTeam | $14\n- SSO (New): Included\nPlan: Team / Pro\nSeats: 3 seats\nSource: Pricing page\n\nDone.",
    );
  });

  it("writes widget headers, stats, checklists, timelines and selects as text", () => {
    const reply = `\`\`\`ui\n${lines(
      { type: "card", title: "Weekly overview", sub: "Oct 19-25", badge: { text: "Week 43" }, children: [{ type: "stat", value: 12, label: "Meetings", note: "2 fewer" }] },
      { type: "list", check: "done", items: [{ title: "Ship notes", meta: "9:00", facts: [{ icon: "clock", text: "2h" }], done: true }, { title: "Review" }] },
      { type: "timeline", groups: [{ label: "Mon", value: "19", items: [{ time: "10:00", title: "Design review", sub: "Room 4" }] }] },
      { type: "select", name: "status", label: "Status", options: ["To do", "Done"] },
    )}\n\`\`\``;
    expect(uiFencesAsText(reply)).toBe(
      "Weekly overview (Week 43)\nOct 19-25\nMeetings: 12 (2 fewer)\n- [x] 9:00 Ship notes · 2h\n- [ ] Review\nMon 19\n- 10:00 Design review: Room 4\nStatus: To do / Done",
    );
  });

  it("leaves plain replies alone", () => {
    expect(uiFencesAsText("Just text.")).toBe("Just text.");
  });
});

describe("helpers", () => {
  it("accepts only https URLs", () => {
    expect(isSafeUrl("https://example.com/a.png")).toBe(true);
    expect(isSafeUrl("http://example.com")).toBe(false);
    expect(isSafeUrl("https://ex ample.com")).toBe(false);
    expect(isSafeUrl('https://x.test/"onload')).toBe(false);
  });

  it("accepts only literal colours", () => {
    for (const ok of ["#3b82f6", "#fff", "rgb(1, 2, 3)", "hsl(210 40% 50% / .5)", "teal"]) expect(isSafeColor(ok)).toBe(true);
    for (const bad of ["var(--x)", "url(x)", "red;background:url(x)", "expression(alert(1))"]) expect(isSafeColor(bad)).toBe(false);
  });

  it("documents every component in the catalog", () => {
    const doc = describeUiCatalog();
    for (const name of Object.keys(UI_CATALOG)) expect(doc).toContain(`- ${name}`);
    expect(Object.keys(UI_CATALOG)).toHaveLength(26);
  });
});

// The frontends cannot import workspace packages at build time, so they carry
// verbatim copies. `pnpm --filter xyne-claw-shared sync:gen-ui` rewrites them.
describe("frontend copies", () => {
  const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
  const source = read("./gen-ui.ts");
  const copies = [
    "../../../apps/dashboard/src/components/Markdown/GenerativeUi/genUiCore.ts",
    "../../../apps/xyne-claw-auth/frontend/src/v3/components/genui/genUiCore.ts",
  ];

  it.each(copies)("%s matches gen-ui.ts", (copy) => {
    expect(read(copy), "stale copy: run `pnpm --filter xyne-claw-shared sync:gen-ui`").toBe(source);
  });

  it("the claw v3 renderer matches the dashboard renderer, each with its own icon set for every icon name", () => {
    const iconSet = /\/\/ ── Icon set ─[\s\S]*?\/\/ ── End of icon set ─+\n/;
    const dashboard = read("../../../apps/dashboard/src/components/Markdown/GenerativeUi/GenerativeUi.tsx");
    const clawV3 = read("../../../apps/xyne-claw-auth/frontend/src/v3/components/genui/GenerativeUi.tsx");
    expect(clawV3.replace(iconSet, ""), "stale copy: run `pnpm --filter xyne-claw-shared sync:gen-ui`").toBe(dashboard.replace(iconSet, ""));
    for (const [app, text] of [["dashboard", dashboard], ["claw v3", clawV3]] as const) {
      const names = [...(text.match(iconSet)?.[0] ?? "").matchAll(/^\s*\['([a-z0-9-]+)',/gm)].map((m) => m[1]);
      expect(names, app).toEqual([...UI_ICONS, "chevron-down"]);
    }
  });
});
