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
  latest: null,
  loading: false
};

const resultsExportState = {
  roomCode: null,
  teams: {},
  sortedTeams: [],
  teamSquads: {},
  soldCount: 0,
  unsoldCount: 0,
  totalSales: 0,
  roomTeamCatalog: {}
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
    const roomSnap = await db.ref(`rooms/${roomCode}`).get();

    if (!roomSnap.exists()) {
      document.getElementById('loadingScreen').innerHTML = `<p style="color:var(--red)">Room data not found.</p>`;
      return;
    }

    const room = roomSnap.val();
    const isManualAuction = room.config?.auctionType === 'manual';
    const playersData = isManualAuction ? (room.manualPlayers || []) : await loadPlayers();
    const roomTeamCatalog = isManualAuction
      ? (room.manualTeams || {})
      : Object.fromEntries(IPL_TEAMS.map(t => [t.id, t]));
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

    resultsExportState.roomCode = roomCode;
    resultsExportState.teams = teams;
    resultsExportState.sortedTeams = sortedTeams;
    resultsExportState.teamSquads = teamSquads;
    resultsExportState.soldCount = soldCount;
    resultsExportState.unsoldCount = unsoldCount;
    resultsExportState.totalSales = totalSales;
    resultsExportState.roomTeamCatalog = roomTeamCatalog;
    updateTeamExportSelect(sortedTeams, roomCode);

    document.getElementById('resultsGrid').innerHTML = sortedTeams.map(([tId, team], idx) => {
      const t = roomTeamCatalog[tId] || getTeam(tId);
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
            <button class="btn btn-ghost result-export-card-btn" onclick="exportTeamPdfById('${tId}')" title="Download ${team.name} PDF" aria-label="Download ${team.name} PDF">
              <span class="result-export-icon">&#8681;</span>
              <span class="result-export-text">PDF</span>
            </button>
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
                      <div style="font-size:0.72rem;color:var(--text-dim)">${icon} ${player.role} · ${getCountryFlag(player.country)} ${player.country || 'Manual'}</div>
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
  if (aiReviewState.loading) return;
  aiReviewState.loading = true;
  const payload = buildAiReviewPayload();

  try {
    const output = document.getElementById('aiReviewOutput');
    if (output) output.innerHTML = buildAiLoadingSkeleton();

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
    aiReviewState.loading = false;
  }
}

function renderAiReviewOutput() {
  const output = document.getElementById('aiReviewOutput');
  if (!output) return;

  const latest = aiReviewState.latest;
  if (!latest) {
    output.innerHTML = `
      <div class="ai-review-card fade-in">
        <div class="ai-review-empty-title">AI Review</div>
        <p class="ai-review-empty-copy">Open this review to auto-generate team ranking and suggestions.</p>
      </div>
    `;
    return;
  }

  output.innerHTML = renderAiReviewHtml(latest.text || 'No review text.');
}

function renderAiReviewHtml(text) {
  const sections = parseAiSections(text);
  if (!sections.length) {
    return `
      <div class="ai-review-card fade-in">
        <p class="ai-review-paragraph">${escapeHtml(text || 'No review available.')}</p>
      </div>
    `;
  }

  return sections.map((section, idx) => `
    <section class="ai-review-card ai-review-section fade-in" style="animation-delay:${idx * 0.05}s">
      <h4>${escapeHtml(section.title)}</h4>
      ${renderAiSectionBlocks(section.title, section.lines)}
    </section>
  `).join('');
}

function parseAiSections(text) {
  const lines = String(text || '').split('\n').map(line => line.trim());
  const sections = [];
  let current = null;

  lines.forEach((line) => {
    if (!line) {
      if (current) current.lines.push('');
      return;
    }

    const headingMatch = line.match(/^(\d+)\)\s*(.+)$/);
    if (headingMatch) {
      if (current) sections.push(current);
      current = { title: headingMatch[2], lines: [] };
      return;
    }

    if (!current) current = { title: 'Review', lines: [] };
    current.lines.push(line);
  });

  if (current) sections.push(current);
  return sections;
}

function renderAiSectionBlocks(title, lines) {
  if (/team\s+rankings/i.test(title || '')) {
    const rankingHtml = renderAiRankingCards(lines);
    if (rankingHtml) return rankingHtml;
  }

  let html = '';
  let bulletBuffer = [];
  let numberedBuffer = [];

  function flushBullets() {
    if (!bulletBuffer.length) return;
    html += `<ul class="ai-review-list">${bulletBuffer.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
    bulletBuffer = [];
  }

  function flushNumbered() {
    if (!numberedBuffer.length) return;
    html += `<ol class="ai-review-numbered">${numberedBuffer.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ol>`;
    numberedBuffer = [];
  }

  lines.forEach((line) => {
    if (!line) {
      flushBullets();
      flushNumbered();
      return;
    }

    if (/^-\s+/.test(line)) {
      flushNumbered();
      bulletBuffer.push(line.replace(/^-\s+/, ''));
      return;
    }

    if (/^\d+\.\s+/.test(line)) {
      flushBullets();
      numberedBuffer.push(line.replace(/^\d+\.\s+/, ''));
      return;
    }

    flushBullets();
    flushNumbered();
    html += `<p class="ai-review-paragraph">${escapeHtml(line)}</p>`;
  });

  flushBullets();
  flushNumbered();
  return html;
}

function renderAiRankingCards(lines) {
  const rankPattern = /^(\d+)\.\s+(.+?)\s*[\-–]\s*Overall\s*([0-9.]+\/10)$/i;
  const cards = [];
  let current = null;

  lines.forEach((line) => {
    if (!line) return;

    const rankMatch = line.match(rankPattern);
    if (rankMatch) {
      if (current) cards.push(current);
      current = {
        rank: rankMatch[1],
        teamName: rankMatch[2],
        score: rankMatch[3],
        reasons: []
      };
      return;
    }

    const cleanLine = line.replace(/^[-•]\s*/, '').trim();
    if (current && cleanLine) {
      current.reasons.push(cleanLine);
    }
  });

  if (current) cards.push(current);
  if (!cards.length) return '';

  return `
    <div class="ai-ranking-grid">
      ${cards.map((card, idx) => `
        <details class="ai-rank-card">
          <summary>
            <span class="ai-rank-badge">#${escapeHtml(card.rank)}</span>
            <span class="ai-rank-team">${escapeHtml(card.teamName)}</span>
            <span class="ai-rank-score">${escapeHtml(card.score)}</span>
          </summary>
          <div class="ai-rank-reasons">
            ${card.reasons.length
              ? `<ul class="ai-review-list">${card.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>`
              : `<p class="ai-review-paragraph">No details available for this rank.</p>`}
          </div>
        </details>
      `).join('')}
    </div>
  `;
}

function buildAiLoadingSkeleton() {
  return `
    <div class="ai-review-card ai-review-loading">
      <div class="ai-skel-line w-40"></div>
      <div class="ai-skel-line w-90"></div>
      <div class="ai-skel-line w-85"></div>
      <div class="ai-skel-line w-70"></div>
      <div class="ai-skel-line w-92"></div>
      <div class="ai-skel-line w-66"></div>
    </div>
  `;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
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
    const team = teams[teamId];
    const selectedCount = Object.keys(selections[teamId] || {}).filter(pid => (selections[teamId] || {})[pid]).length;
    const ready = !!readyMap[teamId];
    return `
      <div class="reauction-team-chip ${ready ? 'ready' : ''}">
        <span>${team?.short || teamId} · ${team?.ownerName || 'Team'}</span>
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

function formatPricePdf(lakh) {
  return formatPrice(lakh)
    .replace('₹', 'INR ')
    .replace('Cr', ' Cr')
    .replace('L', ' L');
}

function updateTeamExportSelect(sortedTeams, roomCode) {
  const select = document.getElementById('teamExportSelect');
  if (!select) return;

  select.innerHTML = '<option value="">Select Team</option>';
  sortedTeams.forEach(([teamId, team]) => {
    const option = document.createElement('option');
    option.value = teamId;
    option.textContent = `${team.name} (${team.short || teamId.toUpperCase()})`;
    select.appendChild(option);
  });

  select.dataset.roomCode = roomCode;
}

function createPdfDocument() {
  return new window.jspdf.jsPDF({
    orientation: 'portrait',
    unit: 'pt',
    format: 'a4'
  });
}

function renderPdfHeader(doc, title, roomCode, generatedAt) {
  const pageWidth = doc.internal.pageSize.getWidth();
  doc.setFillColor(8, 20, 44);
  doc.rect(0, 0, pageWidth, 92, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.text(title, 40, 38);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.text(`Room: ${roomCode}`, 40, 58);
  doc.text(`Generated: ${generatedAt.toLocaleString()}`, 40, 74);
}

function appendPdfFooter(doc) {
  const pageCount = doc.internal.getNumberOfPages();
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    doc.setPage(pageNumber);
    doc.setTextColor(110, 120, 130);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text(`Page ${pageNumber} of ${pageCount}`, pageWidth - 40, pageHeight - 18, { align: 'right' });
  }
}

function renderAuctionSummaryTable(doc, teams, soldCount, unsoldCount, totalSales) {
  doc.setTextColor(28, 44, 66);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text('Auction Summary', 40, 120);

  doc.autoTable({
    startY: 132,
    margin: { left: 40, right: 40 },
    theme: 'grid',
    head: [['Metric', 'Value']],
    body: [
      ['Teams', String(Object.keys(teams).length)],
      ['Players Sold', String(soldCount)],
      ['Players Unsold', String(unsoldCount)],
      ['Total Spend', formatPricePdf(totalSales)]
    ],
    styles: { fontSize: 10, cellPadding: 6 },
    headStyles: { fillColor: [17, 94, 197] }
  });
}

function renderTeamSection(doc, teamId, team, squad, roomTeamCatalog, rank) {
  const pageHeight = doc.internal.pageSize.getHeight();
  const teamSpend = squad.reduce((sum, entry) => sum + entry.price, 0);
  const purseLeft = team.purse || 0;
  const t = roomTeamCatalog[teamId] || getTeam(teamId) || {};

  let startY = (doc.lastAutoTable?.finalY || 132) + 16;
  if (startY > pageHeight - 170) {
    doc.addPage();
    startY = 56;
  }

  const rankPrefix = typeof rank === 'number' ? `${rank}. ` : '';
  doc.setTextColor(13, 35, 64);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text(`${rankPrefix}${team.name} (${team.short || t.short || teamId})`, 40, startY);

  doc.autoTable({
    startY: startY + 8,
    margin: { left: 40, right: 40 },
    theme: 'grid',
    head: [['Owner', 'Players', 'Spent', 'Purse Left']],
    body: [[
      team.ownerName || '-',
      String(squad.length),
      formatPricePdf(teamSpend),
      formatPricePdf(purseLeft)
    ]],
    styles: { fontSize: 9.5, cellPadding: 5 },
    headStyles: { fillColor: [22, 93, 148] }
  });

  const rows = squad.length
    ? squad.map(({ player, price }, rowIndex) => [
        String(rowIndex + 1),
        player.name || '-',
        player.role || '-',
        player.country || 'Manual',
        formatPricePdf(price)
      ])
    : [['-', 'No players purchased', '-', '-', '-']];

  doc.autoTable({
    startY: doc.lastAutoTable.finalY + 8,
    margin: { left: 40, right: 40 },
    theme: 'striped',
    head: [['#', 'Player', 'Role', 'Country', 'Price']],
    body: rows,
    styles: { fontSize: 9, cellPadding: 5 },
    headStyles: { fillColor: [10, 87, 142] },
    columnStyles: {
      0: { cellWidth: 26 },
      1: { cellWidth: 195 },
      2: { cellWidth: 95 },
      3: { cellWidth: 110 },
      4: { halign: 'right' }
    }
  });
}

function exportResultsPdf() {
  const {
    roomCode,
    teams,
    sortedTeams,
    teamSquads,
    soldCount,
    unsoldCount,
    totalSales,
    roomTeamCatalog
  } = resultsExportState;

  if (!roomCode || !sortedTeams.length) {
    showToast('Results data is not ready yet.', 'error');
    return;
  }

  if (!window.jspdf || !window.jspdf.jsPDF) {
    showToast('PDF library failed to load. Please retry.', 'error');
    return;
  }

  const doc = createPdfDocument();
  const generatedAt = new Date();

  renderPdfHeader(doc, 'IPL Auction Report', roomCode, generatedAt);
  renderAuctionSummaryTable(doc, teams, soldCount, unsoldCount, totalSales);

  sortedTeams.forEach(([teamId, team], index) => {
    const squad = (teamSquads[teamId] || []).slice().sort((a, b) => b.price - a.price);
    renderTeamSection(doc, teamId, team, squad, roomTeamCatalog, index + 1);
  });

  appendPdfFooter(doc);

  const safeRoom = String(roomCode).replace(/[^a-zA-Z0-9-_]/g, '_');
  const datePart = generatedAt.toISOString().slice(0, 10);
  doc.save(`ipl-auction-${safeRoom}-${datePart}.pdf`);
}

function exportTeamPdfById(selectedTeamId) {
  const {
    roomCode,
    sortedTeams,
    teamSquads,
    roomTeamCatalog
  } = resultsExportState;

  if (!roomCode || !sortedTeams.length) {
    showToast('Results data is not ready yet.', 'error');
    return;
  }
  if (!selectedTeamId) {
    showToast('Please select a team first.', 'error');
    return;
  }
  if (!window.jspdf || !window.jspdf.jsPDF) {
    showToast('PDF library failed to load. Please retry.', 'error');
    return;
  }

  const selectedEntry = sortedTeams.find(([teamId]) => teamId === selectedTeamId);
  if (!selectedEntry) {
    showToast('Selected team not found.', 'error');
    return;
  }

  const [teamId, team] = selectedEntry;
  const squad = (teamSquads[teamId] || []).slice().sort((a, b) => b.price - a.price);
  const doc = createPdfDocument();
  const generatedAt = new Date();

  renderPdfHeader(doc, `${team.name} - Team Report`, roomCode, generatedAt);
  renderTeamSection(doc, teamId, team, squad, roomTeamCatalog);
  appendPdfFooter(doc);

  const safeRoom = String(roomCode).replace(/[^a-zA-Z0-9-_]/g, '_');
  const safeTeam = String(team.short || teamId).replace(/[^a-zA-Z0-9-_]/g, '_');
  const datePart = generatedAt.toISOString().slice(0, 10);
  doc.save(`ipl-auction-${safeRoom}-${safeTeam}-${datePart}.pdf`);
}

function exportSelectedTeamPdf() {
  const select = document.getElementById('teamExportSelect');
  const selectedTeamId = select ? select.value : '';
  exportTeamPdfById(selectedTeamId);
}

window.openAiReviewModal = openAiReviewModal;
window.closeAiReviewModal = closeAiReviewModal;
window.generateAiReview = generateAiReview;
window.toggleReAuctionPlayer = toggleReAuctionPlayer;
window.toggleReAuctionReady = toggleReAuctionReady;
window.startReAuctionFromResults = startReAuctionFromResults;
window.exportResultsPdf = exportResultsPdf;
window.exportTeamPdfById = exportTeamPdfById;
window.exportSelectedTeamPdf = exportSelectedTeamPdf;
