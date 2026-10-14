# Proof of test for XYNE-65823 (experiment status and epoch cards)

The same `/experiment 3m` run was recorded twice in `#claw-lab` on a local stack.

## Setup

- **Before:** `main` (`2bdcfd28e`): claw-auth, Spaces backend and dashboard.
- **After:** `feature/XYNE-65823-experiment-cards` with `EXPERIMENT_CARDS=true`. Card edit gaps were shortened to 4s and 1.5s so a 3-minute replay updates visibly; the production defaults are 15s and 3s.
- **Command path:** typed into the composer by a real workspace user. It goes through the real app-mention webhook into claw-auth, which dispatches each epoch onto the real run queue.
- **Stand-in claw runner:** consumes that queue and plays each epoch through claw-auth's real callbacks, the same ones claw uses:
  - plan (todo) updates and the sandbox live-preview announcement;
  - hypothesis, ledger findings and delivered-file writes;
  - one provider timeout (`model stopped responding for 135s`);
  - one epoch result that @mentions a person;
  - the final `end-experiment` report.
- **Content:** epoch texts and proof file names come from the real 2026-10-07 run in #testing-claw. Each epoch lasts about 32s so claw-auth's rapid-fail brake (30s) does not hold the next epoch.

## Files

| File | What it shows |
|---|---|
| `1-before-main.mp4` / `.gif` | **26 replies**: a plain start message; then for every epoch a plan card ("Flow JSON"), a Live preview post and a result post with its proof file; plus the provider-timeout notice and `/experiment ended` |
| `2-after-cards.mp4` / `.gif` | **10 replies**: one status card edited in place; one card per epoch (live checklist, sandbox links, result, findings, proof file attached to the card, the timeout shown as a failed epoch); one @mention message; `/experiment ended` |
| `3-status-card-done.png` | The finished status card: Done, exit rule, 4 proved / 1 refuted / 0 open, 6 epochs (1 failed), "Needs you (1)", findings |
| `4-epoch-cards.png` | The failed epoch card with the provider reason, a done epoch with its result preview, a recorded and a refuted finding, and the attached proof |

The GIFs play at 4× speed; the MP4s are real time.

This branch only stores the recordings. Do not merge it.
