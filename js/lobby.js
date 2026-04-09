// ============================================================
// LOBBY.JS — Waiting room logic
// ============================================================

const session = requireSession();
if (!session) throw new Error('No session');

const { roomCode, teamId: myTeamId, playerName, isHost } = session;

let roomConfig = null;
let teamsListener = null;
let statusListener = null;
let watchlistListener = null;
let allPlayers = [];
let watchlistSet = new Set();
let roomTeamCatalog = {};

function shufflePoolOrder(items) {
  const arr = [...items];
  // Prefer crypto randomness when available for better distribution.
  if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const rand = new Uint32Array(1);
      window.crypto.getRandomValues(rand);
      const j = rand[0] % (i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function getRoomTeamMeta(teamId) {
  return roomTeamCatalog[teamId] || getTeam(teamId);
}

function buildPlayerQueue(players, mode) {
  if (mode !== 'category') {
    return {
      queue: shuffleArray(players.map(p => p.id)),
      poolByIndex: {}
    };
  }

  const pools = [
    { id: 'marquee', label: 'Marquee Pool', filter: p => p.base_price_lakh === 200 },
    { id: 'bat-1', label: 'Batsmen Pool 1 (150L + 100L)', filter: p => p.role === 'Batsman' && [150, 100].includes(p.base_price_lakh) },
    { id: 'wk-1', label: 'Wicket-keeper Pool 1 (150L + 100L)', filter: p => p.role === 'Wicket-keeper' && [150, 100].includes(p.base_price_lakh) },
    { id: 'ar-1', label: 'All-rounder Pool 1 (150L + 100L)', filter: p => p.role === 'All-rounder' && [150, 100].includes(p.base_price_lakh) },
    { id: 'fb-1', label: 'Fast Bowler Pool 1 (150L + 100L)', filter: p => (p.role === 'Fast Bowler' || p.role === 'Bowler') && [150, 100].includes(p.base_price_lakh) },
    { id: 'sp-1', label: 'Spinner Pool 1 (150L + 100L)', filter: p => p.role === 'Spinner' && [150, 100].includes(p.base_price_lakh) },
    { id: 'bat-2', label: 'Batsmen Pool 2 (75L)', filter: p => p.role === 'Batsman' && p.base_price_lakh === 75 },
    { id: 'wk-2', label: 'Wicket-keeper Pool 2 (75L)', filter: p => p.role === 'Wicket-keeper' && p.base_price_lakh === 75 },
    { id: 'ar-2', label: 'All-rounder Pool 2 (75L)', filter: p => p.role === 'All-rounder' && p.base_price_lakh === 75 },
    { id: 'fb-2', label: 'Fast Bowler Pool 2 (75L)', filter: p => (p.role === 'Fast Bowler' || p.role === 'Bowler') && p.base_price_lakh === 75 },
    { id: 'sp-2', label: 'Spinner Pool 2 (75L)', filter: p => p.role === 'Spinner' && p.base_price_lakh === 75 },
    { id: 'bat-3', label: 'Batsmen Pool 3 (50L)', filter: p => p.role === 'Batsman' && p.base_price_lakh === 50 },
    { id: 'wk-3', label: 'Wicket-keeper Pool 3 (50L)', filter: p => p.role === 'Wicket-keeper' && p.base_price_lakh === 50 },
    { id: 'ar-3', label: 'All-rounder Pool 3 (50L)', filter: p => p.role === 'All-rounder' && p.base_price_lakh === 50 },
    { id: 'fb-3', label: 'Fast Bowler Pool 3 (50L)', filter: p => (p.role === 'Fast Bowler' || p.role === 'Bowler') && p.base_price_lakh === 50 },
    { id: 'sp-3', label: 'Spinner Pool 3 (50L)', filter: p => p.role === 'Spinner' && p.base_price_lakh === 50 }
  ];

  const queue = [];
  const poolByIndex = {};

  pools.forEach(pool => {
    const ids = shufflePoolOrder(players.filter(pool.filter).map(p => p.id));
    const start = queue.length;
    ids.forEach((id, idx) => {
      queue.push(id);
      poolByIndex[start + idx] = {
        poolId: pool.id,
        poolLabel: pool.label
      };
    });
  });

  return { queue, poolByIndex };
}

// ---- Init ----
window.addEventListener('DOMContentLoaded', initLobby);

function initLobby() {
  // Show room code
  document.getElementById('roomCodeDisplay').textContent = roomCode;

  // Show host or guest panel
  if (isHost) {
    document.getElementById('hostControls').style.display = 'block';
  } else {
    document.getElementById('guestWaiting').style.display = 'block';
  }

  // Load room data
  db.ref(`rooms/${roomCode}`).get().then(snap => {
    if (!snap.exists()) { alert('Room not found!'); window.location.href = 'index.html'; return; }
    const room = snap.val();
    roomConfig = room.config || {};
    roomTeamCatalog = roomConfig.auctionType === 'manual'
      ? (room.manualTeams || {})
      : Object.fromEntries(IPL_TEAMS.map(t => [t.id, t]));
    allPlayers = roomConfig.auctionType === 'manual'
      ? (room.manualPlayers || [])
      : [];

    // Show my team chip
    const me = getRoomTeamMeta(myTeamId);
    if (me) {
      const chip = document.getElementById('myTeamChip');
      chip.style.display = 'flex';
      chip.innerHTML = `${me.logo ? `<img class="chip-team-logo" src="${me.logo}" alt="${me.short} logo" />` : ''} ${me.short}`;
    }

    window.getLobbyInviteLink = (includePasscode = false) => buildInviteUrl(roomCode, roomConfig.invitePasscode, includePasscode);

    document.getElementById('configInfo').innerHTML = `
      <div class="glass" style="padding:0.7rem 1.2rem;text-align:center;">
        <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-sec)">Budget</div>
        <div style="font-family:'Rajdhani',sans-serif;font-weight:700;font-size:1.2rem;color:var(--gold)">${formatPrice(roomConfig.budget)}</div>
      </div>
      <div class="glass" style="padding:0.7rem 1.2rem;text-align:center;">
        <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-sec)">Max Squad</div>
        <div style="font-family:'Rajdhani',sans-serif;font-weight:700;font-size:1.2rem;color:var(--gold)">${roomConfig.maxSquadSize}</div>
      </div>
      <div class="glass" style="padding:0.7rem 1.2rem;text-align:center;">
        <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-sec)">Bid Timer</div>
        <div style="font-family:'Rajdhani',sans-serif;font-weight:700;font-size:1.2rem;color:var(--gold)">${(roomConfig.unlimitedTimer || roomConfig.timerMode === 'unlimited') ? 'Unlimited' : `${roomConfig.timerSeconds}s`}</div>
      </div>
      <div class="glass" style="padding:0.7rem 1.2rem;text-align:center;">
        <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-sec)">Order</div>
        <div style="font-family:'Rajdhani',sans-serif;font-weight:700;font-size:1.2rem;color:var(--gold)">${roomConfig.auctionType === 'manual' ? 'Manual' : (roomConfig.auctionMode === 'category' ? 'By Category' : 'Random')}</div>
      </div>
      <div class="glass" style="padding:0.7rem 1.2rem;text-align:center;">
        <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-sec)">Bid Buttons</div>
        <div style="font-family:'Rajdhani',sans-serif;font-weight:700;font-size:1.2rem;color:var(--gold)">${(roomConfig.bidOptions || [25,50,100]).map(v => formatPrice(v)).join(' / ')}</div>
      </div>
    `;

    // Show lobby content
    document.getElementById('loadingScreen').style.display = 'none';
    document.getElementById('lobbyContent').style.display = 'block';

    db.ref(`rooms/${roomCode}/teams`).get().then(teamSnap => {
      renderTeamSlots(teamSnap.val() || {});
    });

    if (roomConfig.auctionType !== 'manual') {
      loadPlayers().then(players => {
        allPlayers = players || [];
      }).catch(err => {
        console.error('Failed to load players for watchlist:', err);
      });
    }
  });

  watchlistListener = db.ref(`rooms/${roomCode}/watchlists/${myTeamId}`).on('value', snap => {
    const data = snap.val() || {};
    watchlistSet = new Set(Object.keys(data));
    updateWatchlistCounter();
  });

  // Listen to teams
  teamsListener = db.ref(`rooms/${roomCode}/teams`).on('value', snap => {
    const teams = snap.val() || {};
    renderTeamSlots(teams);
  });

  // Listen to room status (for redirect when auction starts)
  statusListener = db.ref(`rooms/${roomCode}/config/status`).on('value', snap => {
    const status = snap.val();
    if (status === 'auction') {
      window.location.href = `auction.html?room=${encodeURIComponent(roomCode)}`;
    } else if (status === 'finished') {
      window.location.href = `results.html?room=${encodeURIComponent(roomCode)}`;
    }
  });
}

function updateWatchlistCounter() {
  const label = document.getElementById('watchlistCountLabel');
  if (!label) return;
  label.textContent = `${watchlistSet.size} selected`;
}

function openWatchlistModal() {
  const overlay = document.getElementById('watchlistModalOverlay');
  const list = document.getElementById('watchlistList');
  if (!overlay || !list) return;

  updateWatchlistCounter();

  const sortedPlayers = [...allPlayers].sort((a, b) => {
    if (a.base_price_lakh !== b.base_price_lakh) return b.base_price_lakh - a.base_price_lakh;
    return a.name.localeCompare(b.name);
  });

  list.innerHTML = sortedPlayers.map(player => {
    const checked = watchlistSet.has(player.id);
    return `
      <label class="watchlist-row ${checked ? 'selected' : ''}" for="wl-${player.id}">
        <input type="checkbox" id="wl-${player.id}" ${checked ? 'checked' : ''} onchange="toggleWatchlistPlayer('${player.id}', this.checked)" />
        <span class="watchlist-star">${checked ? '★' : '☆'}</span>
        <span class="watchlist-player-name">${player.name}</span>
        <span class="watchlist-player-meta">${getRoleIcon(player.role)} ${player.role} · ${formatPrice(player.base_price_lakh)}</span>
      </label>
    `;
  }).join('');

  overlay.classList.add('visible');
}

function closeWatchlistModal() {
  const overlay = document.getElementById('watchlistModalOverlay');
  if (overlay) overlay.classList.remove('visible');
}

async function toggleWatchlistPlayer(playerId, checked) {
  try {
    const ref = db.ref(`rooms/${roomCode}/watchlists/${myTeamId}/${playerId}`);
    if (checked) {
      await ref.set(true);
      watchlistSet.add(playerId);
    } else {
      await ref.remove();
      watchlistSet.delete(playerId);
    }
    updateWatchlistCounter();
  } catch (err) {
    console.error('Watchlist update failed:', err);
    showToast('Failed to update watchlist.', 'error');
  }
}

async function clearWatchlist() {
  if (!watchlistSet.size) return;
  try {
    await db.ref(`rooms/${roomCode}/watchlists/${myTeamId}`).remove();
    watchlistSet.clear();
    updateWatchlistCounter();
    openWatchlistModal();
  } catch (err) {
    console.error('Clear watchlist failed:', err);
    showToast('Failed to clear watchlist.', 'error');
  }
}

function renderTeamSlots(teams) {
  const grid = document.getElementById('teamSlotsGrid');
  const joinedIds = Object.keys(teams);
  const count = joinedIds.length;
  const teamCatalogList = Object.values(roomTeamCatalog || {});
  const totalTeams = teamCatalogList.length || 10;

  document.getElementById('joinedCount').textContent = `(${count}/${totalTeams} joined)`;

  grid.innerHTML = teamCatalogList.map(t => {
    const joined = teams[t.id];
    const isMe = t.id === myTeamId;
    const teamIsHost = joined && joined.isHost;

    let cls = 'lobby-team-slot';
    if (isMe) cls += ' mine';
    else if (joined) cls += ' joined taken';
    else cls += ' available';

    let badge = '';
    if (isMe) badge = `<div class="slot-badge you">YOU</div>`;
    else if (teamIsHost) badge = `<div class="slot-badge host">HOST</div>`;

    return `
      <div class="${cls}" style="--team-color:${t.primary}"
           onclick="${(!joined && !isMe) ? `joinTeamFromLobby('${t.id}')` : ''}">
        ${badge}
        <img class="slot-logo" src="${t.logo}" alt="${t.short} logo" />
        <div class="slot-name" style="color:${t.primary}">${t.short}</div>
        <div class="slot-owner">
          ${joined ? `<span style="color:var(--green)">✓ ${joined.ownerName}</span>` : `<span style="color:var(--text-dim)">Available</span>`}
        </div>
      </div>
    `;
  }).join('');

  // Update host start button
  if (isHost) {
    const startBtn = document.getElementById('startBtn');
    const hint = document.getElementById('waitingHint');

    if (count < 2) {
      startBtn.disabled = true;
      hint.textContent = `Waiting for at least 1 more player to join...`;
    } else {
      startBtn.disabled = false;
      hint.textContent = `${count} team${count > 1 ? 's' : ''} ready. Start when everyone's joined!`;
    }
  }
}

// Non-host joining a team from lobby (only if they don't have one yet)
async function joinTeamFromLobby(tId) {
  if (myTeamId) return; // already have a team
  const snap = await db.ref(`rooms/${roomCode}/teams/${tId}`).get();
  if (snap.exists()) { showToast('Team already taken!', 'error'); return; }

  const team = getRoomTeamMeta(tId);
  await db.ref(`rooms/${roomCode}/teams/${tId}`).set({
    name: team.name,
    short: team.short,
    primary: team.primary,
    logo: team.logo,
    ownerName: playerName,
    purse: roomConfig.budget,
    squad: [],
    isHost: false,
    joinedAt: Date.now()
  });
  saveSession({ ...session, teamId: tId });
  location.reload();
}

// ---- START AUCTION (host only) ----
async function startAuction() {
  if (!isHost) return;
  const btn = document.getElementById('startBtn');
  btn.disabled = true;
  btn.textContent = 'Starting...';

  try {
    const isManual = roomConfig.auctionType === 'manual';
    const unlimitedTimer = !!roomConfig.unlimitedTimer || roomConfig.timerMode === 'unlimited';
    const mode = roomConfig.auctionMode || 'random';

    // Load all players and build queue
    const players = isManual
      ? (allPlayers || [])
      : await loadPlayers();
    const built = isManual
      ? { queue: players.map(p => p.id), poolByIndex: {} }
      : buildPlayerQueue(players, mode);
    const { queue, poolByIndex } = built;
    if (!queue.length) throw new Error('No players available for auction queue');

    // Write player queue
    await db.ref(`rooms/${roomCode}/playerQueue`).set(queue);
    await db.ref(`rooms/${roomCode}/poolByIndex`).set(poolByIndex);
    await db.ref(`rooms/${roomCode}/currentIndex`).set(0);

    // Set up first player auction
    const firstPlayerId = queue[0];
    const firstPlayer = players.find(p => p.id === firstPlayerId);
    const firstPool = poolByIndex[0] || null;

    await db.ref(`rooms/${roomCode}/currentAuction`).set({
      playerId: firstPlayerId,
      currentBid: firstPlayer.base_price_lakh,
      highestBidder: null,
      bidHistory: [],
      poolId: firstPool?.poolId || null,
      poolLabel: firstPool?.poolLabel || null,
      skipVotes: {},
      poolSkipVotes: {},
      withdrawnTeams: {},
      timerEnd: unlimitedTimer ? null : (Date.now() + roomConfig.timerSeconds * 1000),
      status: 'bidding'
    });

    await db.ref(`rooms/${roomCode}/auctionControl`).set({
      paused: false,
      pausedAt: null
    });

    // Set room status → triggers redirect in all clients
    await db.ref(`rooms/${roomCode}/config/status`).set('auction');

  } catch (err) {
    console.error(err);
    showToast('Failed to start auction. Try again.', 'error');
    btn.disabled = false;
    btn.textContent = '🏏 Start Auction';
  }
}

window.addEventListener('beforeunload', () => {
  if (teamsListener) db.ref(`rooms/${roomCode}/teams`).off('value', teamsListener);
  if (statusListener) db.ref(`rooms/${roomCode}/config/status`).off('value', statusListener);
  if (watchlistListener) db.ref(`rooms/${roomCode}/watchlists/${myTeamId}`).off('value', watchlistListener);
});
