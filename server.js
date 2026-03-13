const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

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

function publicState(room) {
  const cp = currentPlayer(room);
  const t0 = teamPlayers(room, 0);
  const t1 = teamPlayers(room, 1);
  return {
    code: room.code,
    host: room.host,
    players: room.players,
    phase: room.phase,
    round: room.round,
    currentTeamIdx: room.currentTeamIdx,
    pileCount: room.pile.length + (room.currentSlip !== null ? 1 : 0),
    scores: room.scores,
    turnActive: room.turnActive,
    timerEnd: room.timerEnd,
    currentPlayerId: cp?.id ?? null,
    currentPlayerName: cp?.name ?? null,
    teamSlipsCount: room.teamSlipsThisTurn.length,
    teamNames: [
      t0.map(p => p.name).join(', ') || 'Team 1',
      t1.map(p => p.name).join(', ') || 'Team 2',
    ],
  };
}

function finalizeTurn(room) {
  room.turnActive = false;
  room.timerEnd = null;
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }

  const slipsGotten = [...room.teamSlipsThisTurn];
  const teamIdx = room.currentTeamIdx;
  const round = room.round;

  room.scores[teamIdx][round] += slipsGotten.length;
  room.teamSlipsThisTurn = [];
  room.playerTurnIdx[teamIdx]++;
  room.currentTeamIdx = teamIdx === 0 ? 1 : 0;

  const roundOver = room.pile.length === 0 && room.currentSlip === null;

  if (roundOver) {
    if (round === 3) {
      room.phase = 'finished';
      io.to(room.code).emit('game_ended', {
        scores: room.scores,
        players: room.players,
        lastTurnSlips: slipsGotten,
        lastTeamIdx: teamIdx,
        gameState: publicState(room),
      });
    } else {
      io.to(room.code).emit('round_ended', {
        round,
        scores: room.scores,
        lastTurnSlips: slipsGotten,
        lastTeamIdx: teamIdx,
        gameState: publicState(room),
      });
    }
  } else {
    io.to(room.code).emit('turn_ended', {
      slipsGotten,
      teamIdx,
      scores: room.scores,
      gameState: publicState(room),
    });
  }
}

function handleTurnExpiry(roomCode) {
  const room = rooms[roomCode];
  if (!room || !room.turnActive) return;
  if (room.currentSlip !== null) {
    room.pile.push(room.currentSlip);
    room.currentSlip = null;
  }
  finalizeTurn(room);
}

io.on('connection', (socket) => {
  socket.on('create_room', ({ playerName }) => {
    let code;
    do { code = genCode(); } while (rooms[code]);

    rooms[code] = {
      code,
      host: socket.id,
      players: [{ id: socket.id, name: playerName, team: null, submitted: false }],
      phase: 'lobby',
      round: 0,
      currentTeamIdx: 0,
      playerTurnIdx: [0, 0],
      allSlips: [],
      pile: [],
      currentSlip: null,
      teamSlipsThisTurn: [],
      scores: { 0: { 1: 0, 2: 0, 3: 0 }, 1: { 1: 0, 2: 0, 3: 0 } },
      timer: null,
      timerEnd: null,
      turnActive: false,
    };

    socket.join(code);
    socket.data.roomCode = code;
    socket.emit('room_created', { roomCode: code, gameState: publicState(rooms[code]) });
  });

  socket.on('join_room', ({ roomCode, playerName }) => {
    const code = (roomCode || '').toUpperCase().trim();
    const room = rooms[code];
    if (!room) return socket.emit('error_msg', { msg: 'Room not found. Check the code.' });
    if (room.phase !== 'lobby') return socket.emit('error_msg', { msg: 'Game already started.' });
    const existing = room.players.find(p => p.name.toLowerCase() === playerName.toLowerCase());
    if (existing) return socket.emit('error_msg', { msg: 'That name is taken in this room.' });

    const player = { id: socket.id, name: playerName, team: null, submitted: false };
    room.players.push(player);
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit('room_joined', { gameState: publicState(room) });
    socket.to(code).emit('player_joined', { player, gameState: publicState(room) });
  });

  socket.on('set_teams', ({ assignments }) => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.host !== socket.id || room.phase !== 'lobby') return;
    room.players.forEach(p => {
      if (p.id in assignments) p.team = assignments[p.id];
    });
    io.to(room.code).emit('state_update', { gameState: publicState(room) });
  });

  socket.on('start_game', () => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.host !== socket.id || room.phase !== 'lobby') return;
    if (!teamPlayers(room, 0).length || !teamPlayers(room, 1).length) {
      return socket.emit('error_msg', { msg: 'Both teams need at least one player.' });
    }
    room.phase = 'submitting';
    io.to(room.code).emit('phase_changed', { phase: 'submitting', gameState: publicState(room) });
  });

  socket.on('submit_celebrities', ({ names }) => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.phase !== 'submitting') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.submitted) return;
    const cleaned = (names || []).map(n => (n || '').trim()).filter(Boolean);
    if (cleaned.length !== 3) return socket.emit('error_msg', { msg: 'Enter all 3 celebrity names.' });

    cleaned.forEach(n => room.allSlips.push(n));
    player.submitted = true;

    const allDone = room.players.every(p => p.submitted);
    io.to(room.code).emit('state_update', { gameState: publicState(room) });

    if (allDone) {
      room.phase = 'playing';
      room.round = 1;
      room.pile = shuffle([...room.allSlips]);
      room.currentTeamIdx = 0;
      room.playerTurnIdx = [0, 0];
      io.to(room.code).emit('round_starting', {
        round: 1,
        totalSlips: room.pile.length,
        gameState: publicState(room),
      });
    }
  });

  socket.on('start_turn', () => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.phase !== 'playing' || room.turnActive) return;
    const cp = currentPlayer(room);
    if (!cp || cp.id !== socket.id || !room.pile.length) return;

    const slip = room.pile.pop();
    room.currentSlip = slip;
    room.turnActive = true;
    room.teamSlipsThisTurn = [];
    room.timerEnd = Date.now() + 60000;

    socket.emit('your_slip', { slip });
    io.to(room.code).emit('turn_started', {
      playerId: socket.id,
      playerName: cp.name,
      teamIdx: room.currentTeamIdx,
      timerEnd: room.timerEnd,
      pileCount: room.pile.length + 1,
      gameState: publicState(room),
    });

    room.timer = setTimeout(() => handleTurnExpiry(room.code), 60000);
  });

  socket.on('got_it', () => {
    const room = rooms[socket.data.roomCode];
    if (!room || !room.turnActive) return;
    const cp = currentPlayer(room);
    if (!cp || cp.id !== socket.id) return;

    const slip = room.currentSlip;
    room.teamSlipsThisTurn.push(slip);

    io.to(room.code).emit('slip_correct', {
      slip,
      count: room.teamSlipsThisTurn.length,
      pileCount: room.pile.length,
    });

    if (!room.pile.length) {
      room.currentSlip = null;
      if (room.timer) { clearTimeout(room.timer); room.timer = null; }
      finalizeTurn(room);
      return;
    }

    const next = room.pile.pop();
    room.currentSlip = next;
    socket.emit('your_slip', { slip: next });
  });

  socket.on('skip_slip', () => {
    const room = rooms[socket.data.roomCode];
    if (!room || !room.turnActive) return;
    const cp = currentPlayer(room);
    if (!cp || cp.id !== socket.id) return;
    if (room.pile.length === 0) return;

    room.pile.unshift(room.currentSlip);
    const next = room.pile.pop();
    room.currentSlip = next;
    socket.emit('your_slip', { slip: next });
    io.to(room.code).emit('slip_skipped', { pileCount: room.pile.length + 1 });
  });

  socket.on('start_next_round', () => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.host !== socket.id || room.turnActive) return;
    const next = room.round + 1;
    if (next > 3) return;
    room.round = next;
    room.pile = shuffle([...room.allSlips]);
    room.currentSlip = null;
    room.teamSlipsThisTurn = [];
    io.to(room.code).emit('round_starting', {
      round: next,
      totalSlips: room.pile.length,
      gameState: publicState(room),
    });
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room) return;

    const wasCurrentPlayer = currentPlayer(room)?.id === socket.id;
    room.players = room.players.filter(p => p.id !== socket.id);

    if (!room.players.length) {
      if (room.timer) clearTimeout(room.timer);
      delete rooms[code];
      return;
    }

    if (room.host === socket.id) room.host = room.players[0].id;

    if (wasCurrentPlayer && room.turnActive) {
      if (room.timer) { clearTimeout(room.timer); room.timer = null; }
      if (room.currentSlip !== null) {
        room.pile.push(room.currentSlip);
        room.currentSlip = null;
      }
      finalizeTurn(room);
    }

    io.to(code).emit('player_left', { playerId: socket.id, gameState: publicState(room) });
  });
});

const PORT = process.env.PORT || 3030;
server.listen(PORT, () => console.log(`Celebrity game running at http://localhost:${PORT}`));
