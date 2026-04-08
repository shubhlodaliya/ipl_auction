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

const playing11State = {
  roomCode: null,
  session: null,
  myTeamId: null,
  mySquad: [],
  playing11: [],
  captain: null,
  vice_captain: null,
  wicket_keeper: null,
  selectionScrollTop: 0,
  designationScrollTop: 0
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

const analystPromptTemplate = `You are an expert cricket analyst similar to Cricbuzz, ESPN, or professional IPL analysts.

I will provide a PDF generated from an IPL auction game.

The PDF contains multiple teams. Each team has:
1) A full squad list
2) A section called "Best Playing 11"

Your task is to analyze every team professionally and rank them from strongest to weakest.

IMPORTANT RULES:
- DO NOT change the playing XI.
- Use the "Best Playing 11" as the main team.
- Also analyze the remaining squad players as bench strength and backups.
- Compare teams against each other before ranking.

------------------------------------------------

STEP 1: EXTRACT DATA FROM THE PDF

For each team extract:

Team Name

BEST PLAYING XI
- Player Name
- Role (Batsman / Wicket Keeper / All-rounder / Bowler)
- Captain
- Vice Captain

FULL SQUAD
- All remaining players not included in the playing XI

------------------------------------------------

STEP 2: PROFESSIONAL TEAM ANALYSIS

Analyze the Best Playing XI first, then evaluate squad depth.

Evaluate the following aspects:

1) TOP ORDER STRENGTH
(Openers + No.3)

Consider:
- Powerplay dominance
- T20 strike rate ability
- Ability to handle swing and pressure

2) MIDDLE ORDER STABILITY
(No.4 - No.6)

Consider:
- Ability to rebuild innings
- Ability to handle pressure situations
- Rotation of strike

3) FINISHING POWER
(No.6 - No.8)

Consider:
- Big hitters
- Death overs acceleration
- Power hitting ability

4) BOWLING ATTACK

Evaluate:

Powerplay bowlers
Middle overs control
Death over specialists
Variety (pace + spin)

5) ALL-ROUNDER IMPACT

Evaluate players who contribute significantly in:

Batting
Bowling
Match situations

6) TEAM BALANCE

Ideal structure:

4-5 batsmen
1-2 wicket keepers
2-3 all-rounders
3-4 bowlers

Evaluate whether the team composition is balanced.

7) MATCH WINNERS

Identify players capable of winning matches single-handedly.

Examples:
- Elite finishers
- Game-changing bowlers
- Superstar performers

8) LEADERSHIP

Evaluate:

Captain's experience
Tactical decision making
Calmness under pressure

9) BENCH STRENGTH (NEW)

Analyze the remaining squad players.

Evaluate:

Quality backup batsmen
Backup bowlers
Backup wicket-keepers
Backup all-rounders
Injury replacements
Strategic flexibility

Determine whether the team has strong squad depth for a long tournament.

------------------------------------------------

STEP 3: SCORING SYSTEM

Score each team using this system:

Batting Strength: 25
Bowling Attack: 25
All-Rounders: 20
Team Balance: 10
Match Winners: 8
Leadership: 4
Bench Strength: 8

TOTAL SCORE: 100

------------------------------------------------

STEP 4: TEAM ANALYSIS OUTPUT

For each team provide analysis in the following format:

TEAM ANALYSIS

Team: <Team Name>

Best Playing XI:
1. Player - Role
2. Player - Role
3. Player - Role
...

Bench / Backup Players:
- Player
- Player
- Player
...

Strengths:
- ...
- ...
- ...

Weaknesses:
- ...
- ...

Score Breakdown:

Batting: /25
Bowling: /25
All-rounders: /20
Balance: /10
Match Winners: /8
Leadership: /4
Bench Strength: /8

Total Score: /100

------------------------------------------------

STEP 5: FINAL TEAM RANKING

After analyzing all teams, rank them from strongest to weakest.

Example:

FINAL TEAM POWER RANKINGS

1) Team Name - Score
2) Team Name - Score
3) Team Name - Score
4) Team Name - Score
5) Team Name - Score
6) Team Name - Score
7) Team Name - Score

------------------------------------------------

STEP 6: FINAL ANALYST VERDICT

Explain like a professional cricket analyst.

Include:

- Why Rank #1 team is the strongest
- Which team has the best batting lineup
- Which team has the best bowling attack
- Which team has the best bench strength
- Which team could be the dark horse of the tournament

Provide insights similar to Cricbuzz or ESPN expert analysis.`;

window.addEventListener('DOMContentLoaded', loadResults);
window.addEventListener('beforeunload', cleanupReAuctionListeners);

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
            <div class="result-team-actions">
              <button class="btn btn-ghost result-export-card-btn" onclick="exportTeamPdfById('${tId}')" title="Download ${team.name} PDF" aria-label="Download ${team.name} PDF">
                <span class="result-export-icon">&#8681;</span>
                <span class="result-export-text">PDF</span>
              </button>
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
    setupPlaying11(roomCode, session, teams, teamSquads);

    document.getElementById('loadingScreen').style.display = 'none';
    document.getElementById('resultsContent').style.display = 'block';

  } catch (err) {
    console.error(err);
    document.getElementById('loadingScreen').innerHTML = `
      <p style="color:var(--red)">Failed to load results. <button class="btn btn-ghost" onclick="location.reload()">Retry</button></p>`;
  }
}

// ============================================================
// PLAYING 11 SETUP
// ============================================================

function setupPlaying11(roomCode, session, teams, teamSquads) {
  if (!session || !session.teamId) return;

  playing11State.roomCode = roomCode;
  playing11State.session = session;
  playing11State.myTeamId = session.teamId;
  playing11State.mySquad = (teamSquads[session.teamId] || []).map(x => ({
    player: x.player,
    price: x.price
  }));
  
  loadPlaying11FromFirebase();
}

async function loadPlaying11FromFirebase() {
  const { roomCode, myTeamId } = playing11State;
  if (!roomCode || !myTeamId) return;

  try {
    const snap = await db.ref(`rooms/${roomCode}/playing11/${myTeamId}`).get();
    if (snap.exists()) {
      const data = snap.val();
      playing11State.playing11 = (data.playing11 || []).map(pid => String(pid));
      playing11State.captain = data.captain != null ? String(data.captain) : null;
      playing11State.vice_captain = data.vice_captain != null ? String(data.vice_captain) : null;
      playing11State.wicket_keeper = data.wicket_keeper != null ? String(data.wicket_keeper) : null;
    }
  } catch (err) {
    console.error('Failed to load Playing 11:', err);
  }
}

function openPlaying11Modal() {
  const overlay = document.getElementById('playing11ModalOverlay');
  if (!overlay) return;
  overlay.classList.add('visible');
  playing11State.selectionScrollTop = 0;
  playing11State.designationScrollTop = 0;
  renderPlaying11Modal();
}

function closePlaying11Modal() {
  const overlay = document.getElementById('playing11ModalOverlay');
  if (overlay) overlay.classList.remove('visible');
}

function renderPlaying11Modal() {
  const content = document.getElementById('playing11ModalContent');
  if (!content) return;

  const { mySquad, playing11, captain, vice_captain, wicket_keeper } = playing11State;

  if (!mySquad.length) {
    content.innerHTML = `
      <div class="state-empty">
        <p>No squad data available for Playing 11 selection.</p>
      </div>
    `;
    return;
  }

  // Check if 11 players are selected
  if (playing11.length < 11) {
    // PLAYER SELECTION STAGE - Show all squad members to select
    const getTick = (selected) => selected
      ? '<span class="playing11-select-tick selected" aria-hidden="true">✓</span>'
      : '<span class="playing11-select-tick" aria-hidden="true"></span>';

    const playerList = mySquad.map(entry => `
      <button type="button" class="playing11-player-select-row ${playing11.includes(String(entry.player.id)) ? 'selected' : ''}"
        onclick="togglePlaying11Player('${String(entry.player.id)}')">
        ${getTick(playing11.includes(String(entry.player.id)))}
        <span class="playing11-player-select-name">${entry.player.name}</span>
        <span class="playing11-player-select-role">${entry.player.role}</span>
        <span class="playing11-player-select-price">${formatPrice(entry.price)}</span>
      </button>
    `).join('');

    content.innerHTML = `
      <div class="playing11-selection-stage">
        <div class="playing11-count-badge">Selected: <strong>${playing11.length}/11</strong></div>
        <div class="playing11-all-players-list">
          ${playerList}
        </div>
      </div>
    `;

    const list = content.querySelector('.playing11-all-players-list');
    if (list) list.scrollTop = playing11State.selectionScrollTop || 0;
  } else {
    // DESIGNATION STAGE - Show 11 selected players with C/VC/WK buttons
    const selectedPlayers = playing11.map(pid => 
      mySquad.find(e => String(e.player.id) === String(pid))
    ).filter(Boolean);

    const playerDesignationHtml = selectedPlayers.map(entry => {
      const playerId = String(entry.player.id);
      const isCaptain = captain === playerId;
      const isVC = vice_captain === playerId;
      const isWK = wicket_keeper === playerId;

      return `
        <div class="playing11-designation-row">
          <div class="playing11-player-info">
            <span class="playing11-player-name-des">${entry.player.name}</span>
            <span class="playing11-player-role-des">${entry.player.role}</span>
          </div>
          <div class="playing11-designation-buttons">
            <button class="playing11-des-btn ${isCaptain ? 'active' : ''}" 
              onclick="setPlayerDesignation('${playerId}', 'captain')" 
              title="Captain">
              ⭐ C
            </button>
            <button class="playing11-des-btn ${isVC ? 'active' : ''}" 
              onclick="setPlayerDesignation('${playerId}', 'vice_captain')" 
              title="Vice-Captain">
              👤 VC
            </button>
            <button class="playing11-des-btn ${isWK ? 'active' : ''}" 
              onclick="setPlayerDesignation('${playerId}', 'wicket_keeper')" 
              title="Wicket-Keeper">
              🥅 WK
            </button>
          </div>
        </div>
      `;
    }).join('');

    content.innerHTML = `
      <div class="playing11-designation-stage">
        <div class="playing11-designation-info">
          <p>Select one player each for Captain (C), Vice-Captain (VC), and Wicket-Keeper (WK)</p>
        </div>
        <div class="playing11-designation-list">
          ${playerDesignationHtml}
        </div>
        <div class="playing11-designation-summary">
          <div class="playing11-summary-item">
            <span>⭐ Captain:</span>
            <span class="playing11-summary-value">${captain ? mySquad.find(e => String(e.player.id) === String(captain))?.player.name || 'Not Selected' : 'Not Selected'}</span>
          </div>
          <div class="playing11-summary-item">
            <span>👤 Vice-Captain:</span>
            <span class="playing11-summary-value">${vice_captain ? mySquad.find(e => String(e.player.id) === String(vice_captain))?.player.name || 'Not Selected' : 'Not Selected'}</span>
          </div>
          <div class="playing11-summary-item">
            <span>🥅 Wicket-Keeper:</span>
            <span class="playing11-summary-value">${wicket_keeper ? mySquad.find(e => String(e.player.id) === String(wicket_keeper))?.player.name || 'Not Selected' : 'Not Selected'}</span>
          </div>
        </div>
      </div>
    `;

    const designationList = content.querySelector('.playing11-designation-list');
    if (designationList) designationList.scrollTop = playing11State.designationScrollTop || 0;
  }

  // Add action buttons at the bottom
  const allActionsHTML = `
    <div class="playing11-actions">
      ${playing11.length < 11 ? `
        <button class="btn btn-secondary" onclick="closePlaying11Modal()">Cancel</button>
        <button class="btn btn-primary" onclick="clearPlaying11Selection()">Clear All</button>
      ` : `
        <button class="btn btn-secondary" onclick="resetPlaying11ToSelection()">Back to Selection</button>
        <button class="btn btn-primary" onclick="savePlaying11()" ${(!captain || !vice_captain || !wicket_keeper) ? 'disabled' : ''}>
          Save Playing 11
        </button>
      `}
    </div>
  `;

  content.innerHTML += allActionsHTML;
}

function togglePlaying11Player(playerId) {
  const normalizedId = String(playerId);
  const list = document.querySelector('#playing11ModalContent .playing11-all-players-list');
  if (list) playing11State.selectionScrollTop = list.scrollTop;

  const idx = playing11State.playing11.indexOf(normalizedId);
  if (idx === -1) {
    if (playing11State.playing11.length < 11) {
      playing11State.playing11.push(normalizedId);
    }
  } else {
    playing11State.playing11.splice(idx, 1);
    // Clear captain/vc/wk if player is removed
    if (playing11State.captain === normalizedId) playing11State.captain = null;
    if (playing11State.vice_captain === normalizedId) playing11State.vice_captain = null;
    if (playing11State.wicket_keeper === normalizedId) playing11State.wicket_keeper = null;
  }
  renderPlaying11Modal();
}


function setPlayerDesignation(playerId, role) {
  const normalizedId = String(playerId);
  const designationList = document.querySelector('#playing11ModalContent .playing11-designation-list');
  if (designationList) playing11State.designationScrollTop = designationList.scrollTop;

  // Toggle the designation on/off
  if (role === 'captain') {
    playing11State.captain = playing11State.captain === normalizedId ? null : normalizedId;
  } else if (role === 'vice_captain') {
    playing11State.vice_captain = playing11State.vice_captain === normalizedId ? null : normalizedId;
  } else if (role === 'wicket_keeper') {
    playing11State.wicket_keeper = playing11State.wicket_keeper === normalizedId ? null : normalizedId;
  }
  renderPlaying11Modal();
}

function clearPlaying11Selection() {
  playing11State.playing11 = [];
  playing11State.captain = null;
  playing11State.vice_captain = null;
  playing11State.wicket_keeper = null;
  playing11State.selectionScrollTop = 0;
  playing11State.designationScrollTop = 0;
  renderPlaying11Modal();
}

function resetPlaying11ToSelection() {
  playing11State.captain = null;
  playing11State.vice_captain = null;
  playing11State.wicket_keeper = null;
  renderPlaying11Modal();
}
async function savePlaying11() {
  const { roomCode, myTeamId, playing11, captain, vice_captain, wicket_keeper } = playing11State;

  if (!roomCode || !myTeamId) {
    showToast('Team information missing.', 'error');
    return;
  }

  if (playing11.length !== 11) {
    showToast('Please select exactly 11 players.', 'error');
    return;
  }

  if (!captain || !vice_captain || !wicket_keeper) {
    showToast('Please designate Captain, Vice-Captain, and Wicket-Keeper.', 'error');
    return;
  }

  try {
    await db.ref(`rooms/${roomCode}/playing11/${myTeamId}`).set({
      playing11,
      captain,
      vice_captain,
      wicket_keeper,
      savedAt: Date.now()
    });
    showToast('Playing 11 saved successfully!', 'success');
    closePlaying11Modal();
  } catch (err) {
    console.error('Error saving Playing 11:', err);
    showToast('Failed to save Playing 11.', 'error');
  }
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
    bidHistory: [],
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

const PDF_THEME = {
  navy: [8, 20, 44],
  blue: [18, 93, 152],
  cyan: [0, 166, 214],
  gold: [240, 183, 35],
  mint: [35, 166, 122],
  danger: [208, 64, 57],
  slate900: [23, 38, 56],
  slate700: [61, 81, 106],
  slate500: [102, 121, 143],
  slate300: [214, 222, 231],
  slate200: [232, 237, 243],
  white: [255, 255, 255]
};

function drawSectionTitle(doc, label, y, accent = PDF_THEME.blue) {
  doc.setDrawColor(...PDF_THEME.slate300);
  doc.setLineWidth(0.8);
  doc.line(40, y + 8, 555, y + 8);

  doc.setFillColor(...accent);
  doc.roundedRect(40, y - 10, 8, 18, 2, 2, 'F');

  doc.setTextColor(...PDF_THEME.slate900);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text(label, 54, y + 3);
}

function getSquadRoleMix(squad) {
  return (squad || []).reduce((acc, entry) => {
    const role = String(entry?.player?.role || '').toLowerCase();
    if (role.includes('all-rounder')) acc.allRounder += 1;
    else if (role.includes('wicket')) acc.wicketKeeper += 1;
    else if (role.includes('bowler') || role.includes('spinner') || role.includes('fast')) acc.bowler += 1;
    else acc.batsman += 1;
    return acc;
  }, { batsman: 0, wicketKeeper: 0, allRounder: 0, bowler: 0 });
}

function drawInfoChips(doc, y, chips) {
  let x = 40;
  chips.forEach((chip) => {
    const text = `${chip.label}: ${chip.value}`;
    const w = Math.max(90, doc.getTextWidth(text) + 24);
    doc.setFillColor(...chip.bg);
    doc.roundedRect(x, y, w, 20, 10, 10, 'F');

    doc.setTextColor(...chip.fg);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.text(text, x + 12, y + 13);

    x += w + 8;
  });
}

function renderPdfHeader(doc, title, roomCode, generatedAt) {
  const pageWidth = doc.internal.pageSize.getWidth();
  doc.setFillColor(...PDF_THEME.navy);
  doc.rect(0, 0, pageWidth, 118, 'F');

  // Layered accent bars for a premium look.
  doc.setFillColor(...PDF_THEME.blue);
  doc.rect(0, 88, pageWidth, 30, 'F');
  doc.setFillColor(...PDF_THEME.cyan);
  doc.rect(0, 102, pageWidth, 16, 'F');

  doc.setFillColor(255, 255, 255, 0.08);
  doc.circle(pageWidth - 60, 34, 52, 'F');
  doc.circle(pageWidth - 10, 64, 36, 'F');

  doc.setTextColor(...PDF_THEME.white);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(24);
  doc.text(title, 40, 40);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text('IPL Auction Analytics Dossier', 40, 58);

  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text(`Room: ${roomCode}`, 40, 78);
  doc.setFont('helvetica', 'normal');
  doc.text(`Generated: ${generatedAt.toLocaleString()}`, 40, 94);
}

function appendPdfFooter(doc) {
  const pageCount = doc.internal.getNumberOfPages();
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    doc.setPage(pageNumber);
    doc.setDrawColor(...PDF_THEME.slate300);
    doc.line(40, pageHeight - 26, pageWidth - 40, pageHeight - 26);

    doc.setTextColor(...PDF_THEME.slate500);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text('IPL Auction Report', 40, pageHeight - 12);
    doc.text(`Page ${pageNumber} of ${pageCount}`, pageWidth - 40, pageHeight - 18, { align: 'right' });
  }
}

function renderAuctionSummaryTable(doc, teams, soldCount, unsoldCount, totalSales) {
  const teamsCount = Object.keys(teams).length;
  drawSectionTitle(doc, 'Auction Snapshot', 134, PDF_THEME.blue);

  const stats = [
    { label: 'Teams', value: String(teamsCount), bg: [228, 242, 255], fg: PDF_THEME.slate900 },
    { label: 'Players Sold', value: String(soldCount), bg: [231, 247, 238], fg: PDF_THEME.slate900 },
    { label: 'Unsold', value: String(unsoldCount), bg: [255, 236, 234], fg: PDF_THEME.slate900 },
    { label: 'Total Spend', value: formatPricePdf(totalSales), bg: [255, 248, 227], fg: PDF_THEME.slate900 }
  ];
  drawInfoChips(doc, 148, stats);

  doc.autoTable({
    startY: 182,
    margin: { left: 40, right: 40 },
    theme: 'plain',
    head: [['Metric', 'Value', 'Insight']],
    body: [
      ['Teams in Auction', String(teamsCount), teamsCount >= 8 ? 'High competition pool' : 'Compact competition pool'],
      ['Players Sold', String(soldCount), soldCount > 0 ? 'Active auction outcome' : 'No completed sales yet'],
      ['Players Unsold', String(unsoldCount), unsoldCount <= 5 ? 'Efficient conversion rate' : 'Large unsold reserve remains'],
      ['Total Spend', formatPricePdf(totalSales), totalSales > 0 ? 'Budget utilization completed' : 'No spending recorded']
    ],
    styles: {
      fontSize: 10,
      cellPadding: 7,
      lineColor: PDF_THEME.slate300,
      lineWidth: 0.6,
      textColor: PDF_THEME.slate900
    },
    headStyles: {
      fillColor: PDF_THEME.navy,
      textColor: PDF_THEME.white,
      fontStyle: 'bold'
    },
    alternateRowStyles: { fillColor: PDF_THEME.slate200 },
    columnStyles: {
      0: { cellWidth: 132, fontStyle: 'bold' },
      1: { cellWidth: 120 },
      2: { cellWidth: 223 }
    }
  });
}

function renderTeamSection(doc, teamId, team, squad, roomTeamCatalog, rank, playing11Data, playerMap) {
  const pageHeight = doc.internal.pageSize.getHeight();
  const teamSpend = squad.reduce((sum, entry) => sum + entry.price, 0);
  const purseLeft = team.purse || 0;
  const t = roomTeamCatalog[teamId] || getTeam(teamId) || {};

  let startY = (doc.lastAutoTable?.finalY || 132) + 16;
  if (startY > pageHeight - 240) {
    doc.addPage();
    startY = 70;
  }

  const roleMix = getSquadRoleMix(squad);
  const rankPrefix = typeof rank === 'number' ? `${rank}. ` : '';
  const headerColor = rank === 1
    ? PDF_THEME.gold
    : rank === 2
      ? [163, 170, 185]
      : rank === 3
        ? [174, 120, 81]
        : PDF_THEME.blue;

  doc.setFillColor(245, 248, 252);
  doc.roundedRect(34, startY - 18, 527, 52, 10, 10, 'F');

  doc.setFillColor(...headerColor);
  doc.roundedRect(40, startY - 12, 8, 40, 3, 3, 'F');

  doc.setTextColor(...PDF_THEME.slate900);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text(`${rankPrefix}${team.name} (${team.short || t.short || teamId})`, 56, startY);

  doc.setTextColor(...PDF_THEME.slate700);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.text(`Owner: ${team.ownerName || '-'}`, 56, startY + 14);

  drawInfoChips(doc, startY + 24, [
    { label: 'Squad', value: String(squad.length), bg: [228, 242, 255], fg: PDF_THEME.slate900 },
    { label: 'Spent', value: formatPricePdf(teamSpend), bg: [255, 248, 227], fg: PDF_THEME.slate900 },
    { label: 'Purse Left', value: formatPricePdf(purseLeft), bg: [231, 247, 238], fg: PDF_THEME.slate900 }
  ]);

  doc.setTextColor(...PDF_THEME.slate700);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.2);
  doc.text(
    `Role Mix  BAT ${roleMix.batsman}  WK ${roleMix.wicketKeeper}  AR ${roleMix.allRounder}  BOWL ${roleMix.bowler}`,
    430,
    startY + 14,
    { align: 'right' }
  );

  doc.autoTable({
    startY: startY + 52,
    margin: { left: 40, right: 40 },
    theme: 'plain',
    head: [['Owner', 'Players', 'Spent', 'Purse Left']],
    body: [[
      team.ownerName || '-',
      String(squad.length),
      formatPricePdf(teamSpend),
      formatPricePdf(purseLeft)
    ]],
    styles: {
      fontSize: 9.5,
      cellPadding: 6,
      lineColor: PDF_THEME.slate300,
      lineWidth: 0.6,
      textColor: PDF_THEME.slate900
    },
    headStyles: {
      fillColor: PDF_THEME.navy,
      textColor: PDF_THEME.white,
      fontStyle: 'bold'
    },
    bodyStyles: { fillColor: [250, 252, 255] },
    columnStyles: {
      0: { cellWidth: 180 },
      1: { cellWidth: 90, halign: 'center' },
      2: { cellWidth: 125, halign: 'right' },
      3: { halign: 'right' }
    }
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
    theme: 'plain',
    head: [['#', 'Player', 'Role', 'Country', 'Price']],
    body: rows,
    styles: {
      fontSize: 9,
      cellPadding: 5,
      lineColor: PDF_THEME.slate300,
      lineWidth: 0.5,
      textColor: PDF_THEME.slate900
    },
    headStyles: {
      fillColor: PDF_THEME.blue,
      textColor: PDF_THEME.white,
      fontStyle: 'bold'
    },
    alternateRowStyles: { fillColor: [247, 250, 254] },
    columnStyles: {
      0: { cellWidth: 26 },
      1: { cellWidth: 195 },
      2: { cellWidth: 95 },
      3: { cellWidth: 110 },
      4: { halign: 'right' }
    }
  });

  // Add Playing 11 section if available
  if (playing11Data && playing11Data.playing11 && playing11Data.playing11.length === 11) {
    const selectedIds = (playing11Data.playing11 || []).map(pid => String(pid));
    const captainId = playing11Data.captain != null ? String(playing11Data.captain) : null;
    const viceCaptainId = playing11Data.vice_captain != null ? String(playing11Data.vice_captain) : null;
    const wicketKeeperId = playing11Data.wicket_keeper != null ? String(playing11Data.wicket_keeper) : null;

    startY = doc.lastAutoTable.finalY + 14;
    if (startY > pageHeight - 150) {
      doc.addPage();
      startY = 70;
    }

    drawSectionTitle(doc, 'Best Playing 11', startY, PDF_THEME.mint);

    const playing11Players = selectedIds.map(pid => {
      const entry = squad.find(e => String(e.player.id) === pid);
      if (!entry) return null;
      const player = entry.player;
      let designation = '';
      if (pid === captainId) designation = ' (C)';
      else if (pid === viceCaptainId) designation = ' (VC)';
      else if (pid === wicketKeeperId) designation = ' (WK)';

      return [
        player.name + designation,
        player.role || '-',
        player.country || 'Manual',
        formatPricePdf(entry.price)
      ];
    }).filter(Boolean);

    doc.autoTable({
      startY: startY + 14,
      margin: { left: 40, right: 40 },
      theme: 'plain',
      head: [['Player', 'Role', 'Country', 'Price']],
      body: playing11Players.length ? playing11Players : [['Playing 11 could not be resolved from squad data', '-', '-', '-']],
      styles: {
        fontSize: 9,
        cellPadding: 5,
        lineColor: PDF_THEME.slate300,
        lineWidth: 0.5,
        textColor: PDF_THEME.slate900
      },
      headStyles: {
        fillColor: PDF_THEME.mint,
        textColor: PDF_THEME.white,
        fontStyle: 'bold'
      },
      alternateRowStyles: { fillColor: [239, 250, 245] },
      columnStyles: {
        0: { cellWidth: 205 },
        1: { cellWidth: 95 },
        2: { cellWidth: 110 },
        3: { halign: 'right' }
      }
    });
  }
}

async function exportResultsPdf() {
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

  for (let i = 0; i < sortedTeams.length; i++) {
    const [teamId, team] = sortedTeams[i];
    const squad = (teamSquads[teamId] || []).slice().sort((a, b) => b.price - a.price);
    
    // Load Playing 11 data for this team
    let playing11Data = null;
    try {
      const snap = await db.ref(`rooms/${roomCode}/playing11/${teamId}`).get();
      if (snap.exists()) {
        playing11Data = snap.val();
      }
    } catch (err) {
      console.error(`Failed to load Playing 11 for team ${teamId}:`, err);
    }
    
    renderTeamSection(doc, teamId, team, squad, roomTeamCatalog, i + 1, playing11Data);
  }

  appendPdfFooter(doc);

  const safeRoom = String(roomCode).replace(/[^a-zA-Z0-9-_]/g, '_');
  const datePart = generatedAt.toISOString().slice(0, 10);
  doc.save(`ipl-auction-${safeRoom}-${datePart}.pdf`);
}

async function exportTeamPdfById(selectedTeamId) {
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

  // Load Playing 11 data for this team
  let playing11Data = null;
  try {
    const snap = await db.ref(`rooms/${roomCode}/playing11/${teamId}`).get();
    if (snap.exists()) {
      playing11Data = snap.val();
    }
  } catch (err) {
    console.error(`Failed to load Playing 11 for team ${teamId}:`, err);
  }

  renderPdfHeader(doc, `${team.name} - Team Report`, roomCode, generatedAt);
  renderTeamSection(doc, teamId, team, squad, roomTeamCatalog, null, playing11Data);
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

async function copyAnalystPrompt() {
  try {
    await navigator.clipboard.writeText(analystPromptTemplate);
    showToast('Prompt copied. Now upload the All Teams PDF to any AI and paste the prompt.', 'success');
  } catch (err) {
    try {
      const fallback = document.createElement('textarea');
      fallback.value = analystPromptTemplate;
      fallback.setAttribute('readonly', '');
      fallback.style.position = 'fixed';
      fallback.style.opacity = '0';
      document.body.appendChild(fallback);
      fallback.select();
      document.execCommand('copy');
      document.body.removeChild(fallback);
      showToast('Prompt copied. Now upload the All Teams PDF to any AI and paste the prompt.', 'success');
    } catch (copyErr) {
      console.error(copyErr);
      showToast('Copy failed. Please allow clipboard permission and try again.', 'error');
    }
    if (err) console.error(err);
  }
}

window.openPlaying11Modal = openPlaying11Modal;
window.closePlaying11Modal = closePlaying11Modal;
window.togglePlaying11Player = togglePlaying11Player;
window.setPlayerDesignation = setPlayerDesignation;
window.clearPlaying11Selection = clearPlaying11Selection;
window.resetPlaying11ToSelection = resetPlaying11ToSelection;
window.savePlaying11 = savePlaying11;
window.toggleReAuctionPlayer = toggleReAuctionPlayer;
window.toggleReAuctionReady = toggleReAuctionReady;
window.startReAuctionFromResults = startReAuctionFromResults;
window.exportResultsPdf = exportResultsPdf;
window.exportTeamPdfById = exportTeamPdfById;
window.exportSelectedTeamPdf = exportSelectedTeamPdf;
window.copyAnalystPrompt = copyAnalystPrompt;
