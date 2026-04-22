// ============================================================
// CREATE.JS — Room creation & join from the landing page
// ============================================================

let selectedCreateTeam = null;
let selectedJoinTeam = null;
let joinRoomListener = null; // Firebase listener for join team check

function normalizePlayerName(name = '') {
  return String(name).trim().toLowerCase();
}

function getAuthUid() {
  return String(localStorage.getItem('ipl_auth_uid') || '').trim();
}

function formatHistoryDate(ts) {
  const time = Number(ts || 0);
  if (!Number.isFinite(time) || time <= 0) return 'Unknown time';
  try {
    return new Date(time).toLocaleString();
  } catch (_) {
    return 'Unknown time';
  }
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getHistoryPath(authUid) {
  return `users/${authUid}/auctionHistory`;
}

function normalizeHistoryStatus(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'auction') return 'auction';
  if (s === 'finished') return 'finished';
  return 'lobby';
}

function mapRoomToHistoryRow(roomCode, room) {
  const config = room?.config || {};
  const createdAt = Number(config.createdAt || 0) || Date.now();
  const updatedAt = Number(config.updatedAt || config.finishedAt || config.terminatedAt || createdAt) || createdAt;
  const auctionType = config.auctionType || (room?.manualPlayers ? 'manual' : 'random');
  const fallbackTitle = auctionType === 'manual' ? 'My Auction' : 'IPL Auction';
  return {
    roomCode,
    title: String(config.auctionTitle || '').trim() || fallbackTitle,
    status: normalizeHistoryStatus(config.status),
    auctionType,
    hostTeamId: config.hostTeamId || null,
    createdAt,
    updatedAt,
    migratedFromRoom: true
  };
}

async function getHostOwnedRooms(authUid) {
  if (!authUid) return [];
  const roomsSnap = await db.ref('rooms').get();
  if (!roomsSnap.exists()) return [];
  const rooms = roomsSnap.val() || {};
  return Object.entries(rooms)
    .filter(([roomCode, room]) => {
      if (!roomCode || !room?.config) return false;
      const hostUid = String(room.config.hostUid || room.config.currentHostUid || '').trim();
      if (hostUid && hostUid === authUid) return true;

      const hostTeamId = room.config.hostTeamId || Object.keys(room.teams || {}).find((id) => room.teams?.[id]?.isHost) || null;
      const hostTeamOwnerUid = String(room.teams?.[hostTeamId]?.ownerUid || '').trim();
      return !!hostTeamOwnerUid && hostTeamOwnerUid === authUid;
    })
    .map(([roomCode, room]) => mapRoomToHistoryRow(roomCode, room));
}

window.addEventListener('DOMContentLoaded', initCreatePage);

function initCreatePage() {
  initAuctionModeToggle();
  initSquadRangeControls();
  renderPastAuctions();
  window.addEventListener('focus', renderPastAuctions);
  window.addEventListener('storage', (event) => {
    if (!event || !String(event.key || '').startsWith('ipl_auth_')) return;
    renderPastAuctions();
  });
}

async function renderPastAuctions() {
  const listEl = document.getElementById('pastAuctionsList');
  if (!listEl) return;

  const authUid = getAuthUid();
  if (!authUid) {
    listEl.innerHTML = '<div class="state-empty" style="padding:0.85rem 0;"><p style="font-size:0.82rem;">Login to view your past auctions.</p></div>';
    return;
  }

  listEl.innerHTML = '<div class="state-loading" style="padding:0.85rem 0;"><div class="spinner"></div></div>';

  try {
    const [historySnap, hostedRows] = await Promise.all([
      db.ref(getHistoryPath(authUid)).get(),
      getHostOwnedRooms(authUid)
    ]);

    const historyMap = historySnap.exists() ? (historySnap.val() || {}) : {};
    const merged = new Map();

    Object.values(historyMap)
      .filter((item) => item && item.roomCode)
      .forEach((item) => {
        const roomCode = String(item.roomCode || '').toUpperCase();
        if (!roomCode) return;
        merged.set(roomCode, {
          ...item,
          roomCode,
          status: normalizeHistoryStatus(item.status)
        });
      });

    const backfillWrites = [];
    hostedRows.forEach((row) => {
      const roomCode = String(row.roomCode || '').toUpperCase();
      if (!roomCode) return;
      if (!merged.has(roomCode)) {
        merged.set(roomCode, row);
        backfillWrites.push(
          db.ref(`${getHistoryPath(authUid)}/${roomCode}`).update({
            ...row,
            updatedAt: Date.now(),
            syncedAt: Date.now()
          }).catch(() => {})
        );
        return;
      }

      const existing = merged.get(roomCode) || {};
      const existingUpdatedAt = Number(existing.updatedAt || existing.createdAt || 0);
      const rowUpdatedAt = Number(row.updatedAt || row.createdAt || 0);
      if (rowUpdatedAt > existingUpdatedAt) {
        merged.set(roomCode, {
          ...existing,
          ...row,
          roomCode
        });
      }
    });

    if (backfillWrites.length) {
      Promise.all(backfillWrites).catch(() => {});
    }

    const rows = Array.from(merged.values())
      .sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0));

    if (!rows.length) {
      listEl.innerHTML = '<div class="state-empty" style="padding:0.85rem 0;"><p style="font-size:0.82rem;">No past auctions yet.</p></div>';
      return;
    }

    listEl.innerHTML = rows.slice(0, 20).map((row) => {
      const title = escapeHtml(row.title || 'Untitled Auction');
      const roomCode = escapeHtml(String(row.roomCode || '').toUpperCase());
      const status = String(row.status || 'lobby').toLowerCase();
      const statusClass = status === 'auction' ? 'auction' : status === 'finished' ? 'finished' : 'lobby';
      const updatedAtLabel = formatHistoryDate(row.updatedAt || row.createdAt);
      return `
        <div class="past-auction-card">
          <div class="past-auction-top">
            <div>
              <div class="past-auction-title">${title}</div>
              <div class="past-auction-code">Room: ${roomCode}</div>
            </div>
            <span class="past-auction-status ${statusClass}">${escapeHtml(status)}</span>
          </div>
          <div class="past-auction-meta">Updated: ${escapeHtml(updatedAtLabel)}</div>
          <div class="past-auction-actions">
            <button class="btn btn-secondary" type="button" onclick="reopenPastAuction('${roomCode}')">Reopen</button>
            <button class="btn btn-ghost" type="button" onclick="restartPastAuction('${roomCode}')">Restart</button>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Failed to load past auctions:', err);
    listEl.innerHTML = '<div class="state-empty" style="padding:0.85rem 0;"><p style="font-size:0.82rem;">Could not load past auctions.</p></div>';
  }
}

async function reserveAvailableRoomCode(maxAttempts = 30) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const code = generateRoomCode();
    const snap = await db.ref(`rooms/${code}`).get();
    if (!snap.exists()) return code;
  }
  throw new Error('Could not generate unique room code');
}

async function upsertAuctionHistory(authUid, roomCode, patch = {}) {
  if (!authUid || !roomCode) return;
  const now = Date.now();
  await db.ref(`${getHistoryPath(authUid)}/${roomCode}`).update({
    roomCode,
    updatedAt: now,
    ...patch
  });
}

async function reopenPastAuction(roomCode) {
  const authUid = getAuthUid();
  if (!authUid) {
    showToast('Please login first.', 'error');
    return;
  }

  try {
    const snap = await db.ref(`rooms/${roomCode}`).get();
    if (!snap.exists()) {
      showToast('Auction room no longer exists.', 'error');
      return;
    }

    const room = snap.val() || {};
    const config = room.config || {};
    const hostUid = String(config.hostUid || '').trim();
    if (hostUid && hostUid !== authUid) {
      showToast('Only the original host can reopen this auction.', 'error');
      return;
    }

    const hostTeamId = config.hostTeamId || Object.keys(room.teams || {}).find((id) => room.teams[id]?.isHost) || Object.keys(room.teams || {})[0] || null;
    const hostName = room.teams?.[hostTeamId]?.ownerName || String(localStorage.getItem('ipl_auth_name') || '').trim() || 'Host';

    let targetStatus = String(config.status || 'lobby').toLowerCase();
    const queue = Array.isArray(room.playerQueue) ? room.playerQueue : [];
    const idx = Number(room.currentIndex || 0);
    const hasRemainingPlayers = queue.length > 0 && idx < queue.length;

    // Reopen should resume from existing room state without resetting sold/unsold progress.
    // If a room is marked finished but still has remaining players, move it back to live auction.
    if (targetStatus === 'finished' && hasRemainingPlayers) {
      targetStatus = 'auction';
      await db.ref(`rooms/${roomCode}/config`).update({
        status: 'auction',
        reopenedAt: Date.now(),
        reopenedBy: authUid
      });
    }

    await upsertAuctionHistory(authUid, roomCode, {
      title: String(config.auctionTitle || '').trim() || (config.auctionType === 'manual' ? 'My Auction' : 'IPL Auction'),
      status: targetStatus,
      auctionType: config.auctionType || 'random',
      hostTeamId: hostTeamId || null
    });

    saveSession({ roomCode, teamId: hostTeamId, playerName: hostName, isHost: true });
    if (targetStatus === 'auction') {
      window.location.href = `auction.html?room=${encodeURIComponent(roomCode)}`;
    } else if (targetStatus === 'finished') {
      window.location.href = `results.html?room=${encodeURIComponent(roomCode)}`;
    } else {
      window.location.href = 'lobby.html';
    }
  } catch (err) {
    console.error('Reopen failed:', err);
    showToast('Failed to reopen auction.', 'error');
  }
}

async function restartPastAuction(sourceCode) {
  const authUid = getAuthUid();
  if (!authUid) {
    showToast('Please login first.', 'error');
    return;
  }

  try {
    const sourceSnap = await db.ref(`rooms/${sourceCode}`).get();
    if (!sourceSnap.exists()) {
      showToast('Original auction room not found.', 'error');
      return;
    }

    const sourceRoom = sourceSnap.val() || {};
    const sourceConfig = sourceRoom.config || {};
    const hostUid = String(sourceConfig.hostUid || '').trim();
    if (hostUid && hostUid !== authUid) {
      showToast('Only the original host can restart this auction.', 'error');
      return;
    }

    const code = await reserveAvailableRoomCode();
    const hostTeamId = sourceConfig.hostTeamId || Object.keys(sourceRoom.teams || {}).find((id) => sourceRoom.teams[id]?.isHost) || Object.keys(sourceRoom.teams || {})[0] || null;
    if (!hostTeamId) {
      showToast('Host team is missing in the source auction.', 'error');
      return;
    }

    const sourceHostTeam = sourceRoom.teams?.[hostTeamId] || {};
    const sourceManualTeams = sourceRoom.manualTeams || {};
    const isManual = sourceConfig.auctionType === 'manual';
    const sourceBidOptions = Array.isArray(sourceConfig.bidOptionsAll) && sourceConfig.bidOptionsAll.length
      ? sourceConfig.bidOptionsAll
      : (Array.isArray(sourceConfig.bidOptions) && sourceConfig.bidOptions.length ? sourceConfig.bidOptions : [25, 50, 100]);
    const restartBidOptions = sourceBidOptions.length > 1 ? sourceBidOptions : [25, 50, 100];
    const hostTeamMeta = isManual
      ? (sourceManualTeams[hostTeamId] || sourceHostTeam || getTeam(hostTeamId))
      : (getTeam(hostTeamId) || sourceHostTeam);
    const hostName = sourceHostTeam.ownerName || String(localStorage.getItem('ipl_auth_name') || '').trim() || 'Host';
    const budget = Number(sourceConfig.budget || sourceHostTeam.purse || 2000);

    const sourceTeams = sourceRoom.teams || {};
    const sourceTeamIds = Object.keys(sourceTeams);
    const clonedTeams = {};
    if (sourceTeamIds.length) {
      sourceTeamIds.forEach((teamId) => {
        const team = sourceTeams[teamId] || {};
        clonedTeams[teamId] = {
          name: team.name || teamId,
          short: team.short || teamId,
          primary: team.primary || '#1DA0FF',
          logo: team.logo || '',
          ownerName: team.ownerName || hostName,
          ownerUid: team.ownerUid || authUid,
          purse: budget,
          squad: [],
          isHost: teamId === hostTeamId,
          joinedAt: Date.now()
        };
      });
    } else {
      clonedTeams[hostTeamId] = {
        name: hostTeamMeta?.name || sourceHostTeam.name || hostTeamId,
        short: hostTeamMeta?.short || sourceHostTeam.short || hostTeamId,
        primary: hostTeamMeta?.primary || sourceHostTeam.primary || '#1DA0FF',
        logo: hostTeamMeta?.logo || sourceHostTeam.logo || '',
        ownerName: hostName,
        ownerUid: authUid,
        purse: budget,
        squad: [],
        isHost: true,
        joinedAt: Date.now()
      };
    }

    const roomPayload = {
      config: {
        hostTeamId,
        hostUid: authUid,
        currentHostUid: authUid,
        budget,
        maxSquadSize: Number(sourceConfig.maxSquadSize || 25),
        minSquadSize: Number(sourceConfig.minSquadSize || 11),
        timerSeconds: Number(sourceConfig.timerSeconds || 30),
        auctionMode: sourceConfig.auctionMode || 'random',
        invitePasscode: sourceConfig.invitePasscode || '',
        status: 'lobby',
        createdAt: Date.now(),
        auctionType: sourceConfig.auctionType || 'random',
        auctionTitle: String(sourceConfig.auctionTitle || '').trim() || (sourceConfig.auctionType === 'manual' ? 'My Auction' : 'IPL Auction'),
        bidOptions: restartBidOptions,
        bidOptionsAll: sourceBidOptions,
        unlimitedTimer: !!sourceConfig.unlimitedTimer,
        hostBidsForAllTeams: !!sourceConfig.hostBidsForAllTeams
      },
      teams: clonedTeams
    };

    if (isManual) {
      roomPayload.manualTeams = Object.keys(sourceManualTeams).length
        ? sourceManualTeams
        : IPL_TEAMS.reduce((acc, team) => {
            acc[team.id] = { ...team };
            return acc;
          }, {});
      roomPayload.manualPlayers = Array.isArray(sourceRoom.manualPlayers)
        ? sourceRoom.manualPlayers
        : [];
    }

    await db.ref(`rooms/${code}`).set(roomPayload);

    await upsertAuctionHistory(authUid, code, {
      roomCode: code,
      title: roomPayload.config.auctionTitle,
      status: 'lobby',
      auctionType: roomPayload.config.auctionType,
      hostTeamId,
      createdAt: Date.now(),
      sourceRoomCode: sourceCode
    });

    saveSession({ roomCode: code, teamId: hostTeamId, playerName: hostName, isHost: true });
    showToast('Auction restarted with a new room.', 'success');
    window.location.href = 'lobby.html';
  } catch (err) {
    console.error('Restart failed:', err);
    showToast('Failed to restart auction.', 'error');
  }
}

window.renderPastAuctions = renderPastAuctions;
window.reopenPastAuction = reopenPastAuction;
window.restartPastAuction = restartPastAuction;

function initSquadRangeControls() {
  const maxEl = document.getElementById('squadRange');
  const minEl = document.getElementById('minSquadRange');
  const maxValEl = document.getElementById('squadVal');
  const minValEl = document.getElementById('minSquadVal');
  if (!maxEl || !minEl) return;

  const sync = () => {
    const maxSquad = Number(maxEl.value || 25);
    minEl.max = String(Math.max(1, maxSquad));
    if (Number(minEl.value) > maxSquad) {
      minEl.value = String(maxSquad);
    }
    if (maxValEl) maxValEl.textContent = `${maxEl.value} players`;
    if (minValEl) minValEl.textContent = `${minEl.value} players`;
  };

  maxEl.addEventListener('input', sync);
  minEl.addEventListener('input', sync);
  sync();
}

function initAuctionModeToggle() {
  const options = document.querySelectorAll('#auctionModeToggle .mode-option');
  options.forEach(opt => {
    const input = opt.querySelector('input[type="radio"]');
    if (!input) return;

    input.addEventListener('change', () => {
      options.forEach(x => x.classList.remove('active'));
      if (input.checked) opt.classList.add('active');
    });
  });
}

// Render team grid for Create Room tab
function renderCreateTeamGrid() {
  const grid = document.getElementById('createTeamGrid');
  grid.innerHTML = IPL_TEAMS.map(t => `
    <div class="team-option" id="create-team-${t.id}"
         onclick="selectCreateTeam('${t.id}')"
         title="${t.name}"
         style="--team-color:${t.primary}">
      <img class="team-logo" src="${t.logo}" alt="${t.short} logo" loading="lazy" decoding="async" />
      <div class="team-short" style="color:${t.primary}">${t.short}</div>
    </div>
  `).join('');
}

function selectCreateTeam(teamId) {
  selectedCreateTeam = teamId;
  document.getElementById('createTeamId').value = teamId;
  document.querySelectorAll('#createTeamGrid .team-option').forEach(el => {
    el.classList.toggle('selected', el.id === `create-team-${teamId}`);
  });
}

// Check room code and show available teams for Join tab
let checkTimeout = null;
function checkRoomCode(code) {
  clearTimeout(checkTimeout);
  selectedJoinTeam = null;
  if (code.length < 6) {
    document.getElementById('joinTeamGrid').innerHTML = `
      <div style="grid-column:1/-1;padding:1rem;text-align:center;color:var(--text-dim);font-size:0.85rem;">
        Enter room code to see available teams
      </div>`;
    return;
  }
  // Debounce
  checkTimeout = setTimeout(() => fetchRoomTeams(code), 400);
}

async function fetchRoomTeams(code) {
  const grid = document.getElementById('joinTeamGrid');
  grid.innerHTML = `<div class="state-loading" style="grid-column:1/-1"><div class="spinner"></div></div>`;

  const snap = await db.ref(`rooms/${code}`).get();
  if (!snap.exists()) {
    grid.innerHTML = `<div style="grid-column:1/-1;padding:1rem;text-align:center;color:var(--red);font-size:0.85rem;">❌ Room not found</div>`;
    return;
  }

  const room = snap.val();
  if (room.config.status === 'finished') {
    grid.innerHTML = `<div style="grid-column:1/-1;padding:1rem;text-align:center;color:var(--red);font-size:0.85rem;">This auction has already ended.</div>`;
    return;
  }

  const isAuctionLive = room.config.status === 'auction';

  const takenTeams = Object.keys(room.teams || {});
  const sourceTeams = room.config?.auctionType === 'manual'
    ? Object.values(room.manualTeams || {})
    : IPL_TEAMS;

  grid.innerHTML = sourceTeams.map(t => {
    const taken = takenTeams.includes(t.id);
    const selectable = isAuctionLive ? taken : !taken;
    const slotClass = isAuctionLive
      ? (taken ? 'rejoin-open' : 'locked-live')
      : (taken ? 'taken' : '');

    return `
      <div class="team-option ${slotClass}" id="join-team-${t.id}"
           onclick="${selectable ? `selectJoinTeam('${t.id}')` : ''}"
           title="${t.name}"
           style="--team-color:${t.primary}">
        <img class="team-logo" src="${t.logo}" alt="${t.short} logo" loading="lazy" decoding="async" />
        <div class="team-short" style="color:${t.primary}">${t.short}</div>
      </div>
    `;
  }).join('');
}

function selectJoinTeam(teamId) {
  selectedJoinTeam = teamId;
  document.getElementById('joinTeamId').value = teamId;
  document.querySelectorAll('#joinTeamGrid .team-option').forEach(el => {
    el.classList.toggle('selected', el.id === `join-team-${teamId}`);
  });
}

// ============================================================
// CREATE ROOM
// ============================================================
async function createRoom() {
  if (typeof requireAuthForAction === 'function' && !requireAuthForAction('Please login before creating an auction room.')) {
    return;
  }

  const name = document.getElementById('createName').value.trim();
  const teamId = selectedCreateTeam;
  const passcode = document.getElementById('createPasscode').value.trim();
  const budget = parseInt(document.getElementById('budgetRange').value);
  const maxSquad = parseInt(document.getElementById('squadRange').value);
  const minSquad = parseInt(document.getElementById('minSquadRange').value || '1');
  const timerSec = parseInt(document.getElementById('timerRange').value);
  const auctionMode = document.querySelector('input[name="auctionMode"]:checked')?.value || 'random';
  const authUid = getAuthUid();

  const errEl = document.getElementById('createError');
  errEl.style.display = 'none';

  if (!name) { showError(errEl, 'Please enter your name.'); return; }
  if (!teamId) { showError(errEl, 'Please select an IPL team.'); return; }
  if (!passcode) { showError(errEl, 'Please set a room passcode.'); return; }
  if (!Number.isFinite(minSquad) || minSquad < 1) { showError(errEl, 'Minimum squad size must be at least 1.'); return; }
  if (minSquad > maxSquad) { showError(errEl, 'Minimum squad size cannot be greater than maximum squad size.'); return; }

  const btn = document.getElementById('createBtn');
  btn.disabled = true;
  btn.textContent = 'Creating...';

  try {
    const code = generateRoomCode();
    const team = getTeam(teamId);

    await db.ref(`rooms/${code}`).set({
      config: {
        hostTeamId: teamId,
        hostUid: authUid || null,
        currentHostUid: authUid || null,
        budget,
        maxSquadSize: maxSquad,
        minSquadSize: minSquad,
        timerSeconds: timerSec,
        auctionMode,
        invitePasscode: passcode,
        status: 'lobby',
        createdAt: Date.now()
      },
      teams: {
        [teamId]: {
          name: team.name,
          short: team.short,
          primary: team.primary,
          logo: team.logo,
          ownerName: name,
          ownerUid: authUid || null,
          purse: budget,
          squad: [],
          isHost: true,
          joinedAt: Date.now()
        }
      }
    });

    await upsertAuctionHistory(authUid, code, {
      roomCode: code,
      title: 'IPL Auction',
      status: 'lobby',
      auctionType: 'random',
      hostTeamId: teamId,
      hostName: name,
      createdAt: Date.now()
    });

    saveSession({ roomCode: code, teamId, playerName: name, isHost: true });
    window.location.href = 'lobby.html';

  } catch (err) {
    console.error(err);
    showError(errEl, 'Failed to create room. Check your Firebase config.');
    btn.disabled = false;
    btn.textContent = '🚀 Create Auction Room';
  }
}

// ============================================================
// JOIN ROOM
// ============================================================
async function joinRoom() {
  if (typeof requireAuthForAction === 'function' && !requireAuthForAction('Please login before joining an auction room.')) {
    return;
  }

  const code = document.getElementById('joinCode').value.trim().toUpperCase();
  const name = document.getElementById('joinName').value.trim();
  const passcode = document.getElementById('joinPasscode').value.trim();
  const teamId = selectedJoinTeam;
  const authUid = getAuthUid();

  const errEl = document.getElementById('joinError');
  errEl.style.display = 'none';

  if (code.length !== 6) { showError(errEl, 'Enter a valid 6-character room code.'); return; }
  if (!name) { showError(errEl, 'Please enter your name.'); return; }
  if (!teamId) { showError(errEl, 'Please pick an IPL team.'); return; }
  if (!passcode) { showError(errEl, 'Passcode is required.'); return; }

  const btn = document.getElementById('joinBtn');
  btn.disabled = true;
  btn.textContent = 'Joining...';

  try {
    const snap = await db.ref(`rooms/${code}`).get();
    if (!snap.exists()) { showError(errEl, 'Room not found. Check the code and try again.'); btn.disabled = false; btn.textContent = '🚀 Join Auction'; return; }

    const room = snap.val();
    const roomStatus = room.config.status;
    if (roomStatus === 'finished') { showError(errEl, 'This auction has ended.'); btn.disabled = false; btn.textContent = '🚀 Join Auction'; return; }
    if (!room.config.invitePasscode || room.config.invitePasscode !== passcode) {
      showError(errEl, 'Invalid room passcode.');
      btn.disabled = false;
      btn.textContent = '🚀 Join Auction';
      return;
    }

    const existing = room.teams && room.teams[teamId];

    if (roomStatus === 'auction') {
      if (!existing) {
        showError(errEl, 'Auction is live. New teams cannot join now.');
        btn.disabled = false;
        btn.textContent = '🚀 Join Auction';
        return;
      }

      const ownerUid = String(existing.ownerUid || '').trim();
      const ownerName = normalizePlayerName(existing.ownerName);
      const inputName = normalizePlayerName(name);
      const uidMatch = !!ownerUid && !!authUid && ownerUid === authUid;
      const nameFallbackMatch = !ownerUid && ownerName && inputName && ownerName === inputName;

      if (!uidMatch && !nameFallbackMatch) {
        showError(errEl, 'Only the original player for this team can rejoin live auction.');
        btn.disabled = false;
        btn.textContent = '🚀 Join Auction';
        return;
      }

      const rejoinUpdates = {
        lastRejoinedAt: Date.now()
      };
      if (!ownerUid && authUid && nameFallbackMatch) {
        rejoinUpdates.ownerUid = authUid;
      }

      await db.ref(`rooms/${code}/teams/${teamId}`).update(rejoinUpdates);

      saveSession({
        roomCode: code,
        teamId,
        playerName: existing.ownerName || name,
        isHost: !!existing.isHost
      });
      window.location.href = `auction.html?room=${encodeURIComponent(code)}`;
      return;
    }

    if (existing) { showError(errEl, 'That team is already taken! Pick another.'); btn.disabled = false; btn.textContent = '🚀 Join Auction'; return; }

    const team = room.config?.auctionType === 'manual'
      ? (room.manualTeams && room.manualTeams[teamId])
      : getTeam(teamId);
    if (!team) {
      showError(errEl, 'Selected team is invalid for this room.');
      btn.disabled = false;
      btn.textContent = '🚀 Join Auction';
      return;
    }
    await db.ref(`rooms/${code}/teams/${teamId}`).set({
      name: team.name,
      short: team.short,
      primary: team.primary,
      logo: team.logo,
      ownerName: name,
      ownerUid: authUid || null,
      purse: room.config.budget,
      squad: [],
      isHost: false,
      joinedAt: Date.now()
    });

    saveSession({ roomCode: code, teamId, playerName: name, isHost: false });
    window.location.href = 'lobby.html';

  } catch (err) {
    console.error(err);
    showError(errEl, 'Failed to join room. Check your connection.');
    btn.disabled = false;
    btn.textContent = '🚀 Join Auction';
  }
}

// ============================================================
// WATCH LIVE AUCTION (SPECTATOR)
// ============================================================
async function watchLiveAuction() {
  const code = document.getElementById('joinCode').value.trim().toUpperCase();
  const name = document.getElementById('joinName').value.trim();

  const errEl = document.getElementById('joinError');
  errEl.style.display = 'none';

  if (code.length !== 6) {
    showError(errEl, 'Enter a valid 6-character room code.');
    return;
  }

  const btn = document.getElementById('watchLiveBtn');
  btn.disabled = true;
  btn.textContent = 'Opening Live Auction...';

  try {
    const snap = await db.ref(`rooms/${code}`).get();
    if (!snap.exists()) {
      showError(errEl, 'Room not found. Check the code and try again.');
      btn.disabled = false;
      btn.textContent = '👀 Watch Live Auction';
      return;
    }

    const room = snap.val();
    const status = room?.config?.status;
    if (status !== 'auction') {
      if (status === 'finished') {
        showError(errEl, 'This auction has ended.');
      } else {
        showError(errEl, 'This room is not live yet. Ask host to start auction first.');
      }
      btn.disabled = false;
      btn.textContent = '👀 Watch Live Auction';
      return;
    }

    saveSession({
      roomCode: code,
      teamId: null,
      playerName: name || 'Viewer',
      isHost: false,
      isSpectator: true
    });
    window.location.href = `auction.html?room=${encodeURIComponent(code)}`;
  } catch (err) {
    console.error(err);
    showError(errEl, 'Failed to open live auction. Check your connection.');
    btn.disabled = false;
    btn.textContent = '👀 Watch Live Auction';
  }
}

function showError(el, msg) {
  el.textContent = msg;
  el.style.display = 'block';
}
