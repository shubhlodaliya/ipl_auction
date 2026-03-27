// ============================================================
// RESULTS.JS — Final auction results display
// ============================================================

const reAuctionState = {
  roomCode: null,
  room: null,
  session: null,
  playersById: {},
  unsoldQueue: [],
  eligibleTeamIds: [],
  data: {},
  listeners: {}
};

const aiReviewState = {
  roomCode: null,
  session: null,
  maxSquadSize: 0,
  teamSquads: {},
  teams: {},
  latest: null
};

window.addEventListener('DOMContentLoaded', loadResults);
window.addEventListener('beforeunload', cleanupReAuctionListeners);
window.addEventListener('beforeunload', cleanupAiReviewListeners);

async function loadResults() {
  // Try to get roomCode from session, or from URL param
  const session = getSession();
  const params = new URLSearchParams(window.location.search);
  const roomCode = (session && session.roomCode) || params.get('room');

  if (!roomCode) {
    document.getElementById('loadingScreen').style.display = 'none';
    document.getElementById('resultsContent').style.display = 'block';
    document.getElementById('resultsGrid').innerHTML = `
      <div class="state-empty" style="grid-column:1/-1">
        <p>No auction data found.</p>
        <button class="btn btn-primary" onclick="newAuction()">Start New Auction</button>
      </div>`;
    return;
  }

  try {
    // Load all data
    const [roomSnap, playersData] = await Promise.all([
      db.ref(`rooms/${roomCode}`).get(),
      loadPlayers()
    ]);

    if (!roomSnap.exists()) {
      document.getElementById('loadingScreen').innerHTML = `<p style="color:var(--red)">Room data not found.</p>`;
      return;
    }

    const room = roomSnap.val();
    const playerMap = {};
    playersData.forEach(p => {
      playerMap[p.id] = p;
      playerMap[String(p.id)] = p;
    });

    const teams = room.teams || {};
    const soldPlayers = room.soldPlayers || {};
    const playerQueue = normalizeQueue(room.playerQueue);

    // Summary stats
    const totalSales = Object.values(soldPlayers).reduce((s, sp) => s + sp.soldPrice, 0);
    const soldCount = Object.keys(soldPlayers).length;
    const unsoldCount = buildUnsoldQueue(playerQueue, soldPlayers).length;

    document.getElementById('summaryStats').innerHTML = `
      <div class="glass" style="padding:0.8rem 1.5rem;text-align:center;">
        <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-sec)">Players Sold</div>
        <div style="font-family:'Rajdhani',sans-serif;font-weight:700;font-size:1.8rem;color:var(--gold)">${soldCount}</div>
      </div>
      <div class="glass" style="padding:0.8rem 1.5rem;text-align:center;">
        <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-sec)">Unsold</div>
        <div style="font-family:'Rajdhani',sans-serif;font-weight:700;font-size:1.8rem;color:var(--red)">${unsoldCount}</div>
      </div>
      <div class="glass" style="padding:0.8rem 1.5rem;text-align:center;">
        <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-sec)">Teams</div>
        <div style="font-family:'Rajdhani',sans-serif;font-weight:700;font-size:1.8rem;color:var(--blue)">${Object.keys(teams).length}</div>
      </div>
      <div class="glass" style="padding:0.8rem 1.5rem;text-align:center;">
        <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-sec)">Total Spent</div>
        <div style="font-family:'Rajdhani',sans-serif;font-weight:700;font-size:1.8rem;color:var(--green)">${formatPrice(totalSales)}</div>
      </div>
    `;

    // Build team squad map
    // soldPlayers: { playerId: { teamId, soldPrice } }
    const teamSquads = {}; // teamId → [ { player, price } ]
    Object.entries(soldPlayers).forEach(([pid, sale]) => {
      if (!teamSquads[sale.teamId]) teamSquads[sale.teamId] = [];
      const player = playerMap[pid];
      if (player) teamSquads[sale.teamId].push({ player, price: sale.soldPrice });
    });

    // Sort teams by total spend descending
    const sortedTeams = Object.entries(teams).sort((a, b) => {
      const spendA = (teamSquads[a[0]] || []).reduce((s, x) => s + x.price, 0);
      const spendB = (teamSquads[b[0]] || []).reduce((s, x) => s + x.price, 0);
      return spendB - spendA;
    });

    document.getElementById('resultsGrid').innerHTML = sortedTeams.map(([tId, team], idx) => {
      const t = getTeam(tId);
      const squad = (teamSquads[tId] || []).sort((a, b) => b.price - a.price);
      const totalSpend = squad.reduce((s, x) => s + x.price, 0);
      const remaining = team.purse;

      const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '';

      return `
        <div class="result-team-card fade-in" style="animation-delay:${idx * 0.07}s;--team-color:${t?.primary || '#888'}">
          <div class="result-team-header">
            <div class="result-team-emoji-wrap">
              ${t?.logo ? `<img class="result-team-logo" src="${t.logo}" alt="${team.short} logo" />` : `<div class="result-team-emoji">${team.short}</div>`}
              ${medal ? `<span class="result-medal">${medal}</span>` : ''}
            </div>
            <div class="result-team-info">
              <div class="result-team-name">${team.name}</div>
              <div class="result-owner-name">👤 ${team.ownerName}</div>
            </div>
            <div class="result-team-stats">
              <div>
                <span class="result-stat-val">${formatPrice(totalSpend)}</span>
                <span class="result-stat-label">Spent</span>
              </div>
              <div>
                <span class="result-stat-val">${squad.length}</span>
                <span class="result-stat-label">Players</span>
              </div>
            </div>
          </div>
          <div class="result-squad-list">
            ${squad.length === 0 ? `<div class="result-no-squad">No players purchased</div>` :
              squad.map(({ player, price }) => {
                const color = getRoleColor(player.role);
                const initials = getPlayerInitials(player.name);
                const icon = getRoleIcon(player.role);
                return `
                  <div class="result-player-row">
                    <div class="result-player-avatar" style="background:linear-gradient(135deg,${color}99,${color}44)">${initials}</div>
                    <div style="flex:1;">
                      <div class="result-player-name">${player.name}</div>
                      <div style="font-size:0.72rem;color:var(--text-dim)">${icon} ${player.role} · ${getCountryFlag(player.country)} ${player.country}</div>
                    </div>
                    <div class="result-player-price">${formatPrice(price)}</div>
                  </div>
                `;
              }).join('')
            }
          </div>
        </div>
      `;
    }).join('');

    // Update subtitle
    document.getElementById('resultsSub').textContent =
      `Room: ${roomCode} · ${soldCount} players sold across ${Object.keys(teams).length} teams`;

    setupReAuction(roomCode, room, session, playerMap, playerQueue, soldPlayers);
    setupAiReview(roomCode, room, session, teamSquads);

    document.getElementById('loadingScreen').style.display = 'none';
    document.getElementById('resultsContent').style.display = 'block';

  } catch (err) {
    console.error(err);
    document.getElementById('loadingScreen').innerHTML = `
      <p style="color:var(--red)">Failed to load results. <button class="btn btn-ghost" onclick="location.reload()">Retry</button></p>`;
  }
}

function setupAiReview(roomCode, room, session, teamSquads) {
  aiReviewState.roomCode = roomCode;
  aiReviewState.session = session || null;
  aiReviewState.maxSquadSize = room.config?.maxSquadSize || 0;
  aiReviewState.teamSquads = teamSquads || {};
  aiReviewState.teams = room.teams || {};
  aiReviewState.latest = null;
  renderAiReviewOutput();
}

function cleanupAiReviewListeners() {
  // No active listeners for backend-only AI flow.
}

function normalizeQueue(queue) {
  if (Array.isArray(queue)) return queue;
  return Object.values(queue || {});
}

function isSoldPlayer(soldPlayers, playerId) {
  return !!(soldPlayers?.[playerId] || soldPlayers?.[String(playerId)]);
}

function buildUnsoldQueue(playerQueue, soldPlayers) {
  return playerQueue.filter(pid => !isSoldPlayer(soldPlayers, pid));
}

function setupReAuction(roomCode, room, session, playerMap, playerQueue, soldPlayers) {
  cleanupReAuctionListeners();

  reAuctionState.roomCode = roomCode;
  reAuctionState.room = room;
  reAuctionState.session = session || null;
  reAuctionState.playersById = playerMap;
  reAuctionState.unsoldQueue = buildUnsoldQueue(playerQueue, soldPlayers);

  const teams = room.teams || {};
  const maxSquadSize = room.config?.maxSquadSize || 0;
  reAuctionState.eligibleTeamIds = Object.entries(teams)
    .filter(([, team]) => (team.squad || []).length < maxSquadSize)
    .map(([teamId]) => teamId);

  const section = document.getElementById('reAuctionSection');
  if (!section) return;

  section.style.display = 'block';

  reAuctionState.listeners.reAuction = db.ref(`rooms/${roomCode}/reAuction`).on('value', snap => {
    reAuctionState.data = snap.val() || {};
    renderReAuctionSection();
  });

  reAuctionState.listeners.status = db.ref(`rooms/${roomCode}/config/status`).on('value', snap => {
    if (snap.val() === 'auction') {
      window.location.href = 'auction.html';
    }
  });

  renderReAuctionSection();
}

function cleanupReAuctionListeners() {
  const { roomCode, listeners } = reAuctionState;
  if (!roomCode) return;
  if (listeners.reAuction) db.ref(`rooms/${roomCode}/reAuction`).off('value', listeners.reAuction);
  if (listeners.status) db.ref(`rooms/${roomCode}/config/status`).off('value', listeners.status);
  reAuctionState.listeners = {};
}

function openAiReviewModal() {
  const overlay = document.getElementById('aiReviewModalOverlay');
  if (overlay) overlay.classList.add('visible');
  generateAiReview();
}

function closeAiReviewModal() {
  const overlay = document.getElementById('aiReviewModalOverlay');
  if (overlay) overlay.classList.remove('visible');
}

function buildAiReviewPayload() {
  const { teams, teamSquads, maxSquadSize, roomCode } = aiReviewState;

  const teamData = Object.entries(teams).map(([teamId, team]) => {
    const squad = (teamSquads[teamId] || []).map(x => ({
      name: x.player.name,
      role: x.player.role,
      country: x.player.country,
      priceLakh: x.price
    }));

    return {
      teamId,
      name: team.name,
      short: team.short,
      ownerName: team.ownerName,
      purseLakh: team.purse || 0,
      squadCount: (team.squad || []).length,
      maxSquadSize,
      squad
    };
  });

  return {
    roomCode,
    teams: teamData
  };
}

async function generateAiReview() {
  const btn = document.getElementById('aiGenerateBtn');
  const payload = buildAiReviewPayload();

  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Generating...';
    }

    const meta = document.getElementById('aiReviewMeta');
    const output = document.getElementById('aiReviewOutput');
    if (meta) meta.textContent = 'Generating AI review from backend...';
    if (output) output.textContent = 'Please wait...';

    const resp = await fetch('/api/ai-review', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const json = await resp.json();
    const content = json?.text;

    if (!resp.ok || !content) {
      const errMsg = json?.error || 'AI response failed.';
      throw new Error(errMsg);
    }

    aiReviewState.latest = {
      text: content,
      model: json?.model || 'backend-model',
      generatedAt: Date.now(),
      generatedBy: aiReviewState.session?.teamId || 'viewer'
    };

    renderAiReviewOutput();
    showToast('AI review generated.', 'success');
  } catch (err) {
    console.error(err);
    aiReviewState.latest = null;
    renderAiReviewOutput();
    showToast(err.message || 'Failed to generate AI review.', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Generate Review';
    }
  }
}

function renderAiReviewOutput() {
  const meta = document.getElementById('aiReviewMeta');
  const output = document.getElementById('aiReviewOutput');
  if (!meta || !output) return;

  const latest = aiReviewState.latest;
  if (!latest) {
    meta.textContent = 'No AI review generated yet.';
    output.textContent = 'Click Generate Review to get best stable team analysis.';
    return;
  }

  const when = new Date(latest.generatedAt || Date.now()).toLocaleString();
  meta.textContent = `Generated by ${latest.generatedBy || 'user'} using ${latest.model || 'model'} at ${when}`;
  output.textContent = latest.text || 'No review text.';
}

function renderReAuctionSection() {
  const body = document.getElementById('reAuctionBody');
  const hint = document.getElementById('reAuctionHint');
  if (!body || !hint) return;

  const { room, session, unsoldQueue, eligibleTeamIds, data } = reAuctionState;
  const teams = room?.teams || {};
  const myTeamId = session?.teamId;
  const amHost = !!session?.isHost;
  const myEligible = !!myTeamId && eligibleTeamIds.includes(myTeamId);

  if (!unsoldQueue.length) {
    hint.textContent = 'No unsold players left. Re-auction is not needed.';
    body.innerHTML = `<div class="state-empty"><p>All players are sold.</p></div>`;
    return;
  }

  if (!eligibleTeamIds.length) {
    hint.textContent = 'All teams have full squads. Re-auction is not available.';
    body.innerHTML = `<div class="state-empty"><p>No team has an empty slot.</p></div>`;
    return;
  }

  const selections = data.selections || {};
  const readyMap = data.ready || {};

  const selectedUnion = new Set();
  eligibleTeamIds.forEach(teamId => {
    const teamSel = selections[teamId] || {};
    Object.keys(teamSel).forEach(pid => {
      if (teamSel[pid]) selectedUnion.add(String(pid));
    });
  });

  const selectedQueue = unsoldQueue.filter(pid => selectedUnion.has(String(pid)));
  const allReady = eligibleTeamIds.every(teamId => !!readyMap[teamId]);

  const teamReadyHtml = eligibleTeamIds.map(teamId => {
    const t = getTeam(teamId);
    const team = teams[teamId];
    const selectedCount = Object.keys(selections[teamId] || {}).filter(pid => (selections[teamId] || {})[pid]).length;
    const ready = !!readyMap[teamId];
    return `
      <div class="reauction-team-chip ${ready ? 'ready' : ''}">
        <span>${t?.short || team?.short || teamId} · ${team?.ownerName || 'Team'}</span>
        <span>${selectedCount} selected</span>
        <span>${ready ? 'Ready' : 'Pending'}</span>
      </div>
    `;
  }).join('');

  const mySelection = selections[myTeamId] || {};
  const mySelectedCount = Object.keys(mySelection).filter(pid => mySelection[pid]).length;
  const myReady = !!readyMap[myTeamId];

  const playerListHtml = unsoldQueue.map(pid => {
    const player = reAuctionState.playersById[pid] || reAuctionState.playersById[String(pid)];
    if (!player) return '';
    const checked = !!(mySelection[String(pid)] || mySelection[pid]);
    return `
      <label class="reauction-player-row ${checked ? 'selected' : ''}">
        <input type="checkbox" ${checked ? 'checked' : ''}
          onchange="toggleReAuctionPlayer('${String(pid)}')"
          ${myEligible ? '' : 'disabled'} />
        <span class="reauction-player-name">${player.name}</span>
        <span class="reauction-player-meta">${getRoleIcon(player.role)} ${player.role} · ${formatPrice(player.base_price_lakh)}</span>
      </label>
    `;
  }).join('');

  body.innerHTML = `
    <div class="reauction-status-grid">
      <div class="reauction-stat-card">
        <div class="reauction-stat-label">Unsold Players</div>
        <div class="reauction-stat-value">${unsoldQueue.length}</div>
      </div>
      <div class="reauction-stat-card">
        <div class="reauction-stat-label">Eligible Teams</div>
        <div class="reauction-stat-value">${eligibleTeamIds.length}</div>
      </div>
      <div class="reauction-stat-card">
        <div class="reauction-stat-label">Selected For Re-Auction</div>
        <div class="reauction-stat-value">${selectedQueue.length}</div>
      </div>
    </div>

    <div class="reauction-team-ready-list">${teamReadyHtml}</div>

    ${myEligible ? `
      <div class="reauction-controls">
        <span>Your selection: ${mySelectedCount}</span>
        <button class="btn ${myReady ? 'btn-secondary' : 'btn-primary'}" onclick="toggleReAuctionReady()">
          ${myReady ? 'Mark Pending' : 'Mark Ready'}
        </button>
      </div>
    ` : `<div class="reauction-note">Only teams with empty slots can select players.</div>`}

    <div class="reauction-player-list">${playerListHtml}</div>

    ${amHost ? `
      <div class="reauction-host-actions">
        <p>All teams ready: <strong>${allReady ? 'Yes' : 'No'}</strong></p>
        <button class="btn btn-primary btn-lg" onclick="startReAuctionFromResults()" ${(!allReady || selectedQueue.length === 0) ? 'disabled' : ''}>
          Start Re-Auction (${selectedQueue.length} players)
        </button>
      </div>
    ` : ''}
  `;

  hint.textContent = 'Teams with empty slots select unsold players, mark ready, then host starts re-auction.';
}

async function toggleReAuctionPlayer(playerId) {
  const { roomCode, session, eligibleTeamIds, data } = reAuctionState;
  if (!roomCode || !session?.teamId || !eligibleTeamIds.includes(session.teamId)) return;

  const teamId = session.teamId;
  const teamSelections = data.selections?.[teamId] || {};
  const isSelected = !!teamSelections[playerId];

  const updates = {};
  updates[`rooms/${roomCode}/reAuction/selections/${teamId}/${playerId}`] = isSelected ? null : true;
  updates[`rooms/${roomCode}/reAuction/ready/${teamId}`] = false;
  updates[`rooms/${roomCode}/reAuction/updatedAt`] = Date.now();
  await db.ref().update(updates);
}

async function toggleReAuctionReady() {
  const { roomCode, session, eligibleTeamIds, data } = reAuctionState;
  if (!roomCode || !session?.teamId || !eligibleTeamIds.includes(session.teamId)) return;

  const teamId = session.teamId;
  const ready = !!data.ready?.[teamId];

  if (!ready) {
    const selectedCount = Object.keys(data.selections?.[teamId] || {}).filter(pid => (data.selections?.[teamId] || {})[pid]).length;
    if (selectedCount === 0) {
      showToast('Select at least 1 player before marking ready.', 'error');
      return;
    }
  }

  await db.ref(`rooms/${roomCode}/reAuction/ready/${teamId}`).set(!ready);
  await db.ref(`rooms/${roomCode}/reAuction/updatedAt`).set(Date.now());
}

async function startReAuctionFromResults() {
  const { roomCode, session, playersById } = reAuctionState;
  if (!roomCode || !session?.isHost) return;

  const roomSnap = await db.ref(`rooms/${roomCode}`).get();
  if (!roomSnap.exists()) {
    showToast('Room not found.', 'error');
    return;
  }

  const room = roomSnap.val();
  const teams = room.teams || {};
  const soldPlayers = room.soldPlayers || {};
  const playerQueue = normalizeQueue(room.playerQueue);
  const unsoldQueue = buildUnsoldQueue(playerQueue, soldPlayers);
  const maxSquadSize = room.config?.maxSquadSize || 0;
  const eligibleTeamIds = Object.entries(teams)
    .filter(([, team]) => (team.squad || []).length < maxSquadSize)
    .map(([teamId]) => teamId);

  const reAuction = room.reAuction || {};
  const selections = reAuction.selections || {};
  const readyMap = reAuction.ready || {};

  const allReady = eligibleTeamIds.length > 0 && eligibleTeamIds.every(teamId => !!readyMap[teamId]);
  if (!allReady) {
    showToast('All eligible teams must be ready.', 'error');
    return;
  }

  const selectedUnion = new Set();
  eligibleTeamIds.forEach(teamId => {
    const teamSel = selections[teamId] || {};
    Object.keys(teamSel).forEach(pid => {
      if (teamSel[pid]) selectedUnion.add(String(pid));
    });
  });

  const selectedQueue = unsoldQueue.filter(pid => selectedUnion.has(String(pid)));
  if (!selectedQueue.length) {
    showToast('No players selected for re-auction.', 'error');
    return;
  }

  const firstPlayerId = selectedQueue[0];
  const firstPlayer = playersById[firstPlayerId] || playersById[String(firstPlayerId)];
  if (!firstPlayer) {
    showToast('Failed to load selected players.', 'error');
    return;
  }

  const now = Date.now();
  const timerSec = room.config?.timerSeconds || 30;
  const reAuctionRound = (room.config?.reAuctionRound || 0) + 1;

  const updates = {};
  updates[`rooms/${roomCode}/playerQueue`] = selectedQueue;
  updates[`rooms/${roomCode}/poolByIndex`] = {};
  updates[`rooms/${roomCode}/currentIndex`] = 0;
  updates[`rooms/${roomCode}/currentAuction`] = {
    playerId: firstPlayerId,
    currentBid: firstPlayer.base_price_lakh,
    highestBidder: null,
    poolId: null,
    poolLabel: null,
    skipVotes: {},
    poolSkipVotes: {},
    withdrawnTeams: {},
    timerEnd: now + timerSec * 1000,
    status: 'bidding'
  };
  updates[`rooms/${roomCode}/auctionControl`] = { paused: false, pausedAt: null };
  updates[`rooms/${roomCode}/config/status`] = 'auction';
  updates[`rooms/${roomCode}/config/reAuctionRound`] = reAuctionRound;
  updates[`rooms/${roomCode}/config/reAuctionStartedAt`] = now;
  updates[`rooms/${roomCode}/reAuction/started`] = true;
  updates[`rooms/${roomCode}/reAuction/startedAt`] = now;
  updates[`rooms/${roomCode}/reAuction/startedBy`] = session.teamId;

  await db.ref().update(updates);
}

function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'toast show ' + type;
  setTimeout(() => { t.className = 'toast'; }, 2400);
}

window.openAiReviewModal = openAiReviewModal;
window.closeAiReviewModal = closeAiReviewModal;
window.generateAiReview = generateAiReview;
window.toggleReAuctionPlayer = toggleReAuctionPlayer;
window.toggleReAuctionReady = toggleReAuctionReady;
window.startReAuctionFromResults = startReAuctionFromResults;
