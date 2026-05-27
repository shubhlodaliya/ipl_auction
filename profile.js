
// ============================================================
// PROFILE.JS — Dedicated account profile page
// ============================================================

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getHistoryPath(uid) {
  return `users/${uid}/auctionHistory`;
}

function normalizeHistoryStatus(status) {
  const value = String(status || '').toLowerCase();
  if (value === 'auction') return 'auction';
  if (value === 'finished') return 'finished';
  return 'lobby';
}

function formatDateTime(ts) {
  const time = Number(ts || 0);
  if (!Number.isFinite(time) || time <= 0) return '—';
  try {
    return new Date(time).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  } catch (_) {
    return new Date(time).toLocaleString();
  }
}

function formatDay(ts) {
  const time = Number(ts || 0);
  if (!Number.isFinite(time) || time <= 0) return { day: '--', month: '---' };
  const date = new Date(time);
  return {
    day: String(date.getDate()).padStart(2, '0'),
    month: date.toLocaleString([], { month: 'short' }).toUpperCase()
  };
}

function parsePossibleDate(value) {
  if (!value) return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function getInitials(name = '', email = '') {
  const source = String(name || email || 'MA').trim();
  const parts = source.split(/\s+/).filter(Boolean);
  if (!parts.length) return 'MA';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] || ''}${parts[1][0] || ''}`.toUpperCase();
}

function getCurrentUser() {
  if (typeof getCurrentAuthUser === 'function') return getCurrentAuthUser();
  return firebase.auth().currentUser || null;
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function setStatusChip(verified, totalCount) {
  const chip = document.getElementById('profileStatusChip');
  if (chip) {
    chip.textContent = verified ? 'Verified account' : 'Email not verified';
    chip.style.background = verified ? 'rgba(34, 197, 94, 0.12)' : 'rgba(245, 158, 11, 0.14)';
    chip.style.color = verified ? '#8dffb4' : '#ffcf7a';
    chip.style.borderColor = verified ? 'rgba(34, 197, 94, 0.28)' : 'rgba(245, 158, 11, 0.28)';
  }
  const auctionCountChip = document.getElementById('profileAuctionCountChip');
  if (auctionCountChip) auctionCountChip.textContent = `${totalCount} auction${totalCount === 1 ? '' : 's'}`;
}

const PAST_AUCTIONS_PAGE_SIZE = 12;
let pastAuctionRowsCache = [];
let pastAuctionsExpanded = false;
let pastAuctionSearchQuery = '';

function renderAuctionCard(row, type) {
  const roomCode = escapeHtml(String(row.roomCode || '').toUpperCase());
  const title = escapeHtml(row.title || 'Auction');
  const status = normalizeHistoryStatus(row.status);
  const startAt = Number(row.scheduledStartAt || 0) || 0;
  const updatedAt = Number(row.updatedAt || row.createdAt || 0) || 0;
  const { day, month } = formatDay(startAt || updatedAt);
  const isTerminated = Number(row.terminatedAt || 0) > 0;
  const canDownloadPdf = type !== 'scheduled' && (isTerminated || status === 'finished');
  const statusClass = type === 'scheduled'
    ? 'scheduled'
    : (isTerminated || status === 'finished' ? 'finished' : 'live');
  const statusLabel = type === 'scheduled'
    ? 'Scheduled'
    : (isTerminated ? 'Terminated' : status === 'finished' ? 'Finished' : status === 'auction' ? 'Live' : 'Lobby');
  const metaLine = type === 'scheduled'
    ? `Starts at ${formatDateTime(startAt)}`
    : `Updated ${formatDateTime(updatedAt)}`;
  const actionLabel = type === 'scheduled'
    ? 'Open Lobby'
    : (isTerminated ? 'Restart Auction' : status === 'auction' ? 'Resume Auction' : status === 'finished' ? 'View Results' : 'Open Lobby');

  return `
    <div class="profile-auction-card">
      <div class="profile-auction-date">
        <div class="day">${escapeHtml(day)}</div>
        <div class="month">${escapeHtml(month)}</div>
      </div>
      <div class="profile-auction-body">
        <div class="profile-auction-title">${title} <span>#${roomCode}</span></div>
        <div class="profile-auction-meta">${escapeHtml(metaLine)}</div>
        <div class="profile-auction-sub">Room status: ${escapeHtml(statusLabel)}</div>
      </div>
      <div class="profile-auction-actions">
        <span class="profile-status-chip ${statusClass}">${escapeHtml(statusLabel)}</span>
        <button class="ma-remind-btn" onclick="openProfileRoom('${roomCode}')">${escapeHtml(actionLabel)}</button>
        ${canDownloadPdf ? `<button class="ma-remind-btn" onclick="downloadAuctionPdf('${roomCode}')">Download PDF</button>` : ''}
      </div>
    </div>`;
}

function downloadAuctionPdf(roomCode) {
  const code = String(roomCode || '').trim().toUpperCase();
  if (!code) return;
  const target = `results.html?room=${encodeURIComponent(code)}&pdf=1`;
  const win = window.open(target, '_blank');
  if (!win) {
    window.location.href = target;
  }
}

function renderAuctionList(listEl, rows, emptyMessage, type, limit = null) {
  if (!listEl) return;
  if (!rows.length) {
    listEl.innerHTML = `<div class="profile-empty">${escapeHtml(emptyMessage)}</div>`;
    return;
  }
  const limitedRows = Number.isFinite(limit) && limit > 0 ? rows.slice(0, limit) : rows;
  listEl.innerHTML = limitedRows.map((row) => renderAuctionCard(row, type)).join('');
}

function getFilteredPastRows() {
  const rows = Array.isArray(pastAuctionRowsCache) ? pastAuctionRowsCache : [];
  const query = String(pastAuctionSearchQuery || '').trim().toLowerCase();
  if (!query) return rows;

  return rows.filter((row) => {
    const title = String(row?.title || '').toLowerCase();
    const code = String(row?.roomCode || '').toLowerCase();
    return title.includes(query) || code.includes(query);
  });
}

function renderPastAuctionsSection() {
  const listEl = document.getElementById('pastAuctionsList');
  const viewMoreBtn = document.getElementById('viewMorePastBtn');
  const rows = getFilteredPastRows();
  const isSearching = String(pastAuctionSearchQuery || '').trim().length > 0;

  renderAuctionList(
    listEl,
    rows,
    isSearching
      ? 'No auctions match your search. Try another name or room code.'
      : 'No auctions yet. Reopened and restarted auctions will appear here with live status.',
    'past',
    pastAuctionsExpanded ? null : PAST_AUCTIONS_PAGE_SIZE
  );

  if (!viewMoreBtn) return;

  const hasMoreRows = rows.length > PAST_AUCTIONS_PAGE_SIZE;
  if (!hasMoreRows) {
    viewMoreBtn.style.display = 'none';
    return;
  }

  viewMoreBtn.style.display = 'inline-flex';
  viewMoreBtn.textContent = pastAuctionsExpanded ? 'View Less' : 'View More';
}

function openProfileRoom(roomCode) {
  const code = String(roomCode || '').trim().toUpperCase();
  if (!code) return;
  routeOwnedAuction(code).catch((err) => {
    console.error('Failed to open owned auction:', err);
    showToast('Could not open this auction right now.', 'error');
  });
}

function getOwnedHostTeamId(room) {
  const config = room?.config || {};
  const teams = room?.teams || {};
  const hostTeamId = String(config.hostTeamId || '').trim() || Object.keys(teams).find((id) => teams?.[id]?.isHost) || Object.keys(teams)[0] || '';
  return hostTeamId || null;
}

function getOwnedHostUid(room) {
  const config = room?.config || {};
  const teams = room?.teams || {};
  const hostTeamId = getOwnedHostTeamId(room);
  return String(config.hostUid || config.currentHostUid || teams?.[hostTeamId]?.ownerUid || '').trim();
}

function applyOwnerSession(roomCode, room, user, isHostSession = true) {
  const hostTeamId = getOwnedHostTeamId(room);
  const hostTeam = hostTeamId ? (room?.teams?.[hostTeamId] || {}) : {};
  const displayName = String(hostTeam.ownerName || user?.displayName || user?.email || 'Host').trim();

  if (typeof saveSession === 'function') {
    saveSession({
      roomCode,
      teamId: hostTeamId,
      playerName: displayName,
      isHost: !!isHostSession,
      isSpectator: false
    });
  }
}

async function syncOwnerHistory(roomCode, room, status, extra = {}) {
  const user = getCurrentUser();
  if (!user) return;
  const hostUid = getOwnedHostUid(room) || String(user.uid || '').trim();
  if (!hostUid) return;

  await db.ref(`${getHistoryPath(hostUid)}/${roomCode}`).update({
    roomCode,
    title: String(room?.config?.auctionTitle || '').trim() || (room?.config?.auctionType === 'manual' ? 'My Auction' : 'IPL Auction'),
    status,
    auctionType: room?.config?.auctionType || 'random',
    hostTeamId: getOwnedHostTeamId(room),
    updatedAt: Date.now(),
    ...extra
  }).catch(() => {});
}

async function reserveAvailableRoomCode(maxAttempts = 30) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const code = generateRoomCode();
    const snap = await db.ref(`rooms/${code}`).get();
    if (!snap.exists()) return code;
  }
  throw new Error('Could not generate unique room code');
}

async function restartAuctionFromSource(sourceCode, sourceRoom, user) {
  const sourceConfig = sourceRoom?.config || {};
  const authUid = String(user?.uid || '').trim();
  const hostUid = getOwnedHostUid(sourceRoom) || authUid;
  if (!authUid || !hostUid || hostUid !== authUid) {
    showToast('Only the original host can restart this auction.', 'error');
    return;
  }

  const hostTeamId = getOwnedHostTeamId(sourceRoom);
  if (!hostTeamId) {
    showToast('Host team is missing for this auction.', 'error');
    return;
  }

  const code = await reserveAvailableRoomCode();
  const isManual = sourceConfig.auctionType === 'manual';
  const hostTeam = sourceRoom?.teams?.[hostTeamId] || {};
  const hostName = String(hostTeam.ownerName || user?.displayName || user?.email || 'Host').trim();
  const budget = Number(sourceConfig.budget || hostTeam.purse || 2000);
  const now = Date.now();
  const clonedConfig = JSON.parse(JSON.stringify(sourceConfig || {}));
  delete clonedConfig.terminatedAt;
  delete clonedConfig.terminatedBy;
  delete clonedConfig.finishedAt;
  delete clonedConfig.reopenedAt;
  delete clonedConfig.reopenedBy;
  delete clonedConfig.updatedAt;

  const clonedTeams = {};
  Object.entries(sourceRoom?.teams || {}).forEach(([teamId, team]) => {
    clonedTeams[teamId] = {
      name: team?.name || teamId,
      short: team?.short || teamId,
      primary: team?.primary || '#1DA0FF',
      logo: team?.logo || '',
      ownerName: team?.ownerName || hostName,
      ownerUid: team?.ownerUid || authUid,
      purse: budget,
      squad: [],
      isHost: teamId === hostTeamId,
      joinedAt: now
    };
  });

  const roomPayload = {
    config: {
      ...clonedConfig,
      hostTeamId,
      hostUid: authUid,
      currentHostUid: authUid,
      budget,
      status: 'lobby',
      createdAt: now,
      auctionType: sourceConfig.auctionType || 'random',
      auctionTitle: String(sourceConfig.auctionTitle || '').trim() || (isManual ? 'My Auction' : 'IPL Auction'),
      bidOptions: Array.isArray(sourceConfig.bidOptions) && sourceConfig.bidOptions.length ? sourceConfig.bidOptions : [25, 50, 100],
      bidOptionsAll: Array.isArray(sourceConfig.bidOptionsAll) ? sourceConfig.bidOptionsAll : undefined,
      unlimitedTimer: !!sourceConfig.unlimitedTimer,
      hostBidsForAllTeams: !!sourceConfig.hostBidsForAllTeams
    },
    teams: clonedTeams
  };

  if (isManual) {
    roomPayload.manualTeams = sourceRoom.manualTeams && Object.keys(sourceRoom.manualTeams).length
      ? JSON.parse(JSON.stringify(sourceRoom.manualTeams))
      : IPL_TEAMS.reduce((acc, team) => {
          acc[team.id] = { ...team };
          return acc;
        }, {});
    roomPayload.manualPlayers = Array.isArray(sourceRoom.manualPlayers) ? JSON.parse(JSON.stringify(sourceRoom.manualPlayers)) : [];
  }

  await db.ref(`rooms/${code}`).set(roomPayload);
  await db.ref(`${getHistoryPath(authUid)}/${code}`).update({
    roomCode: code,
    title: roomPayload.config.auctionTitle,
    status: 'lobby',
    auctionType: roomPayload.config.auctionType,
    hostTeamId,
    createdAt: now,
    updatedAt: now,
    sourceRoomCode: sourceCode
  });

  applyOwnerSession(code, roomPayload, user, true);
  window.location.href = 'lobby.html';
}

async function routeOwnedAuction(roomCode) {
  const user = getCurrentUser();
  if (!user) {
    window.location.href = 'index.html';
    return;
  }

  const snap = await db.ref(`rooms/${roomCode}`).get();
  if (!snap.exists()) {
    showToast('Auction room no longer exists.', 'error');
    return;
  }

  const room = snap.val() || {};
  const config = room.config || {};
  const hostUid = getOwnedHostUid(room);
  if (hostUid && hostUid !== user.uid) {
    showToast('Only the original host can open this auction.', 'error');
    return;
  }

  const status = normalizeHistoryStatus(config.status);
  const terminatedAt = Number(config.terminatedAt || 0) || 0;

  if (terminatedAt) {
    await restartAuctionFromSource(roomCode, room, user);
    return;
  }

  applyOwnerSession(roomCode, room, user, true);

  if (status === 'auction') {
    await syncOwnerHistory(roomCode, room, 'auction');
    window.location.href = `auction.html?room=${encodeURIComponent(roomCode)}`;
    return;
  }

  if (status === 'finished') {
    await syncOwnerHistory(roomCode, room, 'finished');
    window.location.href = `results.html?room=${encodeURIComponent(roomCode)}`;
    return;
  }

  await syncOwnerHistory(roomCode, room, 'lobby');
  window.location.href = 'lobby.html';
}

async function loadProfilePage() {
  const user = getCurrentUser();
  if (!user) {
    window.location.href = 'index.html';
    return;
  }

  const profileSnap = await db.ref(`users/${user.uid}`).get();
  const historySnap = await db.ref(getHistoryPath(user.uid)).get();

  const profile = profileSnap.exists() ? (profileSnap.val() || {}) : {};
  const historyMap = historySnap.exists() ? (historySnap.val() || {}) : {};

  const name = String(profile.name || user.displayName || '').trim() || String(user.email || 'User').split('@')[0];
  const email = String(profile.email || user.email || '').trim() || '—';
  const createdAt = Number(profile.createdAt || parsePossibleDate(user.metadata?.creationTime) || 0) || 0;
  const lastLoginAt = Number(profile.lastLoginAt || parsePossibleDate(user.metadata?.lastSignInTime) || 0) || 0;
  const verified = typeof isUserVerified === 'function' ? isUserVerified(user) : true;

  setText('profileName', name);
  setText('profileIntro', `Welcome back, ${name}. Your auction history and upcoming rooms are listed below.`);
  setText('profileFullName', name);
  setText('profileEmail', email);
  setText('profileCreatedAt', formatDateTime(createdAt));
  setText('profileLastLoginAt', formatDateTime(lastLoginAt));
  setText('profileAvatar', getInitials(name, email));
  setText('profileAvatarName', name);
  setText('profileAvatarSub', email);
  setStatusChip(verified, Object.keys(historyMap || {}).length);

  const rows = Object.values(historyMap)
    .filter((row) => row && row.roomCode)
    .map((row) => ({
      ...row,
      roomCode: String(row.roomCode || '').toUpperCase(),
      status: normalizeHistoryStatus(row.status),
      scheduledStartAt: Number(row.scheduledStartAt || 0) || 0,
      createdAt: Number(row.createdAt || 0) || 0,
      updatedAt: Number(row.updatedAt || row.createdAt || 0) || 0
    }))
    .sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0));

  const scheduledRows = rows.filter((row) => row.status === 'lobby' && Number(row.scheduledStartAt || 0) > 0)
    .sort((a, b) => Number(a.scheduledStartAt || 0) - Number(b.scheduledStartAt || 0));
  const pastRows = rows.filter((row) => !(row.status === 'lobby' && Number(row.scheduledStartAt || 0) > 0))
    .sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0));

  pastAuctionsExpanded = false;
  pastAuctionRowsCache = pastRows;
  renderPastAuctionsSection();

  renderAuctionList(
    document.getElementById('scheduledAuctionsList'),
    scheduledRows,
    'No scheduled auctions yet. Create one from the home page to see it here.',
    'scheduled',
    12
  );
}

function showToast(msg, type = '') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.className = 'toast show ' + type;
  setTimeout(() => { toast.className = 'toast'; }, 2500);
}

function wireButtons() {
  const refreshPastBtn = document.getElementById('refreshPastBtn');
  const refreshScheduledBtn = document.getElementById('refreshScheduledBtn');
  const viewMorePastBtn = document.getElementById('viewMorePastBtn');
  const pastAuctionSearch = document.getElementById('pastAuctionSearch');

  if (refreshPastBtn) refreshPastBtn.addEventListener('click', () => loadProfilePage().catch((err) => {
    console.error('Failed to refresh profile:', err);
    showToast('Could not refresh profile data.', 'error');
  }));

  if (refreshScheduledBtn) refreshScheduledBtn.addEventListener('click', () => loadProfilePage().catch((err) => {
    console.error('Failed to refresh profile:', err);
    showToast('Could not refresh profile data.', 'error');
  }));

  if (viewMorePastBtn) viewMorePastBtn.addEventListener('click', () => {
    pastAuctionsExpanded = !pastAuctionsExpanded;
    renderPastAuctionsSection();
  });

  if (pastAuctionSearch) pastAuctionSearch.addEventListener('input', () => {
    pastAuctionSearchQuery = String(pastAuctionSearch.value || '').trim();
    pastAuctionsExpanded = false;
    renderPastAuctionsSection();
  });
}

window.addEventListener('DOMContentLoaded', async () => {
  wireButtons();
  if (typeof waitForAuthReady === 'function') {
    await waitForAuthReady();
  }
  try {
    await loadProfilePage();
  } catch (err) {
    console.error('Profile page failed to load:', err);
    showToast('Failed to load profile data.', 'error');
  }
});