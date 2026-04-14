# Celebrity Game — QA Test Plan

## How to run the automated integration tests

```bash
# 1. Start the server locally
npm run dev

# 2. In another terminal, run the test suite
node test/integration.js

# Against a deployed server (e.g. Render)
TEST_SERVER=https://celebrity-game-claude.onrender.com node test/integration.js
```

---

## Manual QA Checklist

Complete on both **Chrome (web)** and **iOS Simulator** unless marked otherwise.

### Setup
- [ ] Server is running and reachable (check cold-start warning appears if Render is asleep)
- [ ] iOS Xcode project builds with zero errors and zero warnings

---

### 1. Home Screen

| # | Step | Expected |
|---|------|----------|
| 1.1 | Open app fresh (no saved name) | Home screen shows, "How to Play" sheet appears automatically |
| 1.2 | Dismiss "How to Play" | Sheet closes, `hasSeenOnboarding` set — relaunch confirms sheet does NOT reappear |
| 1.3 | Tap ••• menu → "How to Play" | Sheet re-opens on demand |
| 1.4 | Toggle Dark / Light / System theme | App updates immediately, preference persists after relaunch |
| 1.5 | Tap "Create Room" with empty name | Error: "Enter your name first" |
| 1.6 | Tap "Join Room" with empty name | Error: "Enter your name first" |
| 1.7 | Wait ~30s after server cold-start | Orange warning banner appears; Retry button works |

---

### 2. Lobby

| # | Step | Expected |
|---|------|----------|
| 2.1 | Create a room | Lobby shows 4-letter room code |
| 2.2 | Tap "Copy" | Code copied; button turns green → "Copied!" for 2s |
| 2.3 | Tap "QR" (iOS) | QR code sheet appears with scannable code and monospaced room code |
| 2.4 | Scan QR with second device | Second device joins the room |
| 2.5 | Tap "Share" | Share sheet opens with join message |
| 2.6 | Host changes team names | All clients see updated names immediately |
| 2.7 | Host changes Celebrities per player | Stepper updates for all clients |
| 2.8 | Host changes Turn duration | Segmented control updates for all clients |
| 2.9 | Tap "Assign Teams & Start" with 2 players | Alert: "fewer than 4 players?" with Start Anyway / Cancel |
| 2.10 | Tap "Start Anyway" on alert | Game proceeds to submitting phase |
| 2.11 | Tap "Assign Teams & Start" with 4+ players | No alert — game starts directly |
| 2.12 | Non-host cannot see Start button | Start button not visible to non-host |
| 2.13 | Context-hold a player name → "Make Host" | Host role transfers; crown emoji moves |
| 2.14 | Tap Leave | Returns to home screen |

---

### 3. Celebrity Submission

| # | Step | Expected |
|---|------|----------|
| 3.1 | Type 2+ chars in any field | Autocomplete dropdown appears within 300ms |
| 3.2 | Select a suggestion | Field filled; focus moves to next field |
| 3.3 | Press arrow keys in dropdown (web) | Keyboard navigation works |
| 3.4 | Submit fewer names than required | Submit button disabled / error shown |
| 3.5 | Submit all required names | Waiting screen shows with progress counter |
| 3.6 | Waiting screen shows "X / Y players done" | Count updates as each player submits |
| 3.7 | Tap "Change Submission" (iOS) on waiting screen | Returns to form; re-edit and resubmit works |
| 3.8 | After retract, count decrements | Submission count on waiting screen goes back down |
| 3.9 | All players submit | Round 1 intro overlay appears for everyone |

---

### 4. Gameplay — Round Rule Banner

| # | Step | Expected |
|---|------|----------|
| 4.1 | Enter Round 1 | Blue banner: "💬 Say anything — describe without saying the name" |
| 4.2 | Enter Round 2 | Orange banner: "☝️ One word only!" |
| 4.3 | Enter Round 3 | Indigo/purple banner: "🎭 Act it out — no words allowed!" |
| 4.4 | Banner visible to all players (not just clue-giver) | All clients show the banner |

---

### 5. Gameplay — Active Turn

| # | Step | Expected |
|---|------|----------|
| 5.1 | Current player taps "Start Turn" | Medium haptic fires; timer starts; celebrity card appears |
| 5.2 | Non-current player tries to start turn | Nothing happens |
| 5.3 | Tap "Got it!" | Heavy haptic; score increments; next name appears immediately |
| 5.4 | Tap "Skip" | Light haptic; new name appears; skipped name goes back to pile |
| 5.5 | Timer reaches 10s | Timer turns red |
| 5.6 | Timer reaches 0 | Heavy haptic + error vibration; turn recap appears |
| 5.7 | Timer value spoken by VoiceOver | "12 seconds remaining" (accessibility check) |
| 5.8 | "Got it!" / "Skip" accessibility hint | VoiceOver reads the hint text |

---

### 6. Turn Recap & Scores

| # | Step | Expected |
|---|------|----------|
| 6.1 | Turn recap shows correct count | "Got X, Skipped Y" matches what happened |
| 6.2 | Team scores update after each turn | Both clients show updated score in header |
| 6.3 | Pile count decrements correctly | "N slips left" decreases after each "Got it!" |

---

### 7. Round End

| # | Step | Expected |
|---|------|----------|
| 7.1 | Last slip guessed | Round end sheet appears; success haptic fires |
| 7.2 | Round end sheet shows cumulative scores | Correct totals for both teams |
| 7.3 | History section shows who guessed what | Collapsible, all turns listed |
| 7.4 | Host sees "Start Round N" button | Button visible only to host |
| 7.5 | Non-host sees "Waiting for host…" | Button hidden; waiting text shown |
| 7.6 | Host taps "Start Round 2" | Round 2 intro fires for all clients; pile reshuffled to full |
| 7.7 | Host briefly disconnects at round end then reconnects | After reconnect, host gets "Start Round N" button back |

---

### 8. Game End & Play Again

| # | Step | Expected |
|---|------|----------|
| 8.1 | Round 3 completes | Game end sheet appears; winner announced |
| 8.2 | Winning team on iOS gets confetti / win message | "Your team wins! 🎉" in green |
| 8.3 | Losing team sees winner's name | Correct team name shown |
| 8.4 | Full game history disclosure group | All 3 rounds expandable |
| 8.5 | Share Results button | iOS share sheet opens with score summary text |
| 8.6 | Host sees "Play Again" button | Visible only to host |
| 8.7 | Non-host sees only "Back to Home" | No "Play Again" button |
| 8.8 | Host taps "Play Again" | All clients return to lobby; scores reset; players stay; teams preserved |
| 8.9 | Play Again — submit new names and play full game | Full second game completes without issues |
| 8.10 | Non-host cannot trigger Play Again | Confirmed no button shown |

---

### 9. Reconnection & Network

| # | Step | Expected |
|---|------|----------|
| 9.1 | Kill app mid-game and relaunch | Rejoins room automatically; correct phase shown |
| 9.2 | Airplane mode for 5s during turn | Orange "Reconnecting…" banner appears (non-blocking) |
| 9.3 | Reconnect — banner dismisses | Game continues; clue-giver gets their slip back |
| 9.4 | 3 failed reconnect attempts | Status changes to "unreachable"; Retry button appears |
| 9.5 | Tap Retry | Reconnects and banner clears |
| 9.6 | Host kills app mid-turn | Turn timer continues; host reassigned after grace period |

---

### 10. Cross-Platform (Web + iOS in same room)

| # | Step | Expected |
|---|------|----------|
| 10.1 | iOS host + web guest in same room | Both see lobby with each other's names |
| 10.2 | Web player submits via autocomplete | iOS waiting screen count increments |
| 10.3 | iOS player gives clues, web player watches | Web shows "Watching" view with timer |
| 10.4 | Web round rule banner matches iOS | Same round, same rule shown |
| 10.5 | Web "Play Again" resets lobby for iOS | iOS clients return to lobby |

---

### 11. Edge Cases

| # | Step | Expected |
|---|------|----------|
| 11.1 | All players on same team | Server returns error "Both teams need at least one player" |
| 11.2 | Submit celebrity with special chars (é, ü, ñ) | Name stored and displayed correctly |
| 11.3 | Two players submit same celebrity name | Both names appear (no dedup — this is expected) |
| 11.4 | Host leaves mid-game | New host assigned; remaining players can finish |
| 11.5 | Only 2 players play full game | Game completes normally (single-player teams) |
| 11.6 | Spectator joins and watches | Cannot start turn, submit, or score; sees all screens |
| 11.7 | Very long celebrity name (50 chars) | Truncated in UI; does not break layout |
| 11.8 | Rapid "Got it!" taps | No double-score; server guards against duplicate scoring |

---

## Known Limitations (not bugs)

- Server cold-start on Render free tier takes ~30s — expected behaviour
- Room state lost if server restarts — in-memory only, no persistence
- Max 2 teams only
- No undo/dispute for "Got it!" (post-MVP feature)
- QR code join requires the recipient to have the app installed — no web fallback
