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
let liveTeams = {};
let iconPicks = {};
let iconPicksListener = null;

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
        <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-sec)">Min Squad</div>
        <div style="font-family:'Rajdhani',sans-serif;font-weight:700;font-size:1.2rem;color:var(--gold)">${roomConfig.minSquadSize || 1}</div>
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
      ${roomConfig.auctionType === 'manual' && Number(roomConfig.maxIconPlayers || 0) > 0 ? `
      <div class="glass" style="padding:0.7rem 1.2rem;text-align:center;">
        <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-sec)">Icon Fixed Price</div>
        <div style="font-family:'Rajdhani',sans-serif;font-weight:700;font-size:1.2rem;color:var(--gold)">${formatPrice(roomConfig.iconPlayerPrice)}</div>
      </div>
      <div class="glass" style="padding:0.7rem 1.2rem;text-align:center;">
        <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-sec)">Max Icon Players</div>
        <div style="font-family:'Rajdhani',sans-serif;font-weight:700;font-size:1.2rem;color:var(--gold)">${Number(roomConfig.maxIconPlayers || 0)}</div>
      </div>` : ''}
    `;

    toggleIconPickerButtons();

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
    liveTeams = teams;
    renderTeamSlots(teams);
    if (document.getElementById('iconPickerModalOverlay')?.classList.contains('visible')) {
      renderIconPickerModal();
    }
  });

  iconPicksListener = db.ref(`rooms/${roomCode}/iconPicks`).on('value', snap => {
    iconPicks = snap.val() || {};
    if (document.getElementById('iconPickerModalOverlay')?.classList.contains('visible')) {
      renderIconPickerModal();
    }
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

function toggleIconPickerButtons() {
  const enabled = roomConfig?.auctionType === 'manual' && Number(roomConfig?.maxIconPlayers || 0) > 0;
  const hostBtn = document.getElementById('iconPickBtnHost');
  const guestBtn = document.getElementById('iconPickBtnGuest');
  if (hostBtn) hostBtn.style.display = enabled ? 'inline-flex' : 'none';
  if (guestBtn) guestBtn.style.display = enabled ? 'inline-flex' : 'none';
}

function openIconPickerModal() {
  if (!(roomConfig?.auctionType === 'manual')) {
    showToast('Icon player selection is only for manual auctions.', 'error');
    return;
  }
  const maxIconPlayers = Number(roomConfig?.maxIconPlayers || 0);
  if (maxIconPlayers <= 0) {
    showToast('Host has not enabled icon player slots.', 'error');
    return;
  }

  const overlay = document.getElementById('iconPickerModalOverlay');
  if (!overlay) return;
  const search = document.getElementById('iconPickerSearch');
  if (search) search.value = '';
  renderIconPickerModal();
  overlay.classList.add('visible');
}

function closeIconPickerModal() {
  const overlay = document.getElementById('iconPickerModalOverlay');
  if (overlay) overlay.classList.remove('visible');
}

function renderIconPickerModal() {
  const list = document.getElementById('iconPickerList');
  const help = document.getElementById('iconPickerHelp');
  const countLabel = document.getElementById('iconPickerCountLabel');
  const searchEl = document.getElementById('iconPickerSearch');
  if (!list || !help || !countLabel) return;

  const fixedPrice = Number(roomConfig?.iconPlayerPrice || 0);
  const maxIconPlayers = Number(roomConfig?.maxIconPlayers || 0);
  const search = String(searchEl?.value || '').trim().toLowerCase();
  const myPickCount = Object.values(iconPicks).filter((x) => x?.teamId === myTeamId).length;
  countLabel.textContent = `${myPickCount}/${maxIconPlayers} icon selected`;
  help.textContent = `Pick up to ${maxIconPlayers} players at fixed icon price ${formatPrice(fixedPrice)} before host starts auction.`;

  const sortedPlayers = [...allPlayers].sort((a, b) => {
    if ((b.base_price_lakh || 0) !== (a.base_price_lakh || 0)) return (b.base_price_lakh || 0) - (a.base_price_lakh || 0);
    return String(a.name || '').localeCompare(String(b.name || ''));
  });

  const rows = sortedPlayers
    .filter((p) => {
      if (!search) return true;
      const text = `${String(p.name || '').toLowerCase()} ${String(p.role || '').toLowerCase()} ${String(p.country || '').toLowerCase()}`;
      return text.includes(search);
    })
    .map((player) => {
      const pid = String(player.id);
      const picked = iconPicks[pid] || iconPicks[player.id] || null;
      const pickedByTeamId = picked?.teamId || null;
      const pickedByTeam = pickedByTeamId ? (liveTeams[pickedByTeamId] || roomTeamCatalog[pickedByTeamId] || {}) : null;
      const isMine = pickedByTeamId === myTeamId;
      const limitReached = !isMine && !pickedByTeamId && myPickCount >= maxIconPlayers;
      const statusText = isMine
        ? `Picked by you (${formatPrice(picked?.priceLakh || fixedPrice)})`
        : (pickedByTeamId
          ? `Taken by ${pickedByTeam?.short || pickedByTeamId}`
          : (limitReached ? `Limit reached (${myPickCount}/${maxIconPlayers})` : `Fixed ${formatPrice(fixedPrice)}`));

      const actionButton = isMine
        ? `<button class="btn btn-ghost iconpick-action" onclick="toggleIconPlayer('${pid}')">Remove</button>`
        : (pickedByTeamId
          ? `<button class="btn btn-ghost iconpick-action" disabled>Taken</button>`
          : (limitReached
            ? `<button class="btn btn-ghost iconpick-action" disabled>Limit reached</button>`
            : `<button class="btn btn-secondary iconpick-action" onclick="toggleIconPlayer('${pid}')">Pick</button>`));

      return `
        <div class="watchlist-row iconpick-row ${isMine ? 'selected' : ''}">
          <span class="watchlist-star">${isMine ? '🏷️' : '•'}</span>
          <span class="watchlist-player-name">${player.name}</span>
          <span class="watchlist-player-meta">${getRoleIcon(player.role)} ${player.role} · ${formatPrice(player.base_price_lakh || 0)}</span>
          <span class="iconpick-status">${statusText}</span>
          ${actionButton}
        </div>
      `;
    });

  list.innerHTML = rows.join('') || `<div class="state-empty" style="padding:0.8rem;color:var(--text-dim)">No players found.</div>`;
}

async function toggleIconPlayer(playerId) {
  if (!(roomConfig?.auctionType === 'manual')) return;
  const fixedPrice = Number(roomConfig?.iconPlayerPrice || 0);
  const maxIconPlayers = Number(roomConfig?.maxIconPlayers || 0);
  if (maxIconPlayers <= 0 || fixedPrice < 0) return;

  const roomSnap = await db.ref(`rooms/${roomCode}`).get();
  if (!roomSnap.exists()) return;
  const room = roomSnap.val() || {};
  if (room?.config?.status !== 'lobby') {
    showToast('Icon player selection is closed after auction starts.', 'error');
    return;
  }

  const teams = room.teams || {};
  const team = teams[myTeamId];
  if (!team) {
    showToast('Your team was not found in this room.', 'error');
    return;
  }

  const picks = room.iconPicks || {};
  const existing = picks[playerId] || picks[String(playerId)] || null;
  const maxSquadSize = Number(room?.config?.maxSquadSize || 0);
  const squadCount = (team.squad || []).length;
  const myIconCount = Object.values(picks).filter((pick) => pick?.teamId === myTeamId).length;

  if (existing && existing.teamId !== myTeamId) {
    const pickedTeam = teams[existing.teamId] || roomTeamCatalog[existing.teamId] || {};
    showToast(`Already taken by ${pickedTeam.short || existing.teamId}.`, 'error');
    return;
  }

  if (!existing) {
    if (myIconCount >= maxIconPlayers) {
      showToast(`You can pick only ${maxIconPlayers} icon player${maxIconPlayers > 1 ? 's' : ''}.`, 'error');
      return;
    }
    if (maxSquadSize > 0 && squadCount >= maxSquadSize) {
      showToast('Your squad is already full.', 'error');
      return;
    }
    if (Number(team.purse || 0) < fixedPrice) {
      showToast('Not enough purse for icon pick.', 'error');
      return;
    }
  }

  const tx = await db.ref(`rooms/${roomCode}`).transaction((curr) => {
    if (!curr) return curr;
    if (curr?.config?.status !== 'lobby') return;

    curr.iconPicks = curr.iconPicks || {};
    curr.soldPlayers = curr.soldPlayers || {};
    curr.teams = curr.teams || {};
    const txTeam = curr.teams[myTeamId];
    if (!txTeam) return;
    txTeam.squad = txTeam.squad || [];

    const txExisting = curr.iconPicks[playerId] || curr.iconPicks[String(playerId)] || null;
    const txMaxIcons = Number(curr?.config?.maxIconPlayers || 0);

    if (txExisting && txExisting.teamId === myTeamId) {
      delete curr.iconPicks[playerId];
      delete curr.iconPicks[String(playerId)];
      delete curr.soldPlayers[playerId];
      delete curr.soldPlayers[String(playerId)];
      txTeam.purse = Number(txTeam.purse || 0) + fixedPrice;
      txTeam.squad = txTeam.squad.filter((entry) => String(entry.playerId) !== String(playerId));
      return curr;
    }

    if (txExisting && txExisting.teamId !== myTeamId) {
      return;
    }

    const txMyIconCount = Object.values(curr.iconPicks).filter((pick) => pick?.teamId === myTeamId).length;
    if (txMaxIcons > 0 && txMyIconCount >= txMaxIcons) return;

    const txMaxSquad = Number(curr?.config?.maxSquadSize || 0);
    if (txMaxSquad > 0 && txTeam.squad.length >= txMaxSquad) return;
    if (Number(txTeam.purse || 0) < fixedPrice) return;

    const player = (curr.manualPlayers || []).find((p) => String(p.id) === String(playerId));
    if (!player) return;

    txTeam.purse = Number(txTeam.purse || 0) - fixedPrice;
    txTeam.squad.push({
      playerId: player.id,
      priceLakh: fixedPrice,
      type: 'icon',
      pickedAt: Date.now()
    });

    curr.iconPicks[playerId] = {
      teamId: myTeamId,
      priceLakh: fixedPrice,
      type: 'icon',
      playerName: player.name,
      pickedAt: Date.now()
    };
    curr.soldPlayers[playerId] = {
      teamId: myTeamId,
      soldPrice: fixedPrice,
      soldAt: Date.now(),
      via: 'icon'
    };

    return curr;
  });

  if (!tx.committed) {
    showToast('Could not update icon pick. Try again.', 'error');
    return;
  }

  const after = tx.snapshot.val() || {};
  const nowPicked = !!(after.iconPicks?.[playerId] && after.iconPicks[playerId].teamId === myTeamId);
  showToast(nowPicked ? 'Icon player selected.' : 'Icon player removed.', 'success');
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
    const soldPlayersSnap = await db.ref(`rooms/${roomCode}/soldPlayers`).get();
    const soldPlayers = soldPlayersSnap.exists() ? (soldPlayersSnap.val() || {}) : {};
    const eligiblePlayers = players.filter((p) => !soldPlayers[p.id] && !soldPlayers[String(p.id)]);

    const built = isManual
      ? { queue: eligiblePlayers.map(p => p.id), poolByIndex: {} }
      : buildPlayerQueue(eligiblePlayers, mode);
    const { queue, poolByIndex } = built;
    if (!queue.length) throw new Error('No players available for auction queue');

    // Write player queue
    await db.ref(`rooms/${roomCode}/playerQueue`).set(queue);
    await db.ref(`rooms/${roomCode}/poolByIndex`).set(poolByIndex);
    await db.ref(`rooms/${roomCode}/currentIndex`).set(0);

    // Set up first player auction
    const firstPlayerId = queue[0];
    const firstPlayer = eligiblePlayers.find(p => p.id === firstPlayerId);
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
  if (iconPicksListener) db.ref(`rooms/${roomCode}/iconPicks`).off('value', iconPicksListener);
});

window.openIconPickerModal = openIconPickerModal;
window.closeIconPickerModal = closeIconPickerModal;
window.renderIconPickerModal = renderIconPickerModal;
window.toggleIconPlayer = toggleIconPlayer;
