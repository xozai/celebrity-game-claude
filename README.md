# Celebrity Game — Backend

Node.js / Express / Socket.IO backend. Deployed on Render at `https://celebrity-game-claude.onrender.com`.

## Local Development

```bash
npm install
npm run dev        # nodemon, auto-restarts on change
```

Works with no extra setup — falls back to in-memory storage when `REDIS_URL` is not set.

---

## Redis Setup (for persistence across restarts)

Without Redis, all rooms are lost when the server restarts or Render spins it down. With Redis, rooms survive for 24 hours.

### Option A — Upstash (recommended, serverless, free tier)

1. Go to [upstash.com](https://upstash.com) → Create a free account
2. **Create Database** → choose a region close to your Render deployment (e.g. `us-east-1`)
3. Copy the **REDIS_URL** from the database page (format: `rediss://default:PASSWORD@HOST:PORT`)

### Option B — Redis Cloud free tier

1. Go to [redis.com/try-free](https://redis.com/try-free)
2. Create a free 30 MB database
3. From the database page, copy **Public endpoint** and **Password**
4. Build the URL: `redis://default:PASSWORD@HOST:PORT`

### Add to Render

1. Open your Render service → **Environment**
2. Add variable: `REDIS_URL` = the URL from above
3. Click **Save** — Render will redeploy automatically

---

## Environment Variables

| Variable    | Required | Description |
|-------------|----------|-------------|
| `PORT`      | No       | HTTP port (default `3030`, Render sets this automatically) |
| `REDIS_URL` | No       | Redis connection string. Omit for in-memory-only mode. |

---

## What Redis Enables

| Feature | Without Redis | With Redis |
|---------|--------------|------------|
| Rooms survive server restart | ✗ | ✓ (24 h TTL) |
| Rooms survive Render spin-down | ✗ | ✓ |
| Player reconnection mid-game | ✗ | ✓ |
| Room cleanup job | ✓ (in-memory only) | ✓ (scans Redis) |

---

## New Features (v2)

### Player Reconnection
If a player loses connection (network drop, app background, server restart), they can rejoin by entering the same name and room code. The server re-associates their socket and restores their game view. The iOS app does this automatically on reconnect.

### Graceful Mid-Turn Disconnect
If the clue-giver disconnects mid-turn, the turn is **paused** (timer frozen) for 30 seconds. If they reconnect within that window, the turn resumes. If not, the turn finalizes normally.

### Rate Limiting
`create_room` is limited to **5 rooms per IP per hour** to prevent abuse.

### Room Cleanup
A background job runs every 5 minutes and deletes:
- Finished rooms older than 1 hour
- Rooms where all players have been disconnected for more than 30 minutes

---

## Socket Event Reference

### Client → Server

| Event | Payload | Notes |
|-------|---------|-------|
| `create_room` | `{ playerName }` or plain string | Web or iOS |
| `join_room` | `{ roomCode, playerName }` | Also handles reconnection |
| `set_teams` | `{ assignments: { id: teamIdx } }` or `[[ids], [ids]]` | Web or iOS |
| `start_game` | — | Host only |
| `submit_celebrities` | `{ names: [...] }` or `[...]` | Web or iOS |
| `start_turn` | — | Current player only |
| `got_it` | — | |
| `skip_slip` | — | |
| `start_next_round` | — | Host only |

### Server → Client

| Event | Key fields |
|-------|-----------|
| `room_created` | `{ roomCode, gameState }` |
| `room_joined` | `{ gameState }` |
| `state_update` | `{ gameState }` |
| `phase_changed` | `{ phase, gameState }` |
| `round_starting` | `{ round, totalSlips, gameState }` |
| `turn_started` | `{ playerId, playerName, teamIdx, timerEnd, gameState }` |
| `your_slip` | `{ slip }` — sent to current player only |
| `slip_correct` | `{ slip, count, pileCount }` |
| `slip_skipped` | `{ pileCount }` |
| `turn_ended` | `{ got, skipped, pileCount, teamIdx, slipsGotten, scores, gameState }` |
| `round_ended` | `{ round, scores, lastTurnSlips, lastTeamIdx, gameState }` |
| `game_ended` | `{ scores, winner, lastTurnSlips, lastTeamIdx, gameState }` |
| `player_joined` | `{ player, gameState }` |
| `player_left` | `{ playerId, gameState }` |
| `error_msg` | `{ msg }` |
