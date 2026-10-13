// Copies the generative UI core and renderer into the two chat frontends.
//
// Neither frontend can import a workspace package at build time (the dashboard
// image installs only packages/shared and packages/icons; claw v3 is a
// standalone npm project), so they carry verbatim copies:
//   src/gen-ui.ts                                  -> both frontends' genUiCore.ts
//   apps/dashboard/.../GenerativeUi/GenerativeUi.tsx -> claw v3's GenerativeUi.tsx
// The renderer copy keeps claw v3's own "Icon set" section: each chat draws
// icons with the set it already uses (the dashboard @xyne/icons, claw v3 lucide).
// src/gen-ui.test.ts fails while any copy is stale.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = (path) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));

const core = repo("packages/xyne-claw-shared/src/gen-ui.ts");
const dashboard = "apps/dashboard/src/components/Markdown/GenerativeUi";
const clawV3 = "apps/xyne-claw-auth/frontend/src/v3/components/genui";

const ICON_SET = /\/\/ ── Icon set ─[\s\S]*?\/\/ ── End of icon set ─+\n/;

const copies = [
  [core, repo(`${dashboard}/genUiCore.ts`)],
  [core, repo(`${clawV3}/genUiCore.ts`)],
];

for (const [from, to] of copies) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  console.log(`copied ${from.split("/xyne-spaces/").pop()} -> ${to.split("/xyne-spaces/").pop()}`);
}

const renderer = repo(`${dashboard}/GenerativeUi.tsx`);
const clawRenderer = repo(`${clawV3}/GenerativeUi.tsx`);
const ownIcons = readFileSync(clawRenderer, "utf8").match(ICON_SET)?.[0];
if (!ownIcons) throw new Error(`${clawRenderer} has no "Icon set" section to keep`);
writeFileSync(clawRenderer, readFileSync(renderer, "utf8").replace(ICON_SET, () => ownIcons));
console.log(`copied ${renderer.split("/xyne-spaces/").pop()} -> ${clawRenderer.split("/xyne-spaces/").pop()} (keeping its icon set)`);
