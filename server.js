'use strict';
const express = require('express');
const http    = require('http');
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

const ROOM_TTL_SECS   = 86400;    // 24 h
const PAUSE_GRACE_MS  = 30000;    // 30 s reconnect window for disconnected player
const CLEANUP_INTERVAL = 5 * 60 * 1000;
const FINISHED_TTL_MS  = 60 * 60 * 1000;   // 1 h
const IDLE_TTL_MS      = 30 * 60 * 1000;   // 30 min all-disconnected

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory cache (timer handles live here; persistent state in Redis) ─
const rooms    = {};   // code -> room (includes .timer / .pauseTimer handles)
const ipCounts = {};   // ip   -> { count, resetAt }

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
    // Reconstruct server-side timer if turn was still active when server last stopped
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

function teamPlayers(room, teamIdx) {
  return room.players.filter(p => p.team === teamIdx);
}

function currentPlayer(room) {
  const t = teamPlayers(room, room.currentTeamIdx);
  if (!t.length) return null;
  return t[room.playerTurnIdx[room.currentTeamIdx] % t.length];
}

// publicState: shape understood by BOTH web (game.js) and iOS (GameViewModel.swift)
// – adds `teamIdx` alias alongside `team` for iOS Player model
// – teamSlipsCount is { "0": n, "1": n } (iOS expects [String: Int]?)
function publicState(room) {
  const cp = currentPlayer(room);
  const t0 = teamPlayers(room, 0);
  const t1 = teamPlayers(room, 1);
  return {
    code:              room.code,
    host:              room.host,
    // include teamIdx (iOS) alongside team (web) so both clients decode correctly
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
    // submitted counts per team for SubmitView progress display
    teamSlipsCount: {
      '0': t0.filter(p => p.submitted).length,
      '1': t1.filter(p => p.submitted).length,
    },
    teamNames: [
      t0.map(p => p.name).join(', ') || 'Team 1',
      t1.map(p => p.name).join(', ') || 'Team 2',
    ],
    celebsPerPlayer: room.celebsPerPlayer ?? 3,
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  RATE LIMITING  (5 rooms / IP / hour)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function isRateLimited(ip) {
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
  room.turnActive   = false;
  room.timerEnd     = null;
  room.pausedPlayer = null;
  if (room.timer)      { clearTimeout(room.timer);      room.timer      = null; }
  if (room.pauseTimer) { clearTimeout(room.pauseTimer); room.pauseTimer = null; }

  const slipsGotten  = [...room.teamSlipsThisTurn];
  const skippedCount = room.skipsThisTurn ?? 0;
  const teamIdx      = room.currentTeamIdx;
  const round        = room.round;

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
    // Include got/skipped/pileCount at top level for iOS TurnEndedData model
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
  // Web:  { playerName }     iOS: plain string
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
      players: [{ id: socket.id, name: playerName, team: null, submitted: false, connected: true }],
      phase: 'lobby', round: 0, currentTeamIdx: 0,
      playerTurnIdx: [0, 0], allSlips: [], pile: [],
      currentSlip: null, teamSlipsThisTurn: [], skipsThisTurn: 0,
      scores: { 0: { 1: 0, 2: 0, 3: 0 }, 1: { 1: 0, 2: 0, 3: 0 } },
      celebsPerPlayer: 3,
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
  // Web:  single arg { roomCode, playerName }
  // iOS:  single arg { roomCode, playerName }  (fixed in GameViewModel)
  //       OR two args (playerName, roomCode) for backward compat
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
      const wasHost    = room.host === existing.id;
      existing.id      = socket.id;
      existing.connected = true;
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

      room.lastActivity = Date.now();
      await saveRoom(room);
      socket.emit('state_update', { gameState: publicState(room) });
      socket.to(roomCode).emit('state_update', { gameState: publicState(room) });
      return;
    }

    // ── New player — only allowed in lobby ─────────────────────────
    if (room.phase !== 'lobby') {
      return socket.emit('error_msg', { msg: 'Game already started.' });
    }

    room.players.push({ id: socket.id, name: playerName, team: null, submitted: false, connected: true });
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
  // Web:  { assignments: { socketId: teamIdx } }
  // iOS:  [[team0Ids], [team1Ids]]
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
  // Web: { names: [...] }   iOS: direct array
  socket.on('submit_celebrities', async (data) => {
    const room = await getRoom(socket.data.roomCode);
    if (!room || room.phase !== 'submitting') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.submitted) return;

    const rawNames = Array.isArray(data) ? data : (data?.names ?? []);
    const required = room.celebsPerPlayer ?? 3;
    const cleaned  = rawNames.map(n => (n || '').trim()).filter(Boolean);
    if (cleaned.length !== required) {
      return socket.emit('error_msg', { msg: `Enter all ${required} celebrity names.` });
    }

    cleaned.forEach(n => room.allSlips.push(n));
    player.submitted = true;

    const allDone = room.players.every(p => p.submitted);
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

  // ── start_turn ─────────────────────────────────────────────────────
  socket.on('start_turn', async () => {
    const room = await getRoom(socket.data.roomCode);
    if (!room || room.phase !== 'playing' || room.turnActive) return;
    const cp = currentPlayer(room);
    if (!cp || cp.id !== socket.id || !room.pile.length) return;

    const slip = room.pile.pop();
    room.currentSlip       = slip;
    room.turnActive        = true;
    room.teamSlipsThisTurn = [];
    room.skipsThisTurn     = 0;
    room.timerEnd          = Date.now() + 60000;
    room.lastActivity      = Date.now();
    await saveRoom(room);

    socket.emit('your_slip', { slip });
    io.to(room.code).emit('turn_started', {
      playerId: socket.id, playerName: cp.name,
      teamIdx: room.currentTeamIdx, timerEnd: room.timerEnd,
      pileCount: room.pile.length + 1,
      gameState: publicState(room),
    });
    room.timer = setTimeout(() => handleTurnExpiry(room.code), 60000);
  });

  // ── got_it ─────────────────────────────────────────────────────────
  socket.on('got_it', async () => {
    const room = await getRoom(socket.data.roomCode);
    if (!room || !room.turnActive) return;
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
    if (!room || room.host !== socket.id || room.turnActive) return;
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

  // ── disconnect ─────────────────────────────────────────────────────
  socket.on('disconnect', async () => {
    const code       = socket.data.roomCode;
    const playerName = socket.data.playerName;
    const room       = await getRoom(code);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (player) { player.connected = false; player.id = null; }

    const connected = room.players.filter(p => p.connected);

    if (!connected.length) {
      // All gone — persist and let cleanup job remove after inactivity TTL
      room.lastActivity = Date.now();
      await saveRoom(room);
      return;
    }

    // Reassign host if needed
    if (room.host === socket.id) room.host = connected[0].id;

    const wasCurrentPlayer = currentPlayer(room)?.name === playerName;

    if (wasCurrentPlayer && room.turnActive) {
      // Pause turn — give player 30 s to reconnect before finalizing
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
//  ROOM CLEANUP JOB  (runs every 5 minutes)
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
