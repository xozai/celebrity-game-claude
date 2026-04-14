'use strict';
const express = require('express');
const http    = require('http');
const https   = require('https');
const { Server } = require('socket.io');
const path    = require('path');

// ── Optional Redis (falls back to in-memory if REDIS_URL is unset) ────
let redis = null;
if (process.env.REDIS_URL) {
  try {
    const Redis = require('ioredis');
    redis = new Redis(process.env.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 2 });
    redis.on('error', err => console.warn('[Redis]', err.message));
    console.log('[Redis] connected');
  } catch (e) {
    console.warn('[Redis] ioredis not available — using in-memory store');
    redis = null;
  }
}

const ROOM_TTL_SECS    = 86400;
const PAUSE_GRACE_MS   = 30000;
const CLEANUP_INTERVAL = 5 * 60 * 1000;
const FINISHED_TTL_MS  = 60 * 60 * 1000;
const IDLE_TTL_MS      = 30 * 60 * 1000;

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  WIKIPEDIA SUGGEST CACHE + ENDPOINT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const suggestCache = {};
const SUGGEST_TTL_MS  = 10 * 60 * 1000; // 10 minutes
const SUGGEST_MAX     = 200;

app.get('/api/suggest', (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ suggestions: [] });

  const key = q.toLowerCase();
  const now = Date.now();
  const cached = suggestCache[key];
  if (cached && now < cached.expiresAt) {
    return res.json({ suggestions: cached.suggestions });
  }

  const url = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(q)}&limit=8&namespace=0&format=json&origin=*`;

  const request = https.get(url, { headers: { 'User-Agent': 'CelebrityGame/1.0 (party game autocomplete; contact via github.com/xozai/celebrity-game-claude)' } }, (wikiRes) => {
    let raw = '';
    wikiRes.on('data', chunk => { raw += chunk; });
    wikiRes.on('end', () => {
      try {
        const data = JSON.parse(raw);
        const suggestions = (data[1] || []).slice(0, 5);

        // Evict oldest entry if at capacity
        const keys = Object.keys(suggestCache);
        if (keys.length >= SUGGEST_MAX) {
          let oldestKey = keys[0];
          for (const k of keys) {
            if (suggestCache[k].expiresAt < suggestCache[oldestKey].expiresAt) oldestKey = k;
          }
          delete suggestCache[oldestKey];
        }

        suggestCache[key] = { suggestions, expiresAt: now + SUGGEST_TTL_MS };
        res.json({ suggestions });
      } catch {
        res.json({ suggestions: [] });
      }
    });
  });

  request.setTimeout(3000, () => { request.destroy(); });
  request.on('error', () => res.json({ suggestions: [] }));
});

const rooms    = {};
const ipCounts = {};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  REDIS HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function getRoom(code) {
  if (rooms[code]) return rooms[code];
  if (!redis)      return null;
  try {
    const json = await redis.get(`room:${code}`);
    if (!json) return null;
    const room = JSON.parse(json);
    room.timer      = null;
    room.pauseTimer = null;
    rooms[code] = room;
    if (room.turnActive && room.timerEnd) {
      const remaining = room.timerEnd - Date.now();
      if (remaining > 0) {
        room.timer = setTimeout(() => handleTurnExpiry(code), remaining);
      } else {
        setImmediate(() => handleTurnExpiry(code));
      }
    }
    return room;
  } catch { return null; }
}

async function saveRoom(room) {
  rooms[room.code] = room;
  if (!redis) return;
  try {
    const { timer, pauseTimer, ...toStore } = room;
    await redis.set(`room:${room.code}`, JSON.stringify(toStore), 'EX', ROOM_TTL_SECS);
  } catch { /* ignore */ }
}

async function deleteRoom(code) {
  const room = rooms[code];
  if (room) {
    if (room.timer)      clearTimeout(room.timer);
    if (room.pauseTimer) clearTimeout(room.pauseTimer);
    delete rooms[code];
  }
  if (redis) try { await redis.del(`room:${code}`); } catch { /* ignore */ }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  UTILITIES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Only real players (not spectators) count for teams / submissions
function teamPlayers(room, teamIdx) {
  return room.players.filter(p => p.team === teamIdx && p.role !== 'spectator');
}

function currentPlayer(room) {
  const t = teamPlayers(room, room.currentTeamIdx);
  if (!t.length) return null;
  return t[room.playerTurnIdx[room.currentTeamIdx] % t.length];
}

function publicState(room) {
  const cp = currentPlayer(room);
  const t0 = teamPlayers(room, 0);
  const t1 = teamPlayers(room, 1);
  return {
    code:              room.code,
    host:              room.host,
    players:           room.players.map(p => ({ ...p, teamIdx: p.team })),
    phase:             room.phase,
    round:             room.round,
    currentTeamIdx:    room.currentTeamIdx,
    pileCount:         room.pile.length + (room.currentSlip !== null ? 1 : 0),
    scores:            room.scores,
    turnActive:        room.turnActive,
    timerEnd:          room.timerEnd,
    currentPlayerId:   cp?.id ?? null,
    currentPlayerName: cp?.name ?? null,
    teamSlipsCount: {
      '0': t0.filter(p => p.submitted).length,
      '1': t1.filter(p => p.submitted).length,
    },
    // Feature 1: use stored team names instead of computed from player names
    teamNames:       room.teamNames ?? ['Team 1', 'Team 2'],
    celebsPerPlayer: room.celebsPerPlayer ?? 3,
    // Feature 2: variable turn duration
    turnDuration:    room.turnDuration ?? 60,
    // Feature 3: game history
    history:         room.history ?? {},
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  RATE LIMITING
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function isRateLimited(ip) {
  if (process.env.TEST_MODE) return false;
  const now = Date.now();
  const e   = ipCounts[ip];
  if (!e || now > e.resetAt) {
    ipCounts[ip] = { count: 1, resetAt: now + 3_600_000 };
    return false;
  }
  if (e.count >= 5) return true;
  e.count++;
  return false;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GAME LOGIC
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function finalizeTurn(room) {
  // Feature 3: record history BEFORE mutating turn state
  const cp        = currentPlayer(room);
  const slipsGotten  = [...room.teamSlipsThisTurn];
  const skippedCount = room.skipsThisTurn ?? 0;
  const teamIdx      = room.currentTeamIdx;
  const round        = room.round;

  if (!room.history[round]) room.history[round] = [];
  room.history[round].push({
    teamIdx,
    playerName: cp?.name ?? '?',
    slips: slipsGotten,
  });

  room.turnActive   = false;
  room.timerEnd     = null;
  room.pausedPlayer = null;
  if (room.timer)      { clearTimeout(room.timer);      room.timer      = null; }
  if (room.pauseTimer) { clearTimeout(room.pauseTimer); room.pauseTimer = null; }

  room.scores[teamIdx][round] += slipsGotten.length;
  room.teamSlipsThisTurn = [];
  room.skipsThisTurn     = 0;
  room.playerTurnIdx[teamIdx]++;
  room.currentTeamIdx = teamIdx === 0 ? 1 : 0;

  const roundOver = room.pile.length === 0 && room.currentSlip === null;
  room.lastActivity = Date.now();

  if (roundOver) {
    if (round === 3) {
      room.phase = 'finished';
      await saveRoom(room);
      const s0 = Object.values(room.scores[0]).reduce((a, b) => a + b, 0);
      const s1 = Object.values(room.scores[1]).reduce((a, b) => a + b, 0);
      const winner = s0 > s1 ? 0 : s1 > s0 ? 1 : null;
      io.to(room.code).emit('game_ended', {
        scores: room.scores, players: room.players, winner,
        lastTurnSlips: slipsGotten, lastTeamIdx: teamIdx,
        gameState: publicState(room),
      });
    } else {
      await saveRoom(room);
      io.to(room.code).emit('round_ended', {
        round, scores: room.scores,
        lastTurnSlips: slipsGotten, lastTeamIdx: teamIdx,
        gameState: publicState(room),
      });
    }
  } else {
    await saveRoom(room);
    io.to(room.code).emit('turn_ended', {
      slipsGotten, teamIdx, scores: room.scores,
      got: slipsGotten.length, skipped: skippedCount,
      pileCount: room.pile.length,
      gameState: publicState(room),
    });
  }
}

async function handleTurnExpiry(roomCode) {
  const room = rooms[roomCode] ?? await getRoom(roomCode);
  if (!room || !room.turnActive) return;
  if (room.currentSlip !== null) {
    room.pile.push(room.currentSlip);
    room.currentSlip = null;
  }
  await finalizeTurn(room);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SOCKET.IO HANDLERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

io.on('connection', (socket) => {

  // ── create_room ────────────────────────────────────────────────────
  socket.on('create_room', async (data) => {
    const playerName = (typeof data === 'string' ? data : data?.playerName ?? '').trim();
    if (!playerName) return socket.emit('error_msg', { msg: 'Enter your name.' });

    const ip = (socket.handshake.headers['x-forwarded-for'] || '').split(',')[0].trim()
             || socket.handshake.address;
    if (isRateLimited(ip)) {
      return socket.emit('error_msg', { msg: 'Too many rooms. Try again in an hour.' });
    }

    let code, attempts = 0;
    do {
      code = genCode(); attempts++;
    } while ((rooms[code] || (redis && await redis.exists(`room:${code}`))) && attempts < 20);

    const room = {
      code, host: socket.id,
      players: [{ id: socket.id, name: playerName, team: null, submitted: false, connected: true, role: 'player' }],
      phase: 'lobby', round: 0, currentTeamIdx: 0,
      playerTurnIdx: [0, 0], allSlips: [], pile: [],
      currentSlip: null, teamSlipsThisTurn: [], skipsThisTurn: 0,
      scores: { 0: { 1: 0, 2: 0, 3: 0 }, 1: { 1: 0, 2: 0, 3: 0 } },
      celebsPerPlayer: 3,
      // Feature 1: custom team names
      teamNames: ['Team 1', 'Team 2'],
      // Feature 2: variable turn duration
      turnDuration: 60,
      // Feature 3: game history
      history: {},
      timer: null, pauseTimer: null, pausedPlayer: null,
      timerEnd: null, turnActive: false, lastActivity: Date.now(),
    };

    await saveRoom(room);
    socket.join(code);
    socket.data.roomCode   = code;
    socket.data.playerName = playerName;
    socket.emit('room_created', { roomCode: code, gameState: publicState(room) });
  });

  // ── join_room ──────────────────────────────────────────────────────
  socket.on('join_room', async (...args) => {
    let playerName, roomCode;
    if (args.length >= 2 && typeof args[0] === 'string') {
      playerName = args[0].trim();
      roomCode   = (args[1] || '').toUpperCase().trim();
    } else {
      const d    = args[0] || {};
      playerName = (d.playerName || '').trim();
      roomCode   = (d.roomCode   || '').toUpperCase().trim();
    }
    if (!playerName) return socket.emit('error_msg', { msg: 'Enter your name.' });

    const room = await getRoom(roomCode);
    if (!room) return socket.emit('error_msg', { msg: 'Room not found. Check the code.' });

    const existing = room.players.find(p => p.name.toLowerCase() === playerName.toLowerCase());

    // ── Reconnection path ──────────────────────────────────────────
    if (existing) {
      // Restore host if this player had it before disconnecting
      const wasHost = existing.wasHost === true || room.host === existing.id;
      existing.id        = socket.id;
      existing.connected = true;
      existing.wasHost   = false;
      if (wasHost) room.host = socket.id;

      socket.join(roomCode);
      socket.data.roomCode   = roomCode;
      socket.data.playerName = playerName;

      // If turn was paused waiting for THIS player, resume it
      if (room.pausedPlayer === playerName && room.turnActive && room.timerEnd) {
        room.pausedPlayer = null;
        if (room.pauseTimer) { clearTimeout(room.pauseTimer); room.pauseTimer = null; }
        const remaining = room.timerEnd - Date.now();
        if (remaining > 0) {
          room.timer = setTimeout(() => handleTurnExpiry(roomCode), remaining);
        }
        socket.emit('your_slip', { slip: room.currentSlip });
      }

      // Feature 5: if turn is active and it's their turn (not paused), resend slip
      if (room.phase === 'playing' && room.turnActive && room.currentSlip !== null
          && room.pausedPlayer !== playerName) {
        const cp = currentPlayer(room);
        if (cp && cp.name === playerName) {
          socket.emit('your_slip', { slip: room.currentSlip });
        }
      }

      room.lastActivity = Date.now();
      await saveRoom(room);
      socket.emit('state_update', { gameState: publicState(room) });
      socket.to(roomCode).emit('state_update', { gameState: publicState(room) });
      return;
    }

    // ── New player ─────────────────────────────────────────────────
    // Feature 4: allow joining mid-game as spectator
    const role = room.phase === 'lobby' ? 'player' : 'spectator';
    room.players.push({ id: socket.id, name: playerName, team: null, submitted: false, connected: true, role });
    socket.join(roomCode);
    socket.data.roomCode   = roomCode;
    socket.data.playerName = playerName;

    room.lastActivity = Date.now();
    await saveRoom(room);
    socket.emit('room_joined', { gameState: publicState(room) });
    socket.to(roomCode).emit('player_joined', {
      player: room.players.at(-1), gameState: publicState(room),
    });
  });

  // ── set_teams ──────────────────────────────────────────────────────
  socket.on('set_teams', async (data) => {
    const room = await getRoom(socket.data.roomCode);
    if (!room || room.host !== socket.id || room.phase !== 'lobby') return;

    let assignments = {};
    if (Array.isArray(data)) {
      data.forEach((ids, idx) => (ids || []).forEach(id => { assignments[id] = idx; }));
    } else {
      assignments = data?.assignments ?? {};
    }

    room.players.forEach(p => { if (p.id in assignments) p.team = assignments[p.id]; });
    room.lastActivity = Date.now();
    await saveRoom(room);
    io.to(room.code).emit('state_update', { gameState: publicState(room) });
  });

  // ── Feature 1: set_team_name ───────────────────────────────────────
  socket.on('set_team_name', async (data) => {
    const room = await getRoom(socket.data.roomCode);
    if (!room || room.host !== socket.id || room.phase !== 'lobby') return;
    const teamIdx = typeof data?.teamIdx === 'number' ? data.teamIdx : null;
    if (teamIdx !== 0 && teamIdx !== 1) return;
    const name = (data?.name ?? '').trim().slice(0, 20);
    if (!name) return;
    room.teamNames[teamIdx] = name;
    room.lastActivity = Date.now();
    await saveRoom(room);
    io.to(room.code).emit('state_update', { gameState: publicState(room) });
  });

  // ── set_celebs_per_player ──────────────────────────────────────────
  socket.on('set_celebs_per_player', async (data) => {
    const room = await getRoom(socket.data.roomCode);
    if (!room || room.host !== socket.id || room.phase !== 'lobby') return;
    const count = typeof data === 'number' ? data : (data?.count ?? 3);
    room.celebsPerPlayer = Math.min(10, Math.max(1, Math.floor(count)));
    room.lastActivity = Date.now();
    await saveRoom(room);
    io.to(room.code).emit('state_update', { gameState: publicState(room) });
  });

  // ── Feature 2: set_turn_duration ───────────────────────────────────
  socket.on('set_turn_duration', async (data) => {
    const room = await getRoom(socket.data.roomCode);
    if (!room || room.host !== socket.id || room.phase !== 'lobby') return;
    const secs = typeof data === 'number' ? data : (data?.seconds ?? 60);
    if (![30, 60, 90].includes(secs)) return;
    room.turnDuration = secs;
    room.lastActivity = Date.now();
    await saveRoom(room);
    io.to(room.code).emit('state_update', { gameState: publicState(room) });
  });

  // ── start_game ─────────────────────────────────────────────────────
  socket.on('start_game', async () => {
    const room = await getRoom(socket.data.roomCode);
    if (!room || room.host !== socket.id || room.phase !== 'lobby') return;
    if (!teamPlayers(room, 0).length || !teamPlayers(room, 1).length) {
      return socket.emit('error_msg', { msg: 'Both teams need at least one player.' });
    }
    room.phase = 'submitting';
    room.lastActivity = Date.now();
    await saveRoom(room);
    io.to(room.code).emit('phase_changed', { phase: 'submitting', gameState: publicState(room) });
  });

  // ── submit_celebrities ─────────────────────────────────────────────
  socket.on('submit_celebrities', async (data) => {
    const room = await getRoom(socket.data.roomCode);
    if (!room || room.phase !== 'submitting') return;
    const player = room.players.find(p => p.id === socket.id);
    // Feature 4: spectators cannot submit
    if (!player || player.submitted || player.role === 'spectator') return;

    const rawNames = Array.isArray(data) ? data : (data?.names ?? []);
    const required = room.celebsPerPlayer ?? 3;
    const cleaned  = rawNames.map(n => (n || '').trim()).filter(Boolean);
    if (cleaned.length !== required) {
      return socket.emit('error_msg', { msg: `Enter all ${required} celebrity names.` });
    }

    cleaned.forEach(n => room.allSlips.push(n));
    player.submitted = true;
    player.slips     = cleaned; // kept for retraction

    // Feature 4: only count non-spectator players for allDone
    const allDone = room.players.filter(p => p.role !== 'spectator').every(p => p.submitted);
    room.lastActivity = Date.now();
    await saveRoom(room);
    io.to(room.code).emit('state_update', { gameState: publicState(room) });

    if (allDone) {
      room.phase          = 'playing';
      room.round          = 1;
      room.pile           = shuffle([...room.allSlips]);
      room.currentTeamIdx = 0;
      room.playerTurnIdx  = [0, 0];
      await saveRoom(room);
      io.to(room.code).emit('round_starting', {
        round: 1, totalSlips: room.pile.length,
        gameState: publicState(room),
      });
    }
  });

  // ── retract_submission ────────────────────────────────────────────
  socket.on('retract_submission', async () => {
    const room = await getRoom(socket.data.roomCode);
    if (!room || room.phase !== 'submitting') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.submitted) return;

    if (player.slips) {
      // Remove each of this player's slips from allSlips (one occurrence each)
      const remaining = [...room.allSlips];
      for (const slip of player.slips) {
        const idx = remaining.indexOf(slip);
        if (idx !== -1) remaining.splice(idx, 1);
      }
      room.allSlips = remaining;
    }
    player.submitted = false;
    player.slips     = null;
    room.lastActivity = Date.now();
    await saveRoom(room);
    io.to(room.code).emit('state_update', { gameState: publicState(room) });
  });

  // ── reset_room ────────────────────────────────────────────────────
  socket.on('reset_room', async () => {
    const room = await getRoom(socket.data.roomCode);
    if (!room || room.host !== socket.id || room.phase !== 'finished') return;

    if (room.timer)      { clearTimeout(room.timer);      room.timer      = null; }
    if (room.pauseTimer) { clearTimeout(room.pauseTimer); room.pauseTimer = null; }

    room.phase             = 'lobby';
    room.round             = 0;
    room.allSlips          = [];
    room.pile              = [];
    room.currentSlip       = null;
    room.teamSlipsThisTurn = [];
    room.skipsThisTurn     = 0;
    room.scores            = { 0: { 1: 0, 2: 0, 3: 0 }, 1: { 1: 0, 2: 0, 3: 0 } };
    room.history           = {};
    room.turnActive        = false;
    room.timerEnd          = null;
    room.currentTeamIdx    = 0;
    room.playerTurnIdx     = [0, 0];
    room.pausedPlayer      = null;
    room.players.forEach(p => { p.submitted = false; p.slips = null; });
    room.lastActivity      = Date.now();
    await saveRoom(room);
    io.to(room.code).emit('room_reset', { gameState: publicState(room) });
  });

  // ── start_turn ─────────────────────────────────────────────────────
  socket.on('start_turn', async () => {
    const room = await getRoom(socket.data.roomCode);
    if (!room || room.phase !== 'playing' || room.turnActive) return;
    // Feature 4: spectators cannot start turns
    const player = room.players.find(p => p.id === socket.id);
    if (player?.role === 'spectator') return;
    const cp = currentPlayer(room);
    if (!cp || cp.id !== socket.id || !room.pile.length) return;

    const dur = (room.turnDuration ?? 60) * 1000;
    const slip = room.pile.pop();
    room.currentSlip       = slip;
    room.turnActive        = true;
    room.teamSlipsThisTurn = [];
    room.skipsThisTurn     = 0;
    room.timerEnd          = Date.now() + dur;
    room.lastActivity      = Date.now();
    await saveRoom(room);

    socket.emit('your_slip', { slip });
    io.to(room.code).emit('turn_started', {
      playerId: socket.id, playerName: cp.name,
      teamIdx: room.currentTeamIdx, timerEnd: room.timerEnd,
      pileCount: room.pile.length + 1,
      gameState: publicState(room),
    });
    room.timer = setTimeout(() => handleTurnExpiry(room.code), dur);
  });

  // ── got_it ─────────────────────────────────────────────────────────
  socket.on('got_it', async () => {
    const room = await getRoom(socket.data.roomCode);
    if (!room || !room.turnActive) return;
    // Feature 4: spectators cannot interact with slips
    const player = room.players.find(p => p.id === socket.id);
    if (player?.role === 'spectator') return;
    const cp = currentPlayer(room);
    if (!cp || cp.id !== socket.id) return;

    const slip = room.currentSlip;
    room.teamSlipsThisTurn.push(slip);
    io.to(room.code).emit('slip_correct', {
      slip, count: room.teamSlipsThisTurn.length, pileCount: room.pile.length,
    });

    if (!room.pile.length) {
      room.currentSlip = null;
      if (room.timer) { clearTimeout(room.timer); room.timer = null; }
      await saveRoom(room);
      await finalizeTurn(room);
      return;
    }

    const next = room.pile.pop();
    room.currentSlip  = next;
    room.lastActivity = Date.now();
    await saveRoom(room);
    socket.emit('your_slip', { slip: next });
  });

  // ── skip_slip ──────────────────────────────────────────────────────
  socket.on('skip_slip', async () => {
    const room = await getRoom(socket.data.roomCode);
    if (!room || !room.turnActive) return;
    // Feature 4: spectators cannot skip
    const player = room.players.find(p => p.id === socket.id);
    if (player?.role === 'spectator') return;
    const cp = currentPlayer(room);
    if (!cp || cp.id !== socket.id || room.pile.length === 0) return;

    room.skipsThisTurn = (room.skipsThisTurn ?? 0) + 1;
    room.pile.unshift(room.currentSlip);
    const next = room.pile.pop();
    room.currentSlip = next;
    await saveRoom(room);
    socket.emit('your_slip', { slip: next });
    io.to(room.code).emit('slip_skipped', { pileCount: room.pile.length + 1 });
  });

  // ── start_next_round ───────────────────────────────────────────────
  socket.on('start_next_round', async () => {
    const room = await getRoom(socket.data.roomCode);
    if (!room) return;
    if (room.host !== socket.id) return;
    if (room.turnActive) return;
    const next = room.round + 1;
    if (next > 3) return;
    room.round             = next;
    room.pile              = shuffle([...room.allSlips]);
    room.currentSlip       = null;
    room.teamSlipsThisTurn = [];
    room.skipsThisTurn     = 0;
    room.lastActivity      = Date.now();
    await saveRoom(room);
    io.to(room.code).emit('round_starting', {
      round: next, totalSlips: room.pile.length,
      gameState: publicState(room),
    });
  });

  // ── Feature 6: transfer_host ───────────────────────────────────────
  socket.on('transfer_host', async (data) => {
    const room = await getRoom(socket.data.roomCode);
    if (!room || room.host !== socket.id) return;
    const targetId = data?.targetPlayerId;
    const target   = room.players.find(p => p.id === targetId && p.connected);
    if (!target) return;
    room.host = targetId;
    room.lastActivity = Date.now();
    await saveRoom(room);
    io.to(room.code).emit('host_changed', { newHostId: targetId, newHostName: target.name });
    io.to(room.code).emit('state_update', { gameState: publicState(room) });
  });

  // ── disconnect ─────────────────────────────────────────────────────
  socket.on('disconnect', async () => {
    const code       = socket.data.roomCode;
    const playerName = socket.data.playerName;
    const room       = await getRoom(code);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      // Remember if this player was host so we can restore on reconnect
      if (room.host === socket.id) player.wasHost = true;
      player.connected = false;
      player.id = null;
    }

    const connected = room.players.filter(p => p.connected);

    if (!connected.length) {
      room.lastActivity = Date.now();
      await saveRoom(room);
      return;
    }

    // Feature 6: emit host_changed when host is auto-reassigned
    if (player?.wasHost) {
      room.host = connected[0].id;
      const newHost = connected[0];
      io.to(code).emit('host_changed', { newHostId: newHost.id, newHostName: newHost.name });
    }

    const wasCurrentPlayer = currentPlayer(room)?.name === playerName;

    if (wasCurrentPlayer && room.turnActive) {
      room.pausedPlayer = playerName;
      if (room.timer) { clearTimeout(room.timer); room.timer = null; }

      room.pauseTimer = setTimeout(async () => {
        const r = rooms[code] ?? await getRoom(code);
        if (!r || !r.turnActive || r.pausedPlayer !== playerName) return;
        if (r.currentSlip !== null) { r.pile.push(r.currentSlip); r.currentSlip = null; }
        await finalizeTurn(r);
      }, PAUSE_GRACE_MS);
    }

    room.lastActivity = Date.now();
    await saveRoom(room);
    io.to(code).emit('player_left', { playerId: socket.id, gameState: publicState(room) });
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ROOM CLEANUP JOB
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

setInterval(async () => {
  const now = Date.now();
  const shouldDelete = (room) => {
    const age     = now - (room.lastActivity ?? 0);
    const allGone = room.players.every(p => !p.connected);
    return (room.phase === 'finished' && age > FINISHED_TTL_MS)
        || (allGone && age > IDLE_TTL_MS);
  };

  if (redis) {
    try {
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', 'room:*', 'COUNT', 100);
        cursor = next;
        for (const key of keys) {
          const json = await redis.get(key);
          if (!json) continue;
          const room = JSON.parse(json);
          if (shouldDelete(room)) await deleteRoom(room.code);
        }
      } while (cursor !== '0');
    } catch { /* ignore */ }
  } else {
    for (const [code, room] of Object.entries(rooms)) {
      if (shouldDelete(room)) await deleteRoom(code);
    }
  }
}, CLEANUP_INTERVAL);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  START
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const PORT = process.env.PORT || 3030;
server.listen(PORT, () => console.log(`Celebrity game running on port ${PORT}`));
