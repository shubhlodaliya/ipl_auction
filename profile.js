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
    let dbRef = null;
    let attempts = 80;

    while (attempts-- > 0 && !dbRef) {
      try {
        dbRef = typeof db !== 'undefined' ? db : firebase.database();
      } catch (_) {
        dbRef = null;
      }
      if (!dbRef) await new Promise((resolve) => setTimeout(resolve, 50));
    }

    if (!dbRef) {
      showToast('Firebase database not available', 'error');
      return;
    }

    const user = getCurrentUser();
    if (!user) {
      window.location.href = 'index.html';
      return;
    }

    try {
      const [profileSnap, historySnap] = await Promise.all([
        dbRef.ref(`users/${user.uid}`).get(),
        dbRef.ref(getHistoryPath(user.uid)).get()
      ]);

      const profile = profileSnap.exists() ? (profileSnap.val() || {}) : {};
      const historyMap = historySnap.exists() ? (historySnap.val() || {}) : {};

      const name = String(profile.name || user.displayName || user.email || 'User').trim();
      const email = String(profile.email || user.email || '').trim() || '—';
      const createdAt = Number(profile.createdAt || parsePossibleDate(user.metadata?.creationTime) || 0) || 0;
      const lastLoginAt = Number(profile.lastLoginAt || parsePossibleDate(user.metadata?.lastSignInTime) || 0) || 0;
      const verified = typeof isUserVerified === 'function' ? isUserVerified(user) : !!user.emailVerified;

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

      const scheduledRows = rows
        .filter((row) => row.status === 'lobby' && Number(row.scheduledStartAt || 0) > 0)
        .sort((a, b) => Number(a.scheduledStartAt || 0) - Number(b.scheduledStartAt || 0));

      const pastRows = rows
        .filter((row) => row.status === 'finished' || Number(row.finishedAt || 0) > 0 || Number(row.terminatedAt || 0) > 0)
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
      showToast('Failed to load profile data: ' + (err.message || String(err)), 'error');
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