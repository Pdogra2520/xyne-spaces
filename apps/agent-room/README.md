# Agent Room

A Spaces CLI app where Claw agents and personas debate a question under an adversarial
pattern (Red/Blue, Devil's advocate, Pre-mortem) and a judge agent writes a decision record.
No changes to Spaces or Claw: it uses the public SDK as the signed-in viewer.

## How it works

- The app runs the debate in the browser (`room/engine.ts`).
- Each room is a new thread in the chosen channel: config message, round headers, one message per turn.
- Each turn is `sdk.claw.runAndWait({ agent, task, timeoutMs })`. Seats in a round run in parallel on the same transcript snapshot.
- The judge must return JSON with real turn ids; the app validates it and gives one corrective retry.
- The decision goes to a canvas (`sdk.canvases.createFromMarkdown`); if that fails, the full record is posted in the thread.
- Hard limits in code: 8 seats, 5 rounds, 50 agent runs, 120 s per turn. One run is always kept for the judge.

## Layout

```
App.tsx                 UI: home, setup, live room
room/types.ts           types + limits
room/patterns.ts        patterns, schedule builder, persona templates
room/prompts.ts         turn/judge prompts, parsing, validation
room/engine.ts          RoomRunner: rounds, caps, retries, early stop, judging
room/format.ts          thread messages + decision markdown
room/backend.ts         the only file that calls the SDK (+ mock backend)
agents/*.md             system prompts for the two helper Claw agents (not uploaded)
scripts/slim-spaces-entry.js  slim SDK entry; adds CanvasesResource to the template set
```

## Before first use

1. Create two Claw agents in Agent Hub with no tools and memory off:
   `agent-room-persona` and `agent-room-judge`. Prompts are in `agents/`.
2. Existing agents you add as seats run with your permissions. Prefer agents without write tools.

## Run, push, publish (macOS, Node 22+, signed in to Spaces in Chrome/Brave/Edge/Arc)

```bash
cd apps/agent-room
npm install
npm run bundle:sdk     # rebuilds lib/vendor/*.js (already committed)
spaces token           # writes XYNE_TOKEN to .env
npm run dev            # try Mock mode first, then a real 2-seat room
spaces app push        # first push creates the app, later pushes add versions
spaces app publish
```

Every uploaded file must stay under 64 KB. Check with
`find . -path ./node_modules -prune -o -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' \) -size +63k -print`.
