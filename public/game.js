/* =====================================================================
   game.js  –  client-side logic for Celebrity party game
   ===================================================================== */

const APP_VERSION = '1.0.0';

const socket = io();

// ── Local state ──────────────────────────────────────────────────────
let myId          = null;
let myName        = null;
let gameState     = null;   // latest publicState from server
let currentSlip   = null;   // only set for the active clue-giver
let timerInterval = null;

// ── Round metadata ───────────────────────────────────────────────────
const ROUND_INFO = {
  1: { name: 'Say Anything', icon: '💬', desc: 'Describe the celebrity using any words — except the name itself.' },
  2: { name: 'One Word',     icon: '☝️',  desc: 'Describe the celebrity using only a single word.' },
  3: { name: 'Charades',    icon: '🎭', desc: 'Act it out — no words or sounds allowed!' },
};

// =====================================================================
//  SCREEN / OVERLAY HELPERS
// =====================================================================
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function showOverlay(id)  { document.getElementById(id).classList.add('active'); }
function hideOverlay(id)  { document.getElementById(id).classList.remove('active'); }

function showError(id, msg) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.classList.remove('hidden');
}
function hideError(id) { document.getElementById(id).classList.add('hidden'); }

// =====================================================================
//  TOAST
// =====================================================================
function showToast(msg, duration = 3000) {
  const old = document.getElementById('toast-msg');
  if (old) old.remove();
  const el = document.createElement('div');
  el.id = 'toast-msg';
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

// =====================================================================
//  HELPERS
// =====================================================================
function myPlayer()         { return gameState?.players.find(p => p.id === myId) ?? null; }
function myTeamIdx()        { return myPlayer()?.team ?? null; }
function isHost()           { return gameState?.host === myId; }
function isCurrentPlayer()  { return gameState?.currentPlayerId === myId; }
function isSpectator()      { return myPlayer()?.role === 'spectator'; }

function teamLabel(idx) {
  return gameState?.teamNames?.[idx] ?? `Team ${idx + 1}`;
}

function totalScore(scores, teamIdx) {
  if (!scores || scores[teamIdx] == null) return 0;
  return Object.values(scores[teamIdx]).reduce((a, b) => a + b, 0);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// =====================================================================
//  TIMER
// =====================================================================
function startClientTimer(timerEnd) {
  stopTimer();
  updateTimerDisplay(timerEnd);
  timerInterval = setInterval(() => updateTimerDisplay(timerEnd), 250);
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

function updateTimerDisplay(timerEnd) {
  const el = document.getElementById('timer-display');
  if (!el) return;
  const secsLeft = Math.max(0, Math.ceil((timerEnd - Date.now()) / 1000));
  el.textContent = secsLeft;
  el.className = 'timer-display';
  if (secsLeft <= 10) el.classList.add('danger');
  else if (secsLeft <= 20) el.classList.add('warn');
  if (secsLeft === 0) stopTimer();
}

// =====================================================================
//  FLASH ANIMATION (correct guess)
// =====================================================================
function flashCorrect() {
  const old = document.getElementById('flash-correct');
  if (old) old.remove();
  const el = document.createElement('div');
  el.id = 'flash-correct';
  el.className = 'flash-correct';
  document.body.appendChild(el);
}

// =====================================================================
//  HISTORY RENDER HELPER
// =====================================================================
function renderHistorySection(history) {
  if (!history || Object.keys(history).length === 0) return '';
  const rounds = Object.keys(history).map(Number).sort((a, b) => a - b);
  const roundsHtml = rounds.map(r => {
    const entries = history[r];
    if (!entries || !entries.length) return '';
    const info = ROUND_INFO[r] ?? { icon: '🎲', name: `Round ${r}` };
    const entriesHtml = entries.map(e => {
      const chips = e.slips.map(s => `<span class="history-chip">${escapeHtml(s)}</span>`).join('');
      return `<div class="history-entry">
        <div class="history-entry-player">${escapeHtml(e.playerName)} — ${escapeHtml(teamLabel(e.teamIdx))}</div>
        <div class="history-chips">${chips}</div>
      </div>`;
    }).join('');
    return `<div class="history-round">
      <div class="history-round-label">${info.icon} Round ${r}: ${info.name}</div>
      ${entriesHtml}
    </div>`;
  }).join('');

  return `<details class="history-section">
    <summary class="history-summary">Game history</summary>
    <div class="history-body">${roundsHtml}</div>
  </details>`;
}

// =====================================================================
//  LOBBY RENDER
// =====================================================================
function renderLobby() {
  const gs = gameState;
  document.getElementById('lobby-code').textContent = gs.code;

  const list = document.getElementById('lobby-players');
  list.innerHTML = '';

  gs.players.forEach(p => {
    const row = document.createElement('div');
    row.className = 'player-row' + (p.team === 0 ? ' team-0' : p.team === 1 ? ' team-1' : '');

    // Avatar (first letter)
    const av = document.createElement('div');
    av.className = 'player-avatar';
    av.textContent = p.name[0].toUpperCase();
    row.appendChild(av);

    // Name + tags
    const nameWrap = document.createElement('div');
    nameWrap.className = 'player-name-wrap';
    const nameEl = document.createElement('div');
    nameEl.className = 'player-display-name';
    nameEl.textContent = (p.id === gs.host ? '👑 ' : '') + p.name;
    nameWrap.appendChild(nameEl);

    const tags = document.createElement('div');
    tags.className = 'player-tags';
    if (p.id === gs.host) tags.innerHTML += '<span class="tag tag-host">Host</span>';
    if (p.id === myId)    tags.innerHTML += '<span class="tag tag-you">You</span>';
    if (p.role === 'spectator') tags.innerHTML += '<span class="tag tag-spectator">Spectator</span>';
    else if (p.team === 0)      tags.innerHTML += '<span class="tag tag-t0">' + escapeHtml(teamLabel(0)) + '</span>';
    else if (p.team === 1)      tags.innerHTML += '<span class="tag tag-t1">' + escapeHtml(teamLabel(1)) + '</span>';
    else                        tags.innerHTML += '<span class="tag tag-unassigned">Unassigned</span>';
    nameWrap.appendChild(tags);
    row.appendChild(nameWrap);

    // Team assign + make host buttons (host only)
    if (isHost()) {
      const btnGroup = document.createElement('div');
      btnGroup.className = 'team-assign-btns';
      [0, 1].forEach(tIdx => {
        const btn = document.createElement('button');
        btn.className = 'btn-assign' + (p.team === tIdx ? (tIdx === 0 ? ' active-t0' : ' active-t1') : '');
        btn.textContent = `T${tIdx + 1}`;
        btn.addEventListener('click', () => socket.emit('set_teams', { assignments: { [p.id]: tIdx } }));
        btnGroup.appendChild(btn);
      });

      // "Make Host" button for non-host players
      if (p.id !== gs.host) {
        const mkHost = document.createElement('button');
        mkHost.className = 'btn-make-host';
        mkHost.title = 'Make host';
        mkHost.textContent = '👑';
        mkHost.addEventListener('click', () => {
          if (confirm(`Make ${p.name} the host?`)) {
            socket.emit('transfer_host', { targetPlayerId: p.id });
          }
        });
        btnGroup.appendChild(mkHost);
      }

      row.appendChild(btnGroup);
    }

    list.appendChild(row);
  });

  // Host controls vs guest message
  const actions  = document.getElementById('lobby-actions');
  const guestMsg = document.getElementById('lobby-guest-msg');
  if (isHost()) {
    actions.classList.remove('hidden');
    guestMsg.classList.add('hidden');
    const t0 = gs.players.filter(p => p.team === 0).length;
    const t1 = gs.players.filter(p => p.team === 1).length;
    document.getElementById('btn-start-game').disabled = !(t0 >= 1 && t1 >= 1);

    // Celebs-per-player control
    let cpp = document.getElementById('celebs-per-player-row');
    if (!cpp) {
      cpp = document.createElement('div');
      cpp.id        = 'celebs-per-player-row';
      cpp.className = 'celebs-per-player-row';
      cpp.innerHTML =
        '<label class="celebs-label">Celebrities per player:</label>' +
        '<div class="celebs-counter">' +
          '<button class="btn-celebs" id="btn-celebs-dec">−</button>' +
          '<span id="celebs-count">3</span>' +
          '<button class="btn-celebs" id="btn-celebs-inc">+</button>' +
        '</div>';
      actions.insertBefore(cpp, actions.firstChild);
      document.getElementById('btn-celebs-dec').addEventListener('click', () => {
        const cur = gameState?.celebsPerPlayer ?? 3;
        if (cur > 1) socket.emit('set_celebs_per_player', { count: cur - 1 });
      });
      document.getElementById('btn-celebs-inc').addEventListener('click', () => {
        const cur = gameState?.celebsPerPlayer ?? 3;
        if (cur < 10) socket.emit('set_celebs_per_player', { count: cur + 1 });
      });
    }
    document.getElementById('celebs-count').textContent = gs.celebsPerPlayer ?? 3;

    // Turn duration control
    let tdRow = document.getElementById('turn-duration-row');
    if (!tdRow) {
      tdRow = document.createElement('div');
      tdRow.id        = 'turn-duration-row';
      tdRow.className = 'turn-duration-row';
      tdRow.innerHTML =
        '<label class="celebs-label">Turn duration:</label>' +
        '<div class="duration-btns">' +
          '<button class="btn-dur" data-secs="30">30s</button>' +
          '<button class="btn-dur" data-secs="60">60s</button>' +
          '<button class="btn-dur" data-secs="90">90s</button>' +
        '</div>';
      actions.insertBefore(tdRow, document.getElementById('btn-auto-split'));
      tdRow.querySelectorAll('.btn-dur').forEach(btn => {
        btn.addEventListener('click', () => {
          socket.emit('set_turn_duration', { seconds: parseInt(btn.dataset.secs, 10) });
        });
      });
    }
    // Highlight active duration
    tdRow.querySelectorAll('.btn-dur').forEach(btn => {
      btn.classList.toggle('active', parseInt(btn.dataset.secs, 10) === (gs.turnDuration ?? 60));
    });

    // Team name inputs
    let tnRow = document.getElementById('team-names-row');
    if (!tnRow) {
      tnRow = document.createElement('div');
      tnRow.id        = 'team-names-row';
      tnRow.className = 'team-names-row';
      tnRow.innerHTML =
        '<label class="celebs-label">Team names:</label>' +
        '<div class="team-name-inputs">' +
          '<input type="text" id="team-name-0" class="input team-name-input" maxlength="20" placeholder="Team 1">' +
          '<input type="text" id="team-name-1" class="input team-name-input" maxlength="20" placeholder="Team 2">' +
        '</div>';
      actions.insertBefore(tnRow, document.getElementById('celebs-per-player-row'));
      [0, 1].forEach(idx => {
        const inp = document.getElementById(`team-name-${idx}`);
        let debounce = null;
        inp.addEventListener('input', () => {
          clearTimeout(debounce);
          debounce = setTimeout(() => {
            socket.emit('set_team_name', { teamIdx: idx, name: inp.value.trim() });
          }, 400);
        });
      });
    }
    // Sync values (don't overwrite while focused)
    [0, 1].forEach(idx => {
      const inp = document.getElementById(`team-name-${idx}`);
      if (inp && document.activeElement !== inp) {
        inp.value = gs.teamNames?.[idx] ?? `Team ${idx + 1}`;
      }
    });

  } else {
    actions.classList.add('hidden');
    guestMsg.classList.remove('hidden');
    guestMsg.innerHTML =
      `Waiting for host to start… ` +
      `<span class="celebs-guest-note">(${gs.celebsPerPlayer ?? 3} celebrities each, ${gs.turnDuration ?? 60}s turns)</span>`;
  }
}

// =====================================================================
//  SUBMITTING RENDER
// =====================================================================
function renderSubmitting() {
  const me = myPlayer();
  if (!me) return;
  const n = gameState?.celebsPerPlayer ?? 3;

  if (me.submitted) {
    document.getElementById('submit-form-wrap').classList.add('hidden');
    const waiting = document.getElementById('submit-waiting');
    waiting.classList.remove('hidden');
    const statusList = document.getElementById('submit-status-list');
    statusList.innerHTML = '';
    gameState.players.forEach(p => {
      if (p.role === 'spectator') return;
      const div = document.createElement('div');
      div.className = 'submit-status-item' + (p.submitted ? ' done' : '');
      div.innerHTML = `<span class="check">${p.submitted ? '✅' : '⏳'}</span> ${escapeHtml(p.name)}`;
      statusList.appendChild(div);
    });
  } else {
    document.getElementById('submit-form-wrap').classList.remove('hidden');
    document.getElementById('submit-waiting').classList.add('hidden');

    const card = document.querySelector('#submit-form-wrap .card');
    if (card) {
      const sub = document.querySelector('#submit-form-wrap .section-sub');
      if (sub) sub.textContent = `Write ${n} names everyone would know — living or dead, real or fictional`;

      const btn = document.getElementById('btn-submit-celebs');
      card.querySelectorAll('.slip-input-row').forEach(el => el.remove());
      for (let i = 1; i <= n; i++) {
        const row = document.createElement('div');
        row.className = 'slip-input-row';
        row.innerHTML =
          `<span class="slip-num">${i}</span>` +
          `<input type="text" id="celeb-${i}" class="input" placeholder="Celebrity ${i}" maxlength="50" autocomplete="off">`;
        card.insertBefore(row, btn);
        const inp = row.querySelector('input');
        inp.addEventListener('keydown', e => {
          if (e.key === 'Enter') {
            if (i < n) document.getElementById(`celeb-${i + 1}`)?.focus();
            else submitCelebrities();
          }
        });
      }
    }
  }
}

// =====================================================================
//  GAME HEADER
// =====================================================================
function updateGameHeader() {
  const gs = gameState;
  const t0Label = document.querySelector('#screen-game .team-score-block.team-0-bg .team-score-label');
  const t1Label = document.querySelector('#screen-game .team-score-block.team-1-bg .team-score-label');
  if (t0Label) t0Label.textContent = teamLabel(0);
  if (t1Label) t1Label.textContent = teamLabel(1);
  document.getElementById('score-0').textContent    = totalScore(gs.scores, 0);
  document.getElementById('score-1').textContent    = totalScore(gs.scores, 1);
  document.getElementById('round-badge').textContent = `Round ${gs.round}`;
  const n = gs.pileCount;
  document.getElementById('pile-display').textContent = `${n} slip${n !== 1 ? 's' : ''} left`;
}

// =====================================================================
//  GAME MAIN AREA DISPATCH
// =====================================================================
function renderGameMain() {
  if (!gameState || gameState.phase !== 'playing') return;
  stopTimer();
  if (!gameState.turnActive) {
    renderPreTurn();
  } else if (isCurrentPlayer() && !isSpectator()) {
    renderClueGiver();
  } else {
    renderWatching();
  }
}

function roundRuleHtml(round) {
  const info = ROUND_INFO[round] ?? { icon: '🎲', name: 'Play', desc: '' };
  return `<div class="round-rule-card">
    <div class="round-rule-icon">${info.icon}</div>
    <div class="round-rule-name">${info.name}</div>
    <div class="round-rule-desc">${info.desc}</div>
  </div>`;
}

function renderPreTurn() {
  const gs   = gameState;
  const main = document.getElementById('game-main');

  if (isCurrentPlayer() && !isSpectator()) {
    const tIdx  = myTeamIdx() ?? 0;
    const tCls  = `team-${tIdx}`;
    main.innerHTML = `
      <div class="pre-turn-view">
        <div class="your-turn-msg">🎉 It's your turn!</div>
        <div class="pre-turn-team-badge ${tCls}">${teamLabel(tIdx)}</div>
        ${roundRuleHtml(gs.round)}
        <button id="btn-start-turn" class="btn btn-primary btn-block">Start My Turn</button>
      </div>`;
    document.getElementById('btn-start-turn').addEventListener('click', () => socket.emit('start_turn'));
  } else {
    const cp   = gs.currentPlayerName ?? '…';
    const tIdx = gs.currentTeamIdx ?? 0;
    const tCls = `team-${tIdx}`;
    const specBadge = isSpectator() ? '<div class="spectator-badge">👁 Spectating</div>' : '';
    main.innerHTML = `
      <div class="pre-turn-view">
        ${specBadge}
        <div class="pre-turn-up-label">Up next:</div>
        <div class="pre-turn-player">${escapeHtml(cp)}</div>
        <div class="pre-turn-team-badge ${tCls}">${teamLabel(tIdx)}</div>
        ${roundRuleHtml(gs.round)}
        <div class="waiting-turn-msg">Waiting for them to start…</div>
      </div>`;
  }
}

function renderClueGiver() {
  const slip = currentSlip ?? '…';
  const info = ROUND_INFO[gameState?.round] ?? { name: 'Play' };
  const main = document.getElementById('game-main');
  main.innerHTML = `
    <div class="clue-giver-view">
      <div id="timer-display" class="timer-display">60</div>
      <div class="round-type-chip">${info.name}</div>
      <div class="celebrity-card">
        <div class="celebrity-name">${escapeHtml(slip)}</div>
      </div>
      <div class="action-btns">
        <button id="btn-got-it" class="btn-got-it">✓ Got it!</button>
        <button id="btn-skip" class="btn-skip">Skip →</button>
      </div>
    </div>`;

  document.getElementById('btn-got-it').addEventListener('click', () => {
    flashCorrect();
    socket.emit('got_it');
  });
  document.getElementById('btn-skip').addEventListener('click', () => socket.emit('skip_slip'));
}

function renderWatching() {
  const gs   = gameState;
  const cp   = gs.currentPlayerName ?? '…';
  const tIdx = gs.currentTeamIdx ?? 0;
  const tCls = `team-${tIdx}`;
  const specBadge = isSpectator() ? '<div class="spectator-badge">👁 Spectating</div>' : '';
  const main = document.getElementById('game-main');
  main.innerHTML = `
    <div class="watching-view">
      ${specBadge}
      <div id="timer-display" class="timer-display">60</div>
      <div class="watching-player-card">
        <div class="watching-player-name">${escapeHtml(cp)}</div>
        <div class="watching-team-label ${tCls}">${teamLabel(tIdx)}</div>
      </div>
      <div id="watching-slip-count" class="watching-slips-count">0</div>
      <div class="watching-slips-label">correct so far</div>
    </div>`;
}

// =====================================================================
//  OVERLAY RENDERERS
// =====================================================================
function showRoundIntroOverlay(round, prevScores) {
  const info = ROUND_INFO[round] ?? { name: 'Play', icon: '🎲', desc: '' };
  document.getElementById('oi-round-num').textContent  = `Round ${round}`;
  document.getElementById('oi-round-name').textContent = `${info.icon} ${info.name}`;
  document.getElementById('oi-round-desc').textContent = info.desc;

  const prevEl = document.getElementById('oi-prev-scores');
  if (round > 1 && prevScores) {
    prevEl.classList.remove('hidden');
    prevEl.innerHTML = '<div class="oi-prev-label">Scores so far</div>';
    [0, 1].forEach(tIdx => {
      const row = document.createElement('div');
      row.className = 'oi-score-row';
      const nameSpan = document.createElement('span');
      nameSpan.className = tIdx === 0 ? 'team-0-color' : 'team-1-color';
      nameSpan.textContent = teamLabel(tIdx);
      const pts = document.createElement('span');
      pts.textContent = totalScore(prevScores, tIdx);
      row.appendChild(nameSpan);
      row.appendChild(pts);
      prevEl.appendChild(row);
    });
  } else {
    prevEl.classList.add('hidden');
    prevEl.innerHTML = '';
  }

  showOverlay('overlay-round-intro');
}

function showTurnRecapOverlay(data) {
  const { slipsGotten, teamIdx, scores } = data;
  const tCls = `team-${teamIdx}`;

  document.getElementById('tr-team-label').className = `tr-team-label ${tCls}`;
  document.getElementById('tr-team-label').textContent = teamLabel(teamIdx);
  document.getElementById('tr-count').textContent =
    `Got ${slipsGotten.length} slip${slipsGotten.length !== 1 ? 's' : ''}`;

  const slipsEl = document.getElementById('tr-slips');
  slipsEl.innerHTML = '';
  slipsGotten.forEach(s => {
    const chip = document.createElement('span');
    chip.className = 'tr-slip-chip';
    chip.textContent = s;
    slipsEl.appendChild(chip);
  });

  document.getElementById('tr-score-0').textContent = totalScore(scores, 0);
  document.getElementById('tr-score-1').textContent = totalScore(scores, 1);

  showOverlay('overlay-turn-recap');
}

function showRoundEndOverlay(data) {
  const { round, scores, lastTurnSlips, lastTeamIdx } = data;

  document.getElementById('re-title').textContent = `Round ${round} Over!`;

  const lastEl = document.getElementById('re-last-slips');
  lastEl.innerHTML = '';
  if (lastTurnSlips && lastTurnSlips.length) {
    const label = document.createElement('div');
    label.className = 'tr-team-label team-' + lastTeamIdx;
    label.textContent = `${teamLabel(lastTeamIdx)} got ${lastTurnSlips.length} last slip${lastTurnSlips.length !== 1 ? 's' : ''}`;
    lastEl.appendChild(label);
    lastTurnSlips.forEach(s => {
      const chip = document.createElement('span');
      chip.className = 'tr-slip-chip';
      chip.textContent = s;
      lastEl.appendChild(chip);
    });
  }

  const scoresEl = document.getElementById('re-scores');
  scoresEl.innerHTML = '';
  for (let r = 1; r <= round; r++) {
    const row = document.createElement('div');
    row.className = 're-score-row';
    const roundLabel = document.createElement('div');
    roundLabel.className = 're-score-round';
    roundLabel.textContent = ROUND_INFO[r]?.name ?? `Round ${r}`;
    const vals = document.createElement('div');
    vals.className = 're-score-values';
    vals.innerHTML =
      `<span class="team-0-color">${scores[0]?.[r] ?? 0}</span>` +
      `<span class="re-score-sep">–</span>` +
      `<span class="team-1-color">${scores[1]?.[r] ?? 0}</span>`;
    row.appendChild(roundLabel);
    row.appendChild(vals);
    scoresEl.appendChild(row);
  }
  const totalRow = document.createElement('div');
  totalRow.className = 're-score-row re-score-total';
  const totalLabel = document.createElement('div');
  totalLabel.className = 're-score-round';
  totalLabel.textContent = 'Total';
  const totalVals = document.createElement('div');
  totalVals.className = 're-score-values';
  totalVals.innerHTML =
    `<span class="team-0-color">${totalScore(scores, 0)}</span>` +
    `<span class="re-score-sep">–</span>` +
    `<span class="team-1-color">${totalScore(scores, 1)}</span>`;
  totalRow.appendChild(totalLabel);
  totalRow.appendChild(totalVals);
  scoresEl.appendChild(totalRow);

  // History for this round
  const histEl = document.getElementById('re-history');
  if (histEl) {
    const history = gameState?.history;
    const entries = history?.[String(round)];
    if (entries && entries.length) {
      histEl.innerHTML = renderHistorySection({ [round]: entries });
      histEl.classList.remove('hidden');
    } else {
      histEl.classList.add('hidden');
    }
  }

  const btnNext  = document.getElementById('btn-re-next');
  const waiting  = document.getElementById('re-waiting');
  if (isHost()) {
    btnNext.textContent = `Start Round ${round + 1}`;
    btnNext.classList.remove('hidden');
    waiting.classList.add('hidden');
  } else {
    btnNext.classList.add('hidden');
    waiting.classList.remove('hidden');
  }

  showOverlay('overlay-round-end');
}

function showGameEndOverlay(data) {
  const { scores } = data;
  const s0 = totalScore(scores, 0);
  const s1 = totalScore(scores, 1);

  let winnerText, winnerCls;
  if (s0 > s1)      { winnerText = `${teamLabel(0)} Wins! 🏆`; winnerCls = 'ge-winner-t0'; }
  else if (s1 > s0) { winnerText = `${teamLabel(1)} Wins! 🏆`; winnerCls = 'ge-winner-t1'; }
  else              { winnerText = "It's a Tie! 🤝"; winnerCls = ''; }

  const winnerEl = document.getElementById('ge-winner');
  winnerEl.textContent = winnerText;
  winnerEl.className = `ge-winner ge-winner-row ${winnerCls}`;

  const scoresEl = document.getElementById('ge-scores');
  scoresEl.innerHTML = '';
  [0, 1].forEach(tIdx => {
    const row = document.createElement('div');
    row.className = 'ge-score-row';
    const teamEl = document.createElement('div');
    teamEl.className = `ge-score-team ${tIdx === 0 ? 'team-0-color' : 'team-1-color'}`;
    teamEl.textContent = teamLabel(tIdx);
    const totalEl = document.createElement('div');
    totalEl.className = 'ge-score-total';
    totalEl.textContent = totalScore(scores, tIdx);
    row.appendChild(teamEl);
    row.appendChild(totalEl);
    scoresEl.appendChild(row);
  });

  // Full game history
  const histEl = document.getElementById('ge-history');
  if (histEl) {
    const history = gameState?.history;
    if (history && Object.keys(history).length) {
      histEl.innerHTML = renderHistorySection(history);
      histEl.classList.remove('hidden');
    } else {
      histEl.classList.add('hidden');
    }
  }

  showOverlay('overlay-game-end');
}

// =====================================================================
//  ACTION FUNCTIONS
// =====================================================================
function createRoom() {
  const name = document.getElementById('player-name').value.trim();
  if (!name) { showError('home-error', 'Enter your name first.'); return; }
  hideError('home-error');
  myName = name;
  socket.emit('create_room', { playerName: name });
}

function joinRoom() {
  const name = document.getElementById('player-name').value.trim();
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  if (!name) { showError('home-error', 'Enter your name first.'); return; }
  if (!code) { showError('home-error', 'Enter a room code.'); return; }
  hideError('home-error');
  myName = name;
  socket.emit('join_room', { roomCode: code, playerName: name });
}

function autoSplit() {
  if (!gameState) return;
  const ids = gameState.players.map(p => p.id);
  const shuffled = ids.slice().sort(() => Math.random() - 0.5);
  const assignments = {};
  shuffled.forEach((id, i) => { assignments[id] = i % 2; });
  socket.emit('set_teams', { assignments });
}

function submitCelebrities() {
  const n     = gameState?.celebsPerPlayer ?? 3;
  const names = Array.from({ length: n }, (_, i) =>
    (document.getElementById(`celeb-${i + 1}`)?.value ?? '').trim()
  );
  if (names.some(v => !v)) {
    showError('submit-error', `Fill in all ${n} celebrity names.`);
    return;
  }
  hideError('submit-error');
  socket.emit('submit_celebrities', { names });
}

// =====================================================================
//  RECONNECTION BANNER
// =====================================================================
function showReconnectBanner() {
  if (document.getElementById('reconnect-banner')) return;
  const el = document.createElement('div');
  el.id = 'reconnect-banner';
  el.className = 'reconnect-banner';
  el.innerHTML = '<span class="reconnect-spinner">↻</span> Reconnecting…';
  document.body.appendChild(el);
}

function hideReconnectBanner() {
  document.getElementById('reconnect-banner')?.remove();
}

// =====================================================================
//  SOCKET EVENT HANDLERS
// =====================================================================
socket.on('connect', () => {
  myId = socket.id;
  hideReconnectBanner();
  if (gameState && myName) {
    socket.emit('join_room', { roomCode: gameState.code, playerName: myName });
  }
});

socket.on('disconnect', () => {
  if (gameState) showReconnectBanner();
});

socket.on('room_created', ({ roomCode, gameState: gs }) => {
  gameState = gs;
  showScreen('screen-lobby');
  renderLobby();
});

socket.on('room_joined', ({ gameState: gs }) => {
  gameState = gs;
  if (gs.phase === 'lobby') {
    showScreen('screen-lobby');
    renderLobby();
  } else if (gs.phase === 'submitting') {
    showScreen('screen-submitting');
    renderSubmitting();
  } else if (gs.phase === 'playing') {
    showScreen('screen-game');
    updateGameHeader();
    renderGameMain();
    if (gs.turnActive && gs.timerEnd) startClientTimer(gs.timerEnd);
  }
});

socket.on('player_joined', ({ gameState: gs }) => {
  gameState = gs;
  renderLobby();
});

socket.on('player_left', ({ gameState: gs }) => {
  gameState = gs;
  if (gs.phase === 'lobby') renderLobby();
});

socket.on('state_update', ({ gameState: gs }) => {
  gameState = gs;
  const active = document.querySelector('.screen.active')?.id;
  if (gs.phase === 'lobby') {
    if (active !== 'screen-lobby') showScreen('screen-lobby');
    renderLobby();
  } else if (gs.phase === 'submitting') {
    if (active !== 'screen-submitting') showScreen('screen-submitting');
    renderSubmitting();
  } else if (gs.phase === 'playing') {
    if (active !== 'screen-game') showScreen('screen-game');
    updateGameHeader();
    renderGameMain();
  }
});

socket.on('phase_changed', ({ phase, gameState: gs }) => {
  gameState = gs;
  if (phase === 'submitting') {
    showScreen('screen-submitting');
    renderSubmitting();
  }
});

socket.on('round_starting', ({ round, gameState: gs }) => {
  gameState = gs;
  showScreen('screen-game');
  updateGameHeader();
  renderGameMain();
  showRoundIntroOverlay(round, gs.scores);
});

socket.on('turn_started', ({ timerEnd, gameState: gs }) => {
  gameState = gs;
  updateGameHeader();
  renderGameMain();
  startClientTimer(timerEnd);
});

socket.on('your_slip', ({ slip }) => {
  currentSlip = slip;
  if (gameState?.phase === 'playing' && gameState.turnActive) {
    renderClueGiver();
    const el = document.getElementById('timer-display');
    if (el && gameState.timerEnd) updateTimerDisplay(gameState.timerEnd);
  }
});

socket.on('slip_correct', ({ count, pileCount }) => {
  const el = document.getElementById('watching-slip-count');
  if (el) el.textContent = count;
  const pile = document.getElementById('pile-display');
  if (pile) pile.textContent = `${pileCount} slip${pileCount !== 1 ? 's' : ''} left`;
});

socket.on('slip_skipped', ({ pileCount }) => {
  const pile = document.getElementById('pile-display');
  if (pile) pile.textContent = `${pileCount} slip${pileCount !== 1 ? 's' : ''} left`;
});

socket.on('turn_ended', ({ slipsGotten, teamIdx, scores, gameState: gs }) => {
  stopTimer();
  currentSlip = null;
  gameState = gs;
  updateGameHeader();
  renderGameMain();
  showTurnRecapOverlay({ slipsGotten, teamIdx, scores });
});

socket.on('round_ended', ({ round, scores, lastTurnSlips, lastTeamIdx, gameState: gs }) => {
  stopTimer();
  currentSlip = null;
  gameState = gs;
  updateGameHeader();
  showRoundEndOverlay({ round, scores, lastTurnSlips, lastTeamIdx });
});

socket.on('game_ended', ({ scores, lastTurnSlips, lastTeamIdx, gameState: gs }) => {
  stopTimer();
  currentSlip = null;
  gameState = gs;
  updateGameHeader();
  showGameEndOverlay({ scores, lastTurnSlips, lastTeamIdx });
});

socket.on('error_msg', ({ msg }) => {
  const screen = document.querySelector('.screen.active');
  if (!screen) return;
  if (screen.id === 'screen-home')       showError('home-error', msg);
  else if (screen.id === 'screen-lobby') showError('lobby-error', msg);
  else if (screen.id === 'screen-submitting') showError('submit-error', msg);
});

socket.on('host_changed', ({ newHostName }) => {
  showToast(`👑 ${newHostName} is now the host`);
  if (gameState) gameState.host = null; // will be updated by next state_update
  // Re-render lobby if visible
  const active = document.querySelector('.screen.active')?.id;
  if (active === 'screen-lobby') renderLobby();
});

// =====================================================================
//  BUTTON WIRING (runs after DOM ready)
// =====================================================================
document.addEventListener('DOMContentLoaded', () => {

  // ── Version label ──────────────────────────────────────────
  document.getElementById('version-label').textContent = `v${APP_VERSION}`;

  // ── Theme toggle ───────────────────────────────────────────
  const THEMES = ['system', 'light', 'dark'];
  const THEME_ICONS = { system: '🌐', light: '☀️', dark: '🌙' };

  function applyTheme(mode) {
    const html = document.documentElement;
    if (mode === 'system') {
      delete html.dataset.theme;
    } else {
      html.dataset.theme = mode;
    }
    localStorage.setItem('celebrity-theme', mode);
    document.getElementById('btn-theme').textContent = THEME_ICONS[mode];
  }

  // Init button icon from saved preference
  const savedTheme = localStorage.getItem('celebrity-theme') ?? 'system';
  document.getElementById('btn-theme').textContent = THEME_ICONS[savedTheme] ?? '🌐';

  document.getElementById('btn-theme').addEventListener('click', () => {
    const current = localStorage.getItem('celebrity-theme') ?? 'system';
    const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
    applyTheme(next);
  });

  // Home screen
  document.getElementById('btn-create').addEventListener('click', createRoom);
  document.getElementById('btn-join').addEventListener('click', joinRoom);

  document.getElementById('player-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') createRoom();
  });
  document.getElementById('join-code').addEventListener('keydown', e => {
    if (e.key === 'Enter') joinRoom();
  });
  document.getElementById('join-code').addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase();
  });

  // Lobby
  document.getElementById('btn-copy-code').addEventListener('click', () => {
    const code = document.getElementById('lobby-code').textContent;
    navigator.clipboard?.writeText(code).catch(() => {});
  });
  document.getElementById('btn-auto-split').addEventListener('click', autoSplit);
  document.getElementById('btn-start-game').addEventListener('click', () => {
    socket.emit('start_game');
  });

  // Submitting
  document.getElementById('btn-submit-celebs').addEventListener('click', submitCelebrities);
  [1, 2, 3].forEach(i => {
    document.getElementById(`celeb-${i}`).addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        if (i < 3) document.getElementById(`celeb-${i + 1}`).focus();
        else submitCelebrities();
      }
    });
  });

  // Round intro overlay
  document.getElementById('btn-oi-dismiss').addEventListener('click', () => {
    hideOverlay('overlay-round-intro');
  });

  // Turn recap overlay
  document.getElementById('btn-tr-done').addEventListener('click', () => {
    hideOverlay('overlay-turn-recap');
  });

  // Round end overlay
  document.getElementById('btn-re-next').addEventListener('click', () => {
    hideOverlay('overlay-round-end');
    socket.emit('start_next_round');
  });

  // Game end overlay
  document.getElementById('btn-play-again').addEventListener('click', () => {
    hideOverlay('overlay-game-end');
    showScreen('screen-home');
    gameState  = null;
    currentSlip = null;
    myId = socket.id;
  });
});
