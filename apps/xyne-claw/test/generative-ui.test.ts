import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isReadOnlyJob } from "xyne-claw-shared";
import { UI_CATALOG, findUiBlocks } from "xyne-claw-shared/gen-ui";
import {
  GENERATIVE_UI_SKILL_PATH,
  buildGenerativeUiPrimer,
  generativeUiDefaultOn,
  generativeUiSkillPaths,
  skillsForRun,
  uiBlockAwaitsUser,
  uiBlockProblems,
  uiBlockRetryNudge,
  type GenerativeUiRunContext,
} from "../src/presentation-catalog.js";

/** A direct chat from the AI screen, sidebar or claw v3: flag set, no event. */
const chatRun = (over: Partial<GenerativeUiRunContext> = {}): GenerativeUiRunContext => ({
  generativeUi: true,
  eventType: undefined,
  conversationId: "chat-abc",
  isScheduledOrAutomationRun: isReadOnlyJob,
  hasOwnDeliveryContract: false,
  enabled: true,
  ...over,
});

describe("generativeUiDefaultOn", () => {
  it("is on for the flag with no eventType", () => {
    expect(generativeUiDefaultOn(chatRun())).toBe(true);
    expect(generativeUiDefaultOn(chatRun({ conversationId: undefined }))).toBe(true);
  });

  it("is never on for a thread or background event, even with the flag", () => {
    for (const eventType of [
      "APP_MENTIONED",
      "DIRECT_MESSAGE",
      "USER_MENTIONED",
      "scheduled_job",
      "scheduled",
      "automation",
      "awakening",
      "artifact_app",
      "anything_else",
    ]) {
      expect(generativeUiDefaultOn(chatRun({ eventType })), eventType).toBe(false);
    }
  });

  it("is off for a scheduled conversation id", () => {
    expect(generativeUiDefaultOn(chatRun({ conversationId: "scheduled_123" }))).toBe(false);
  });

  it("needs the flag to be exactly true", () => {
    for (const generativeUi of [undefined, false, "true", 1, null, {}]) {
      expect(generativeUiDefaultOn(chatRun({ generativeUi })), String(generativeUi)).toBe(false);
    }
  });

  it("is off when the optimization is off", () => {
    expect(generativeUiDefaultOn(chatRun({ enabled: false }))).toBe(false);
  });

  it("is off when the run has its own delivery contract", () => {
    expect(generativeUiDefaultOn(chatRun({ hasOwnDeliveryContract: true }))).toBe(false);
  });
});

describe("buildGenerativeUiPrimer", () => {
  const primer = buildGenerativeUiPrimer();

  it("names every catalog component", () => {
    for (const name of Object.keys(UI_CATALOG)) expect(primer, name).toContain(name);
  });

  it("ends with worked examples that pass the check", () => {
    const examples = primer.slice(primer.indexOf("Example: explaining a concept"));
    expect(findUiBlocks(examples)).toHaveLength(4);
    expect(uiBlockProblems(examples)).toEqual([]);
  });

  it("makes a drawn answer the default for structured content, from knowledge or tools", () => {
    expect(primer).toContain("a structured answer is a drawn answer");
    expect(primer).toContain("whether it comes from your own knowledge or from tool results");
    // The agent's own "just answer conversational questions" rule must not read as "no UI".
    expect(primer).toContain("writing one is not a tool call, so it needs no plan and no tools");
    expect(primer).not.toContain("Prose stays the default");
    expect(primer).toContain("pow(x, y)");
  });

  it("is identical on every call so it stays in the prompt cache", () => {
    expect(buildGenerativeUiPrimer()).toBe(primer);
  });
});

describe("uiBlockProblems", () => {
  const fence = (...lines: string[]) => ["Here you go.", "", "```ui", ...lines, "```"].join("\n");

  it("passes a good block and a reply with no block", () => {
    expect(uiBlockProblems("Just prose.")).toEqual([]);
    expect(
      uiBlockProblems(fence('{"type":"card","children":[{"type":"text","text":"Hello"},{"type":"button","text":"Go","kind":"primary"}]}')),
    ).toEqual([]);
  });

  it("flags an unknown component", () => {
    expect(uiBlockProblems(fence('{"type":"carousel"}')).length).toBeGreaterThan(0);
  });

  it("does not spend a rewrite on a prop the chat simply ignores", () => {
    expect(uiBlockProblems(fence('{"type":"card","variant":"outline","tone":"loud","children":[{"type":"text","text":"Hi"}]}'))).toEqual([]);
    expect(uiBlockProblems(fence('{"type":"stat","value":"{{ nope }}","label":"Total"}')).join(" ")).toMatch(/no state or input/);
  });

  it("flags a line that is not JSON", () => {
    expect(uiBlockProblems(fence("{not json")).length).toBeGreaterThan(0);
  });

  it("flags a block that is never closed", () => {
    const problems = uiBlockProblems(['```ui', '{"type":"text","text":"Hi"}'].join("\n"));
    expect(problems.join(" ")).toMatch(/never closed/);
  });

  it("caps the list so the nudge stays short", () => {
    const lines = Array.from({ length: 30 }, () => '{"type":"carousel"}');
    expect(uiBlockProblems(fence(...lines)).length).toBeLessThanOrEqual(12);
  });
});

describe("uiBlockAwaitsUser", () => {
  const reply = (...lines: unknown[]): string => `Done.\n\n\`\`\`ui\n${lines.map((l) => JSON.stringify(l)).join("\n")}\n\`\`\``;

  it("is true when the block has an input or a sending button", () => {
    expect(uiBlockAwaitsUser(reply({ type: "choice", name: "t", options: ["a", "b"] }))).toBe(true);
    expect(uiBlockAwaitsUser(reply({ type: "card", children: [{ type: "button", text: "Book it" }] }))).toBe(true);
    expect(uiBlockAwaitsUser(reply({ type: "button", text: "Book it", do: "send" }))).toBe(true);
  });

  it("is false for a display-only block, a local-only button and plain text", () => {
    expect(uiBlockAwaitsUser(reply({ type: "table", columns: ["a"], rows: [["1"]] }))).toBe(false);
    expect(uiBlockAwaitsUser(reply({ state: { n: 1 } }, { type: "button", text: "Reset", do: "reset" }))).toBe(false);
    expect(uiBlockAwaitsUser("Just prose.")).toBe(false);
  });
});

describe("uiBlockRetryNudge", () => {
  it("lists each problem and asks for the whole reply again", () => {
    const nudge = uiBlockRetryNudge(["a: first problem", "b: second problem"]);
    expect(nudge).toContain("- a: first problem");
    expect(nudge).toContain("- b: second problem");
    expect(nudge).toMatch(/COMPLETE reply/);
  });
});

describe("skillsForRun", () => {
  const skills = [
    { slug: "generative-ui", name: "Generative Ui" },
    { name: "Generative UI.md" },
    { slug: "sandbox-guide", name: "sandbox-guide" },
  ];

  it("keeps the generative-ui dashboard skill only on runs that draw blocks", () => {
    expect(skillsForRun(skills, true)).toBe(skills);
    expect(skillsForRun(skills, false)).toEqual([{ slug: "sandbox-guide", name: "sandbox-guide" }]);
    expect(skillsForRun(undefined, false)).toBeUndefined();
  });
});

describe("generativeUiSkillPaths", () => {
  it("loads the built-in bundle where it exists, and never on a run that cannot draw", () => {
    const pkg = mkdtempSync(join(tmpdir(), "claw-pkg-"));
    try {
      expect(generativeUiSkillPaths(pkg, true)).toEqual([]);
      mkdirSync(join(pkg, GENERATIVE_UI_SKILL_PATH));
      expect(generativeUiSkillPaths(pkg, true)).toEqual([GENERATIVE_UI_SKILL_PATH]);
      expect(generativeUiSkillPaths(pkg, false)).toEqual([]);
    } finally {
      rmSync(pkg, { recursive: true, force: true });
    }
  });
});

describe("ui-skills bundle", () => {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..", GENERATIVE_UI_SKILL_PATH);

  function markdownFiles(root: string): string[] {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      return []; // not written yet: nothing to check
    }
    return entries.flatMap((name) => {
      const full = join(root, name);
      if (statSync(full).isDirectory()) return markdownFiles(full);
      return name.endsWith(".md") ? [full] : [];
    });
  }

  it("keeps every ui example in the skill files valid", () => {
    for (const file of markdownFiles(dir)) {
      findUiBlocks(readFileSync(file, "utf8")).forEach((block, index) => {
        const label = `${file} block ${index + 1}`;
        expect(block.closed, label).toBe(true);
        expect(uiBlockProblems("```ui\n" + block.text + "\n```"), label).toEqual([]);
      });
    }
  });
});
