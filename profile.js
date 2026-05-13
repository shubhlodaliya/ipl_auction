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

function renderAuctionCard(row, type) {
  const roomCode = escapeHtml(String(row.roomCode || '').toUpperCase());
  const title = escapeHtml(row.title || 'Auction');
  const status = normalizeHistoryStatus(row.status);
  const startAt = Number(row.scheduledStartAt || 0) || 0;
  const updatedAt = Number(row.updatedAt || row.createdAt || 0) || 0;
  const { day, month } = formatDay(startAt || updatedAt);
  const statusClass = type === 'scheduled' ? 'scheduled' : (status === 'finished' ? 'finished' : 'live');
  const statusLabel = type === 'scheduled'
    ? 'Scheduled'
    : (status === 'finished' ? 'Finished' : status === 'auction' ? 'Live' : 'Lobby');
  const metaLine = type === 'scheduled'
    ? `Starts at ${formatDateTime(startAt)}`
    : `Updated ${formatDateTime(updatedAt)}`;

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
        <button class="ma-remind-btn" onclick="openProfileRoom('${roomCode}')">Open Room</button>
      </div>
    </div>`;
}

function renderAuctionList(listEl, rows, emptyMessage, type) {
  if (!listEl) return;
  if (!rows.length) {
    listEl.innerHTML = `<div class="profile-empty">${escapeHtml(emptyMessage)}</div>`;
    return;
  }
  listEl.innerHTML = rows.slice(0, 12).map((row) => renderAuctionCard(row, type)).join('');
}

function openProfileRoom(roomCode) {
  const code = String(roomCode || '').trim().toUpperCase();
  if (!code) return;

  const user = getCurrentUser();
  if (typeof saveSession === 'function' && user) {
    const displayName = String(user.displayName || user.email || 'Viewer').trim();
    saveSession({ roomCode: code, teamId: null, playerName: displayName, isHost: false, isSpectator: false });
  }

  window.location.href = 'lobby.html';
}

async function loadProfilePage() {
  // Ensure Firebase is fully initialized
  let dbRef = null;
  let maxAttempts = 100;
  
  while (maxAttempts-- > 0 && !dbRef) {
    try {
      dbRef = typeof db !== 'undefined' ? db : firebase.database();
      if (dbRef) break;
    } catch (e) {
      // Firebase not ready yet
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  
  if (!dbRef) {
    console.error('Firebase database not available');
    showToast('Firebase database not available', 'error');
    return;
  }

  const user = getCurrentUser();
  if (!user) {
    console.log('No user logged in, redirecting...');
    window.location.href = 'index.html';
    return;
  }

  console.log('Loading profile for user:', user.uid, user.email);

  try {
    // Try to fetch user profile and auction history
    let profileData = {};
    let historyData = {};
    
    try {
      const profileSnap = await dbRef.ref(`users/${user.uid}`).get();
      if (profileSnap.exists()) {
        profileData = profileSnap.val() || {};
      }
    } catch (err) {
      console.warn('Could not fetch user profile:', err);
    }
    
    try {
      const historySnap = await dbRef.ref(getHistoryPath(user.uid)).get();
      if (historySnap.exists()) {
        historyData = historySnap.val() || {};
      }
    } catch (err) {
      console.warn('Could not fetch auction history:', err);
    }
    
    // Use Firebase data, with fallback to Firebase Auth object
    const profile = profileData || {};
    const historyMap = historyData || {};

    // Extract user details - prefer database, fall back to Firebase Auth, then sensible defaults
    const name = String(profile.name || user.displayName || user.email || 'User').trim();
    const email = String(profile.email || user.email || '').trim() || '—';
    const createdAt = Number(profile.createdAt || parsePossibleDate(user.metadata?.creationTime) || Date.now()) || Date.now();
    const lastLoginAt = Number(profile.lastLoginAt || parsePossibleDate(user.metadata?.lastSignInTime) || Date.now()) || Date.now();
    const verified = typeof isUserVerified === 'function' ? isUserVerified(user) : !!user.emailVerified;

    console.log('Profile data loaded:', { name, email, verified, auctionCount: Object.keys(historyMap).length });
    
  // Update all profile fields
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
  const pastRows = rows.filter((row) => row.status === 'finished' || Number(row.finishedAt || 0) > 0 || Number(row.terminatedAt || 0) > 0)
         // Render auction lists
         renderAuctionList(
           document.getElementById('pastAuctionsList'),
           pastRows,
           'No past auctions yet. Finished auctions will appear here.',
           'past'
         );
         renderAuctionList(
           document.getElementById('scheduledAuctionsList'),
           scheduledRows,
           'No scheduled auctions yet. Create one from the home page to see it here.',
           'scheduled'
         );
    .sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0));

  renderAuctionList(
    document.getElementById('pastAuctionsList'),
    pastRows,
    'No past auctions yet. Finished auctions will appear here.',
    'past'
  );
  renderAuctionList(
    document.getElementById('scheduledAuctionsList'),
    scheduledRows,
    'No scheduled auctions yet. Create one from the home page to see it here.',
    'scheduled'
  );
  } catch (err) {
    console.error('Error loading profile data:', err);
    showToast('Failed to load profile data: ' + err.message, 'error');
  }
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
  if (refreshPastBtn) refreshPastBtn.addEventListener('click', () => loadProfilePage().catch((err) => {
    console.error('Failed to refresh profile:', err);
    showToast('Could not refresh profile data.', 'error');
  }));
  if (refreshScheduledBtn) refreshScheduledBtn.addEventListener('click', () => loadProfilePage().catch((err) => {
    console.error('Failed to refresh profile:', err);
    showToast('Could not refresh profile data.', 'error');
  }));
}

window.addEventListener('DOMContentLoaded', async () => {
  console.log('Profile page loading...');
  wireButtons();
  
  // Wait for auth to be ready
  if (typeof waitForAuthReady === 'function') {
    try {
      await waitForAuthReady();
      console.log('Auth ready');
    } catch (err) {
      console.error('Auth ready failed:', err);
    }
  }
  
  // Small delay to ensure Firebase is fully initialized
  await new Promise(resolve => setTimeout(resolve, 500));
  
  try {
    await loadProfilePage();
  } catch (err) {
    console.error('Profile page failed to load:', err);
    showToast('Failed to load profile data: ' + (err.message || String(err)), 'error');
  }
});