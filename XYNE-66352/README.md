# Proof of test for PR #2939 (XYNE-66352)

The PR fixes title polling, which refetched every Xyne AI history page six times. These recordings come from a sandbox run of branch `fix/XYNE-66352-xyne-ai-title-poll-history` at `898dda37`. The Claw endpoints were mocked with 2 history pages and an untitled old chat on page 2.

| Video | Scenario | Polling refetches after open (~96s) |
|---|---|---|
| 1-before-fix-old-chat-12-refetches.mp4 | Before the fix, opening an old chat from history | 12 (page1=6, page2=6) |
| 2-after-fix-old-chat-0-refetches.mp4 | After the fix, opening the same old chat | 0 |
| 3-after-fix-new-chat-title-polling-works.mp4 | After the fix, starting a new chat | 1, then stopped when the title arrived |

This branch only stores the recordings. Do not merge it.
