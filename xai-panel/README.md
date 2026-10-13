# Proof of test for fix/xai-panel

Before and after recordings for the Xyne AI workspace panel and sandbox preview fixes (XYNE-66327, 66328, 66329, 66336, 66340, 66342).

## How these were recorded

- **Stack:** local Spaces backend and dashboard, logged in through the test login.
  - BEFORE is `main` at `2bdcfd28e`.
  - AFTER is `fix/xai-panel` rebased onto that commit.
- **Mocked data:** Xyne AI history, transcripts, conversation artifacts and the run stream come from a small local mock, routed in with Playwright, so both runs see identical data.
- **Sandbox preview page:** `/claw-preview/<id>/` serves a stand-in page that does what noVNC needs: it reads `localStorage` and cookies on its own origin. It also shows how long its session has been up and when it was loaded, so a reload is visible.
- **Overlays:** each video carries a BEFORE/AFTER badge and a caption for every step.

## Videos

| Video | Scenario | Result |
|---|---|---|
| 1-switch-before.mp4 | Open an old chat with a saved page; close the panel; switch chats and back; reload | Panel opens by itself on open, on switching back, and on reload. The close is forgotten. |
| 2-switch-after.mp4 | Same steps | Panel stays closed throughout; the Workspace button still opens it. |
| 3-run-before.mp4 | A run creates a page, then updates it twice; the user closes the panel before each update | Panel reopens after every update. |
| 4-run-after.mp4 | Same steps | Panel opens once for the run's first page, then stays closed after the user closes it. |
| 5-sandbox-before.mp4 | Chat with two sandboxes; open Preview; switch to Artifacts and back | Preview fails with `SecurityError … lacks the 'allow-same-origin' flag`. Only the newest sandbox is reachable, with no way to tell them apart. The tab switch reloads the page (session restarts). |
| 6-sandbox-after.mp4 | Same steps | Preview connects. A picker lists both sandboxes by time. The tab switch keeps the same session (the load time is unchanged). |

This branch only stores the recordings. Do not merge it.
