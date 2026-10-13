import { describe, expect, it } from "vitest";
import {
  AI_SCREEN_PRESENTATION_INSTRUCTIONS,
  withAiScreenPresentationInstructions,
} from "./ai-screen-presentation-tools.js";

describe("withAiScreenPresentationInstructions", () => {
  it("is byte-identical to the base instructions when generativeUi is off or absent", () => {
    expect(withAiScreenPresentationInstructions(undefined)).toBe(AI_SCREEN_PRESENTATION_INSTRUCTIONS);
    expect(withAiScreenPresentationInstructions(undefined, {})).toBe(AI_SCREEN_PRESENTATION_INSTRUCTIONS);
    expect(withAiScreenPresentationInstructions(undefined, { generativeUi: false })).toBe(
      AI_SCREEN_PRESENTATION_INSTRUCTIONS,
    );
    expect(AI_SCREEN_PRESENTATION_INSTRUCTIONS).not.toContain("```ui");
    expect(AI_SCREEN_PRESENTATION_INSTRUCTIONS).toContain(
      "  are about to type a ``` fence in your reply, stop: call `load-tools` and post",
    );
  });

  it("keeps the caller's own instructions first in both modes", () => {
    expect(withAiScreenPresentationInstructions("  be brief  ")).toBe(
      `be brief\n\n${AI_SCREEN_PRESENTATION_INSTRUCTIONS}`,
    );
    expect(withAiScreenPresentationInstructions("be brief", { generativeUi: true })).toMatch(/^be brief\n\n## Artifact cards/);
  });

  it("scopes the no-fences rule to code when on, and leaves ui wording to claw", () => {
    const on = withAiScreenPresentationInstructions(undefined, { generativeUi: true });
    expect(on).toContain("Multi-line CODE ALWAYS goes in a card");
    expect(on).toContain("about to type a code ``` fence in your reply");
    // claw alone decides whether the run gets the ui primer, so claw-auth never
    // points at it (an agent with the optimization off must not be told about it).
    expect(on).not.toContain("```ui");
    expect(on).not.toContain("Interactive answers");
  });

  it("drops prose as the default for explanations when on, and changes nothing else", () => {
    const off = AI_SCREEN_PRESENTATION_INSTRUCTIONS.split("\n");
    const onText = withAiScreenPresentationInstructions(undefined, { generativeUi: true });
    const on = onText.split("\n");
    expect(off.join("\n")).toContain("Prose is the default for everything else (explanations");
    expect(onText).not.toContain("Prose is the default");
    expect(onText).toContain("- Code blocks are the exception above, not a card to be earned.");
    // Reworded code rule (2 lines) + the shortened prose rule (1 line in, 2 out).
    expect(on.filter((line) => !off.includes(line))).toHaveLength(3);
    expect(off.filter((line) => !on.includes(line))).toHaveLength(4);
  });
});
