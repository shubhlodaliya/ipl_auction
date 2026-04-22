// ============================================================
// AUCTION.JS — Core real-time bidding engine
// ============================================================

const auctionUrlParams = new URLSearchParams(window.location.search);
const session = getSession();
const roomCode = (session && session.roomCode) || String(auctionUrlParams.get('room') || '').trim();
if (!roomCode) {
  window.location.href = 'index.html';
  throw new Error('No room specified');
}
const myTeamId = session?.teamId || null;
const playerName = session?.playerName || 'Viewer';
let isHost = !!session?.isHost;
const isSpectator = !!session?.isSpectator || !session?.teamId || auctionUrlParams.get('view') === 'spectator' || !session;
const isHostManager = !!isHost && !myTeamId;

let roomConfig = null;
let hostProxyBidTeamId = null;
let allPlayers = [];
let playerMap = {};
let currentAuctionData = null;
let playerQueue = [];
let currentIndex = 0;
let timerInterval = null;
let timerSeconds = 30;
let unlimitedTimer = false;
let processingRound = false;
let teamsData = {};
let soldPlayersData = {};
let paused = false;
let pausedAt = null;
let poolByIndex = {};
let lastPoolNoticeId = null;
let poolIndexMap = {};
let removedFromRoom = false;
let isManualAuction = false;
let roomTeamCatalog = {};
let watchlistForMe = {};
let chatMessages = {};
let chatMutedMap = {};
let isChatMuted = false;
let lastChatSentAt = 0;
let seenChatMessageIds = {};
let chatEffectsReady = false;
let voiceParticipants = {};
let voiceHostMutedMap = {};
let isVoiceHostMuted = false;
let voiceJoined = false;
let voiceMutedSelf = false;
let localVoiceStream = null;
let voicePeerState = {};
let voiceSocket = null;
let voiceSocketConnected = false;
let soundEnabled = true;
let lastTimerSoundSecond = -1;
let lastAnnouncedResultKey = '';
let cleanupRequested = false;
let magneticPointerEnabled = false;
let activeMagneticButton = null;
let autoWithdrawInFlightForPlayerId = null;
let chatPopupDragState = { dragging: false, pointerId: null, offsetX: 0, offsetY: 0 };
let serverTimeOffsetMs = 0;
let spectatorSessionId = null;
let spectatorPollPlayerId = null;
let spectatorPollVotes = {};
let spectatorPollRef = null;
let lastSpectatorPollOutcomeKey = '';
let roomHostUid = null;
let currentHostUid = null;
let hostPresenceMap = {};
let hostPresenceRef = null;
let hostClaimInFlight = false;
const avatarBorderVariantClass = 'border-bold';
const voiceFeatureEnabled = false;
const voiceRtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

function getAuctionBrandTitle() {
  const title = String(roomConfig?.auctionTitle || '').trim();
  if (title) return title;
  return roomConfig?.auctionType === 'manual' ? 'My Auction' : 'IPL Auction';
}

function getPlayerDisplayNumber(player) {
  if (!player) return null;

  const explicitCandidates = [
    player.player_number,
    player.playerNumber,
    player.number,
    player.set_number
  ];

  for (const candidate of explicitCandidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0) return Math.floor(value);
  }

  const idText = String(player.id || '').trim();
  const idMatch = idText.match(/(?:^|_)(\d+)$/);
  if (idMatch?.[1]) {
    const parsed = Number(idMatch[1]);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  const index = allPlayers.findIndex((p) => String(p?.id || '') === idText);
  if (index >= 0) return index + 1;
  return null;
}

function buildPlayerNumberBadgeHtml(player, compact = false) {
  const num = getPlayerDisplayNumber(player);
  if (!num) return '';
  const cls = compact ? 'player-number-badge compact' : 'player-number-badge';
  return `<span class="${cls}">${num}</span>`;
}

function applyAuctionBranding() {
  const title = getAuctionBrandTitle();
  const logo = document.querySelector('.header .logo');
  if (logo) logo.textContent = `🏏 ${title}`;
  const bannerTitle = document.getElementById('broadcastBannerTitle');
  if (bannerTitle) bannerTitle.textContent = title;
  document.title = `Auction — ${title}`;
}

function updateLiveListButtonsVisibility() {
  const actions = document.getElementById('liveListActions');
  if (!actions) return;
  actions.style.display = isManualAuction ? 'flex' : 'none';
}

async function syncAuctionHistoryStatus(status, extra = {}) {
  const hostUid = String(roomHostUid || roomConfig?.hostUid || getLocalAuthUid() || '').trim();
  if (!hostUid || !roomCode) return;
  const payload = {
    roomCode,
    title: getAuctionBrandTitle(),
    status,
    auctionType: roomConfig?.auctionType || 'random',
    hostTeamId: roomConfig?.hostTeamId || null,
    updatedAt: Date.now(),
    ...extra
  };
  await db.ref(`users/${hostUid}/auctionHistory/${roomCode}`).update(payload).catch(() => {});
}

async function backfillManualAuctionTitle() {
  if (!isHost || roomConfig?.auctionType !== 'manual') return;
  const existing = String(roomConfig?.auctionTitle || '').trim();
  if (existing) return;
  const fallbackTitle = 'My Auction';
  roomConfig.auctionTitle = fallbackTitle;
  try {
    await db.ref(`rooms/${roomCode}/config/auctionTitle`).set(fallbackTitle);
  } catch (_) {
    // Keep local fallback even if write fails.
  }
}

// ---- Firebase listeners ----
let listeners = {};

function isHostProxyBiddingEnabled() {
  return !!isManualAuction && !!roomConfig?.hostBidsForAllTeams;
}

function isHostProxyBidderActive() {
  return !!isHost && isHostProxyBiddingEnabled();
}

function isBidUiSpectator() {
  return !!isSpectator && !isHostProxyBidderActive();
}

function getActingTeamIdForBidUi() {
  return isHostProxyBidderActive() ? hostProxyBidTeamId : myTeamId;
}

function getHostProxyTeamIds() {
  const catalogIds = Object.keys(roomTeamCatalog || {});
  if (catalogIds.length) return catalogIds;
  return Object.keys(teamsData || {});
}

function getHostProxyTeamState(teamId) {
  if (!teamId) return null;
  const liveTeam = teamsData?.[teamId] || {};
  const catalogTeam = roomTeamCatalog?.[teamId] || getTeam(teamId) || {};
  return {
    ...catalogTeam,
    ...liveTeam,
    id: teamId,
    name: liveTeam.name || catalogTeam.name || teamId,
    short: liveTeam.short || catalogTeam.short || teamId,
    primary: liveTeam.primary || catalogTeam.primary || '#1DA0FF',
    logo: liveTeam.logo || catalogTeam.logo || '',
    purse: Number.isFinite(Number(liveTeam.purse))
      ? Number(liveTeam.purse)
      : Number.isFinite(Number(catalogTeam.purse))
        ? Number(catalogTeam.purse)
        : Number(roomConfig?.budget || 0),
    squad: Array.isArray(liveTeam.squad) ? liveTeam.squad : []
  };
}

function ensureHostProxyBidTeamSelected() {
  if (!isHostProxyBidderActive()) return;
  const availableTeamIds = getHostProxyTeamIds();
  if (hostProxyBidTeamId && availableTeamIds.includes(hostProxyBidTeamId)) return;
  if (myTeamId && availableTeamIds.includes(myTeamId)) {
    hostProxyBidTeamId = myTeamId;
    return;
  }
  const first = availableTeamIds[0];
  hostProxyBidTeamId = first || null;
}

function selectHostProxyBidTeam(teamId) {
  if (!teamId) return;
  hostProxyBidTeamId = String(teamId);
  renderHostProxyBidPanel();
  updateMyPurse();
  if (currentAuctionData) {
    renderBidDisplay(currentAuctionData);
  }
}

async function handleHostProxyBidTeamClick(teamId) {
  if (!teamId) return;
  const nextTeamId = String(teamId);
  selectHostProxyBidTeam(nextTeamId);

  if (!isHostProxyBidderActive()) return;
  if (!currentAuctionData || currentAuctionData.status !== 'bidding' || paused) return;

  if (!currentAuctionData.highestBidder) {
    await placeBid(0, true);
    return;
  }

  const currentPlayer = playerMap[currentAuctionData.playerId];
  if (!currentPlayer) return;

  const allowedJumps = getBidJumpOptions(currentPlayer.base_price_lakh, roomConfig?.bidOptions);
  if (allowedJumps.length !== 1) return;

  const jump = allowedJumps[0];
  const actingTeam = getHostProxyTeamState(nextTeamId);
  if (!actingTeam) return;

  const nextBid = currentAuctionData.currentBid + jump;
  const isWithdrawn = !!currentAuctionData.withdrawnTeams?.[nextTeamId];
  const isLeading = currentAuctionData.highestBidder === nextTeamId;
  const squadFull = (actingTeam.squad || []).length >= roomConfig.maxSquadSize;
  const canAfford = actingTeam.purse >= nextBid;
  if (isWithdrawn || isLeading || squadFull || !canAfford) return;

  await placeBid(jump);
}

function renderHostProxyBidPanel() {
  const wrap = document.getElementById('hostProxyBidWrap');
  const list = document.getElementById('hostProxyBidTeams');
  if (!wrap || !list) return;

  if (!isHostProxyBidderActive()) {
    wrap.style.display = 'none';
    list.innerHTML = '';
    return;
  }

  ensureHostProxyBidTeamSelected();
  wrap.style.display = 'block';

  const teamIds = getHostProxyTeamIds();
  if (!teamIds.length) {
    list.innerHTML = '<div class="bid-history-empty">Waiting for teams...</div>';
    return;
  }

  list.innerHTML = teamIds.map((teamId) => {
    const team = getHostProxyTeamState(teamId) || {};
    const meta = getRoomTeamMeta(teamId) || {};
    const name = team.name || meta.name || teamId;
    const short = team.short || meta.short || teamId;
    const activeClass = teamId === hostProxyBidTeamId ? 'active' : '';
    const logo = meta.logo
      ? `<img class="host-proxy-team-logo" src="${meta.logo}" alt="${short} logo" loading="lazy" decoding="async" />`
      : '';
    return `
      <button type="button" class="host-proxy-team-btn ${activeClass}" onclick="handleHostProxyBidTeamClick('${teamId}')">
        ${logo}
        <span class="host-proxy-team-text">
          <span class="host-proxy-team-short">${short}</span>
          <span class="host-proxy-team-name">${name}</span>
        </span>
      </button>
    `;
  }).join('');
}

window.selectHostProxyBidTeam = selectHostProxyBidTeam;
window.handleHostProxyBidTeamClick = handleHostProxyBidTeamClick;

function getRoomTeamMeta(teamId) {
  return roomTeamCatalog[teamId] || teamsData[teamId] || getTeam(teamId);
}

function getSyncedNowMs() {
  return Date.now() + serverTimeOffsetMs;
}

function getLocalAuthUid() {
  return typeof getAuthUid === 'function' ? getAuthUid() : String(localStorage.getItem('ipl_auth_uid') || '').trim();
}

function isCurrentHostPresent() {
  return !!currentHostUid && !!hostPresenceMap[currentHostUid];
}

function canDriveAuctionEngine() {
  if (isSpectator && !isHostManager) return false;
  if (isHost) return true;
  return !isCurrentHostPresent();
}

function updateHostControlsUi() {
  const hostControls = document.getElementById('hostAuctionControls');
  if (!hostControls) return;
  hostControls.style.display = (isHost && (!isSpectator || isHostManager)) ? 'flex' : 'none';
}

function syncLocalHostState() {
  const authUid = getLocalAuthUid();
  const ownsOriginalHost = !!roomHostUid && authUid === roomHostUid;
  isHost = !!authUid && currentHostUid === authUid;

  if (!isHost && ownsOriginalHost && (!currentHostUid || currentHostUid !== authUid)) {
    return claimHostAuthority('original host rejoined');
  }

  updateHostControlsUi();
  saveSession(session ? { ...session, isHost } : { roomCode, teamId: myTeamId, playerName, isHost });
  return Promise.resolve(false);
}

async function claimHostAuthority(reason = 'host takeover') {
  if (hostClaimInFlight || (isSpectator && !isHostManager)) return false;

  const authUid = getLocalAuthUid();
  if (!authUid) return false;

  const canClaimAsOriginalHost = !!roomHostUid && authUid === roomHostUid;
  const canClaimAsFallbackHost = !isCurrentHostPresent() && (!currentHostUid || currentHostUid === roomHostUid);
  if (!canClaimAsOriginalHost && !canClaimAsFallbackHost && currentHostUid === authUid) {
    isHost = true;
    updateHostControlsUi();
    saveSession(session ? { ...session, isHost: true } : { roomCode, teamId: myTeamId, playerName, isHost: true });
    registerHostPresence();
    return true;
  }
  if (!canClaimAsOriginalHost && !canClaimAsFallbackHost) return false;

  hostClaimInFlight = true;
  try {
    const ref = db.ref(`rooms/${roomCode}/config/currentHostUid`);
    const result = await ref.transaction((currentValue) => {
      if (authUid === roomHostUid) return authUid;
      if (!isCurrentHostPresent() && (!currentValue || currentValue === roomHostUid)) return authUid;
      if (currentValue === authUid) return currentValue;
      return currentValue;
    });

    if (result.committed && result.snapshot && result.snapshot.val() === authUid) {
      currentHostUid = authUid;
      isHost = true;
      updateHostControlsUi();
      saveSession(session ? { ...session, isHost: true } : { roomCode, teamId: myTeamId, playerName, isHost: true });
      registerHostPresence();
      if (reason) showToast(authUid === roomHostUid ? 'Host authority restored.' : 'Host authority transferred.', 'success');
      return true;
    }
    return false;
  } catch (err) {
    console.warn('Failed to claim host authority:', err);
    return false;
  } finally {
    hostClaimInFlight = false;
  }
}

function getOrCreateSpectatorSessionId() {
  const key = 'ipl_spectator_id';
  const existing = sessionStorage.getItem(key);
  if (existing) return existing;
  const generated = `sp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  sessionStorage.setItem(key, generated);
  return generated;
}

function registerHostPresence() {
  if (isSpectator || !isHost) return;
  const authUid = getLocalAuthUid();
  if (!authUid) return;

  unregisterHostPresenceListener();

  if (!hostPresenceRef || hostPresenceRef.key !== authUid) {
    hostPresenceRef = db.ref(`rooms/${roomCode}/hostPresence/${authUid}`);
  }

  listeners.hostConnected = db.ref('.info/connected').on('value', snap => {
    if (!snap.val() || !isHost) return;
    hostPresenceRef.onDisconnect().remove();
    hostPresenceRef.set({
      joinedAt: firebase.database.ServerValue.TIMESTAMP,
      teamId: myTeamId,
      playerName: playerName || 'Host'
    }).catch((err) => {
      console.warn('Failed to register host presence:', err);
    });
  });
}

function unregisterHostPresenceListener() {
  if (listeners.hostConnected) {
    db.ref('.info/connected').off('value', listeners.hostConnected);
    listeners.hostConnected = null;
  }
}

function updateSpectatorCountBadge(count = 0) {
  const badge = document.getElementById('spectatorCountBadge');
  if (!badge) return;
  const n = Number.isFinite(Number(count)) ? Number(count) : 0;
  badge.textContent = `👀 ${n} watching`;
}

function renderAuctionCodeChip() {
  const codeChip = document.getElementById('auctionRoomCodeChip');
  if (!codeChip) return;
  codeChip.textContent = `Room: ${roomCode}`;

  const spectatorCode = document.getElementById('spectatorRoomCode');
  if (spectatorCode) spectatorCode.textContent = `Room Code: ${roomCode}`;
}

function listenSpectatorCount() {
  listeners.spectatorCount = db.ref(`rooms/${roomCode}/spectators`).on('value', snap => {
    const viewers = snap.val() || {};
    updateSpectatorCountBadge(Object.keys(viewers).length);
  });
}

function registerSpectatorPresence() {
  if (!isSpectator) return;
  spectatorSessionId = getOrCreateSpectatorSessionId();
  const spectatorRef = db.ref(`rooms/${roomCode}/spectators/${spectatorSessionId}`);

  listeners.spectatorConnected = db.ref('.info/connected').on('value', snap => {
    if (!snap.val()) return;
    spectatorRef.onDisconnect().remove();
    spectatorRef.set({
      joinedAt: firebase.database.ServerValue.TIMESTAMP,
      viewerName: playerName || 'Viewer'
    }).catch((err) => {
      console.warn('Failed to register spectator presence:', err);
    });
  });
}

function removeSpectatorPresence() {
  if (!isSpectator || !spectatorSessionId) return;
  db.ref(`rooms/${roomCode}/spectators/${spectatorSessionId}`).remove().catch(() => {});
}

async function requestCloudinaryCleanup() {
  if (cleanupRequested || !isHost || !isManualAuction) return;
  cleanupRequested = true;
  try {
    await fetch('/api/cloudinary-cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomCode })
    });
  } catch (err) {
    console.warn('Cloudinary cleanup failed:', err);
  }
}

// ---- INIT ----
window.addEventListener('DOMContentLoaded', initAuction);

async function initAuction() {
  soundEnabled = localStorage.getItem('ipl_sound_enabled') !== '0';
  updateSoundToggleButton();

  // Host: show pass button
  if (isHost) {
    document.getElementById('hostAuctionControls').style.display = 'flex';
  }

  // Load room data
  const roomSnap = await db.ref(`rooms/${roomCode}`).get();
  if (!roomSnap.exists()) { alert('Room not found'); window.location.href = 'index.html'; return; }
  const room = roomSnap.val();
  roomConfig = room.config || {};
  await backfillManualAuctionTitle();
  applyAuctionBranding();
  roomHostUid = roomConfig.hostUid || null;
  currentHostUid = roomConfig.currentHostUid || roomConfig.hostUid || null;
  const authUid = getLocalAuthUid();

  // Backward compatibility: recover host identity for rooms created before host UID fields existed.
  if (!roomHostUid) {
    const hostTeam = (room.teams || {})[roomConfig.hostTeamId];
    roomHostUid = hostTeam?.ownerUid || null;
    if (!roomHostUid && isHost && authUid) {
      roomHostUid = authUid;
    }
  }
  if (!currentHostUid) {
    currentHostUid = roomHostUid || null;
  }

  if (roomHostUid && roomConfig.hostUid !== roomHostUid) {
    db.ref(`rooms/${roomCode}/config/hostUid`).set(roomHostUid).catch(() => {});
  }
  if (currentHostUid && roomConfig.currentHostUid !== currentHostUid) {
    db.ref(`rooms/${roomCode}/config/currentHostUid`).set(currentHostUid).catch(() => {});
  }

  isManualAuction = roomConfig.auctionType === 'manual';
  unlimitedTimer = !!roomConfig.unlimitedTimer || roomConfig.timerMode === 'unlimited' || Number(roomConfig.timerSeconds) === 0;
  roomTeamCatalog = isManualAuction
    ? (room.manualTeams || {})
    : Object.fromEntries(IPL_TEAMS.map(t => [t.id, t]));
  timerSeconds = roomConfig.timerSeconds || 30;
  updateLiveListButtonsVisibility();

  // Load players
  allPlayers = isManualAuction ? (room.manualPlayers || []) : await loadPlayers();
  allPlayers.forEach(p => { playerMap[p.id] = p; });

  // Show my team chip
  if (isHostManager) {
    const chip = document.getElementById('myTeamChip');
    chip.style.display = 'flex';
    chip.textContent = 'HOST MANAGER';
  } else if (isSpectator) {
    const chip = document.getElementById('myTeamChip');
    chip.style.display = 'none';
  } else {
    const me = getRoomTeamMeta(myTeamId);
    if (me) {
      const chip = document.getElementById('myTeamChip');
      chip.style.display = 'flex';
      chip.innerHTML = `${me.logo ? `<img class="chip-team-logo" src="${me.logo}" alt="${me.short} logo" loading="lazy" decoding="async" />` : ''} ${me.short}`;
      if (me.primary) {
        chip.style.borderColor = me.primary + '60';
        chip.style.color = me.primary;
      }
    }
  }

  if (!isSpectator || isHostManager) {
    await syncLocalHostState();
    if (authUid && roomHostUid && authUid === roomHostUid && currentHostUid !== authUid) {
      await claimHostAuthority('original host rejoined');
    }
  }

  // Load player queue
  const queueSnap = await db.ref(`rooms/${roomCode}/playerQueue`).get();
  if (queueSnap.exists()) {
    const queueVal = queueSnap.val();
    if (Array.isArray(queueVal)) playerQueue = queueVal;
    else playerQueue = Object.values(queueVal || {});
  }

  const poolSnap = await db.ref(`rooms/${roomCode}/poolByIndex`).get();
  if (poolSnap.exists()) poolByIndex = poolSnap.val() || {};
  buildPoolIndexMap();

  // Show auction UI
  document.getElementById('waitingScreen').style.display = 'none';
  document.getElementById('auctionLayout').style.display = 'grid';
  initBidButtonMagneticHover();
  initChatPopup();
  applySpectatorUi();
  renderAuctionCodeChip();
  listenSpectatorCount();
  registerSpectatorPresence();

  listeners.currentHostUid = db.ref(`rooms/${roomCode}/config/currentHostUid`).on('value', snap => {
    currentHostUid = snap.val() || null;
    syncLocalHostState().catch?.(() => {});
    const authUid = getLocalAuthUid();
    if ((!isSpectator || isHostManager) && !isHost && (!currentHostUid || (authUid && roomHostUid && authUid === roomHostUid && currentHostUid !== authUid))) {
      claimHostAuthority('host takeover').catch(() => {});
    }
  });

  listeners.hostPresence = db.ref(`rooms/${roomCode}/hostPresence`).on('value', snap => {
    hostPresenceMap = snap.val() || {};
    if ((!isSpectator || isHostManager) && !isHost) {
      claimHostAuthority('host takeover').catch(() => {});
    }
  });

  if ((!isSpectator || isHostManager) && isHost) {
    registerHostPresence();
  }

  // Listen to teams (sidebar)
  listeners.teams = db.ref(`rooms/${roomCode}/teams`).on('value', snap => {
    teamsData = snap.val() || {};

    // If this client's team no longer exists, the host removed them.
    if (!isSpectator && !teamsData[myTeamId]) {
      if (!removedFromRoom) {
        removedFromRoom = true;
        showToast('You were removed from this auction by host.', 'error');
        setTimeout(() => {
          leaveVoiceChat();
          clearSession();
          window.location.href = 'index.html';
        }, 900);
      }
      return;
    }

    renderSidebar();
    updateMyPurse();
    renderHostProxyBidPanel();
    if (isBidUiSpectator()) renderSpectatorPredictionPoll(currentAuctionData);
  });

  listeners.soldPlayers = db.ref(`rooms/${roomCode}/soldPlayers`).on('value', snap => {
    soldPlayersData = snap.val() || {};
    renderCurrentPoolBanner();
  });

  listeners.pause = db.ref(`rooms/${roomCode}/auctionControl`).on('value', snap => {
    const ctl = snap.val() || {};
    paused = !!ctl.paused;
    pausedAt = ctl.pausedAt || null;
    updateAuctionStatusBadge();
    if (currentAuctionData) renderBidDisplay(currentAuctionData);
  });

  // Listen to currentIndex
  listeners.index = db.ref(`rooms/${roomCode}/currentIndex`).on('value', snap => {
    if (snap.val() !== null) currentIndex = snap.val();
    updateProgressBar();
    renderCurrentPoolBanner();
  });

  // Listen to currentAuction (main)
  listeners.auction = db.ref(`rooms/${roomCode}/currentAuction`).on('value', snap => {
    if (!snap.exists()) return;
    const prevAuctionData = currentAuctionData;
    currentAuctionData = snap.val();
    processingRound = false;
    renderAuction(currentAuctionData, prevAuctionData);
    if (isSpectator && !isHostProxyBidderActive()) {
      updateBroadcastView(currentAuctionData);
    }
    hostEvaluateFastPath(currentAuctionData);
  });

  if (!isSpectator) {
    listeners.watchlist = db.ref(`rooms/${roomCode}/watchlists/${myTeamId}`).on('value', snap => {
      watchlistForMe = snap.val() || {};
      if (currentAuctionData && currentAuctionData.playerId) {
        const currentPlayer = playerMap[currentAuctionData.playerId];
        if (currentPlayer) renderPlayerSpotlight(currentPlayer);
      }
    });
  }

  listeners.chatMessages = db.ref(`rooms/${roomCode}/chat/messages`).limitToLast(80).on('value', snap => {
    const nextMessages = snap.val() || {};
    handleIncomingQuickChatEffects(nextMessages);
    chatMessages = nextMessages;
    renderChatMessages();
  });

  listeners.chatMutedMap = db.ref(`rooms/${roomCode}/chat/muted`).on('value', snap => {
    chatMutedMap = snap.val() || {};
    renderChatMessages();
  });

  if (!isSpectator) {
    listeners.chatMuted = db.ref(`rooms/${roomCode}/chat/muted/${myTeamId}`).on('value', snap => {
      isChatMuted = !!snap.val();
      updateChatMuteState();
    });
  }

  listeners.serverTimeOffset = db.ref('.info/serverTimeOffset').on('value', snap => {
    const offset = Number(snap.val());
    serverTimeOffsetMs = Number.isFinite(offset) ? offset : 0;
  });

  if (voiceFeatureEnabled && !isSpectator) {
    initVoiceSocket();
    updateVoiceControls();
    renderVoiceParticipants();
    // Auto-connect user to room voice chat on auction entry.
    joinVoiceChat().catch((err) => {
      console.warn('Auto voice join skipped:', err);
    });
  }

  // Listen to room status (finished → results)
  listeners.status = db.ref(`rooms/${roomCode}/config/status`).on('value', snap => {
    if (snap.val() === 'finished') {
      if (voiceFeatureEnabled) leaveVoiceChat();
      // NOTE: Do NOT cleanup Cloudinary here.
      // Re-auction uses the same room and still needs manual player images.
      // Cleanup is triggered when the host clicks "New Auction" from results.
      setTimeout(() => { window.location.href = `results.html?room=${encodeURIComponent(roomCode)}`; }, 2000);
    }
  });

  // Start local timer tick
  timerInterval = setInterval(timerTick, 500);
}

function applySpectatorUi() {
  if (!isSpectator || isHostProxyBidderActive()) return;

  document.body.classList.add('spectator-mode');
  document.body.classList.add('broadcast-mode');

  const broadcastView = document.getElementById('broadcastView');
  if (broadcastView) broadcastView.style.display = 'flex';

  const auctionLayout = document.getElementById('auctionLayout');
  if (auctionLayout) auctionLayout.style.display = 'none';

  const header = document.querySelector('.header');
  if (header) header.style.display = 'none';

  const statusBadge = document.getElementById('auctionStatus');
  if (statusBadge) {
    statusBadge.textContent = 'LIVE VIEW';
    statusBadge.style.background = 'rgba(29,160,255,0.15)';
    statusBadge.style.color = 'var(--blue)';
  }

  const purseEl = document.getElementById('myPurseDisplay');
  if (purseEl) purseEl.textContent = 'Viewer';

  const bidPanel = document.querySelector('.bid-panel');
  if (bidPanel) bidPanel.style.display = 'none';

  const spectatorPanel = document.getElementById('spectatorPanel');
  if (spectatorPanel) spectatorPanel.style.display = 'none';

  const sideBid = document.getElementById('spectatorSideBid');
  if (sideBid) sideBid.style.display = 'flex';
  updateSpectatorSideBid(currentAuctionData);

  updateLiveListButtonsVisibility();

  const soundToggleBtn = document.getElementById('soundToggleBtn');
  if (soundToggleBtn) soundToggleBtn.style.display = isHostManager ? 'inline-flex' : 'none';

  const chatToggleBtn = document.getElementById('chatToggleBtn');
  if (chatToggleBtn) {
    chatToggleBtn.style.display = isHostManager ? 'inline-flex' : 'none';
  }

  const voiceStatusBadge = document.getElementById('voiceStatusBadge');
  if (voiceStatusBadge) voiceStatusBadge.style.display = 'none';

  const hostControls = document.getElementById('hostAuctionControls');
  if (hostControls) hostControls.style.display = isHost ? 'flex' : 'none';

  const chatInput = document.getElementById('chatInput');
  if (chatInput) {
    chatInput.disabled = !isHostManager;
    chatInput.placeholder = isHostManager ? 'Type message...' : 'Viewer mode: chat disabled';
  }

  const chatSendBtn = document.getElementById('chatSendBtn');
  if (chatSendBtn) chatSendBtn.disabled = !isHostManager;

  const voiceJoinBtn = document.getElementById('voiceJoinBtn');
  if (voiceJoinBtn) {
    voiceJoinBtn.disabled = true;
    voiceJoinBtn.textContent = 'Viewer';
  }

  const voiceMuteBtn = document.getElementById('voiceMuteBtn');
  if (voiceMuteBtn) {
    voiceMuteBtn.disabled = true;
    voiceMuteBtn.textContent = 'Mute';
  }
}

function updateSpectatorSideBid(data = null) {
  if (!isSpectator) return;

  const wrap = document.getElementById('spectatorSideBid');
  const logoEl = document.getElementById('spectatorSideTeamLogo');
  const nameEl = document.getElementById('spectatorSideTeamName');
  const bidEl = document.getElementById('spectatorSideBidAmount');
  if (!wrap || !logoEl || !nameEl || !bidEl) return;

  const current = data || currentAuctionData;
  if (!current) {
    logoEl.innerHTML = '--';
    nameEl.textContent = 'No bids yet';
    bidEl.textContent = '₹—';
    return;
  }

  bidEl.textContent = formatPrice(current.currentBid);
  if (!current.highestBidder) {
    logoEl.innerHTML = '--';
    nameEl.textContent = 'No bids yet';
    return;
  }

  const team = teamsData[current.highestBidder] || getRoomTeamMeta(current.highestBidder) || {};
  const short = team.short || team.name || current.highestBidder;
  if (team.logo) {
    logoEl.innerHTML = `<img src="${team.logo}" alt="${short} logo" loading="lazy" decoding="async" />`;
  } else {
    logoEl.textContent = String(short).slice(0, 3).toUpperCase();
  }
  nameEl.textContent = team.name || short;
}

function updateBroadcastView(data) {
  if (!data) return;
  const broadcastViewEl = document.getElementById('broadcastView');
  if (broadcastViewEl) {
    const state = data.status === 'sold'
      ? 'state-sold'
      : data.status === 'unsold'
        ? 'state-unsold'
        : (data.highestBidder ? 'state-livebid' : 'state-prebid');
    broadcastViewEl.classList.remove('state-prebid', 'state-livebid', 'state-sold', 'state-unsold');
    broadcastViewEl.classList.add(state);
  }

  const player = playerMap[data.playerId];
  const fallbackAvatar = `data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect width=%22100%22 height=%22100%22 rx=%2216%22 fill=%22%232f4058%22/><text x=%2250%22 y=%2255%22 fill=%22%23a98cff%22 font-size=%2240%22 font-family=%22Arial%22 text-anchor=%22middle%22 alignment-baseline=%22central%22>🏏</text></svg>`;

  const buildBroadcastPlayerLines = (playerData) => {
    if (!playerData) return [];

    const roleText = String(playerData.role || '').trim();
    const categoryText = String(playerData.category || '').trim();
    const countryText = String(playerData.country || '').trim();
    const ageText = String(playerData.age || '').trim();
    const lines = [];

    if (roleText) {
      lines.push(`${getRoleIcon(roleText)} ${roleText}`);
    }

    if (categoryText && categoryText.toLowerCase() !== 'manual' && categoryText.toLowerCase() !== roleText.toLowerCase()) {
      lines.push(`Category: ${categoryText}`);
    }

    if (countryText && countryText.toLowerCase() !== 'manual') {
      lines.push(`${getCountryFlag(countryText)} ${countryText}`);
    }

    if (ageText) {
      lines.push(`Age: ${ageText}`);
    }

    const coreFieldKeys = new Set([
      'id', 'name', 'role', 'country', 'base_price_lakh', 'category', 'photo_url',
      'auction_status', 'extraFields', 'age', 'set_number', 'poolId', 'pool_id',
      'team', 'teamId', 'team_id', 'soldPrice', 'sold_price', 'soldBy', 'sold_by',
      'image', 'image_url', 'player_number', 'playerNumber', 'number'
    ]);

    Object.entries(playerData || {}).forEach(([key, value]) => {
      if (coreFieldKeys.has(key)) return;
      const safeValue = String(value || '').trim();
      if (!safeValue || safeValue.toLowerCase() === 'manual') return;
      const label = String(key || '')
        .replace(/[_-]+/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
      lines.push(`${label}: ${safeValue}`);
    });

    const extraFields = playerData.extraFields && typeof playerData.extraFields === 'object'
      ? playerData.extraFields
      : {};

    Object.entries(extraFields).forEach(([key, value]) => {
      const safeValue = String(value || '').trim();
      if (!safeValue || safeValue.toLowerCase() === 'manual') return;
      const label = String(key || '')
        .replace(/[_-]+/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
      lines.push(`${label}: ${safeValue}`);
    });

    lines.push(`Base Price: ${formatPrice(playerData.base_price_lakh)}`);
    return lines;
  };
  
  // Set badges and basic info
  if (player) {
    const pName = document.getElementById('broadcastPlayerName');
    if (pName) pName.textContent = player.name;
    const pImg = document.getElementById('broadcastPlayerImg');
    if (pImg) {
      pImg.src = player.photo_url || player.image || player.image_url || fallbackAvatar;
      pImg.onerror = () => { pImg.src = fallbackAvatar; };
    }
    
    const pMeta = document.getElementById('broadcastPlayerMeta');
    if (pMeta) {
      const playerLines = buildBroadcastPlayerLines(player);
      pMeta.innerHTML = playerLines
        .map((line, idx) => `<div class="broadcast-meta-line ${idx === playerLines.length - 1 ? 'is-base' : ''}"><span>${escapeHtml(line)}</span></div>`)
        .join('');
    }

    const pSetBadge = document.getElementById('broadcastSetBadge');
    if (pSetBadge) {
      const playerNum = getPlayerDisplayNumber(player);
      if (playerNum) {
        pSetBadge.textContent = String(playerNum);
        pSetBadge.style.display = 'flex';
      } else {
        pSetBadge.style.display = 'none';
      }
    }
  } else {
    const pSetBadge = document.getElementById('broadcastSetBadge');
    if (pSetBadge) pSetBadge.style.display = 'none';
  }

  if (player) {
    // (Mobile meta blocks removed as per user request to use desktop ribbons)
  }

  // Set Team Logo, Name and Bid
  const tLogoWrap = document.getElementById('broadcastTeamLogoWrap');
  const tName = document.getElementById('broadcastTeamName');
  const bidEl = document.getElementById('broadcastBidAmount');
  
  if (bidEl) bidEl.textContent = data.currentBid ? formatPrice(data.currentBid) : '0';

  if (data.highestBidder) {
    const team = teamsData[data.highestBidder] || getRoomTeamMeta(data.highestBidder) || {};
    const short = team.short || team.name || data.highestBidder;
    if (tName) tName.textContent = team.name || short;
    const tSection = document.querySelector('.broadcast-team-section');
    if (tSection) tSection.setAttribute('data-mobile-team', team.name || short);
    
    if (tLogoWrap) {
      if (team.logo) {
        tLogoWrap.innerHTML = `<img src="${team.logo}" alt="logo" loading="lazy">`;
      } else {
        tLogoWrap.innerHTML = `<div class="placeholder-logo">${short.slice(0,3).toUpperCase()}</div>`;
      }
    }
  } else {
    if (tName) tName.textContent = 'NO BIDS YET';
    if (tLogoWrap) tLogoWrap.innerHTML = `<div class="placeholder-logo">--</div>`;
    const tSection = document.querySelector('.broadcast-team-section');
    if (tSection) tSection.removeAttribute('data-mobile-team');
  }

  // Stamps
  const stampSold = document.getElementById('broadcastStampSold');
  const stampUnsold = document.getElementById('broadcastStampUnsold');
  if (stampSold) stampSold.style.display = data.status === 'sold' ? 'block' : 'none';
  if (stampUnsold) stampUnsold.style.display = data.status === 'unsold' ? 'block' : 'none';

  // Animation
  const anim = document.getElementById('firecrackerAnim');
  const animText = document.getElementById('firecrackerText');
  if (data.status === 'sold' && data.highestBidder && window.lastAnimPlayerId !== data.playerId) {
    window.lastAnimPlayerId = data.playerId;
    if (anim && animText) {
      const team = teamsData[data.highestBidder] || getRoomTeamMeta(data.highestBidder) || {};
      const teamName = team.name || team.short || data.highestBidder;
      animText.innerHTML = `${player.name}<br>sold to ${teamName}<br>for ${formatPrice(data.currentBid)}`;
      anim.style.display = 'flex';
      
      // Trigger canvas-confetti from both sides
      if (typeof confetti === 'function') {
        const duration = 3000;
        const end = Date.now() + duration;

        (function frame() {
          confetti({
            particleCount: 5,
            angle: 60,
            spread: 55,
            origin: { x: 0, y: 0.8 },
            colors: ['#facc15', '#ef4444', '#3b82f6', '#10b981']
          });
          confetti({
            particleCount: 5,
            angle: 120,
            spread: 55,
            origin: { x: 1, y: 0.8 },
            colors: ['#facc15', '#ef4444', '#3b82f6', '#10b981']
          });

          if (Date.now() < end) {
            requestAnimationFrame(frame);
          }
        }());
      }

      setTimeout(() => { anim.style.display = 'none'; }, 5000);
    }
  } else if (data.status !== 'sold' && anim) {
    anim.style.display = 'none';
  }

  // Stats

  let sold = 0;
  let unsold = 0;
  let available = 0;
  allPlayers.forEach((playerEntry) => {
    const status = getLivePlayerStatus(playerEntry.id);
    if (status === 'sold') sold += 1;
    else if (status === 'unsold') unsold += 1;
    else available += 1;
  });

  const sSold = document.getElementById('broadcastStatSold');
  const sUnsold = document.getElementById('broadcastStatUnsold');
  const sAvail = document.getElementById('broadcastStatAvailable');
  if (sSold) sSold.textContent = sold;
  if (sUnsold) sUnsold.textContent = unsold;
  if (sAvail) sAvail.textContent = Math.max(0, available);

  // Mobile Teams Grid
  const mTeamsContainer = document.getElementById('broadcastMobileTeamsContainer');
  if (mTeamsContainer) {
    let mHtml = '';
    const roomPurse = window.roomSettings?.budget || 0;
    const maxSquad = window.roomSettings?.max_players_per_team || 20;
    
    const teamSpent = {};
    const teamCount = {};
    allPlayers.forEach(p => {
      if (getLivePlayerStatus(p.id) === 'sold' && p.sold_to) {
        teamSpent[p.sold_to] = (teamSpent[p.sold_to] || 0) + (p.sold_price || 0);
        teamCount[p.sold_to] = (teamCount[p.sold_to] || 0) + 1;
      }
    });

    Object.keys(teamsData).forEach(tid => {
      const t = teamsData[tid];
      const name = t.name || tid;
      const count = teamCount[tid] || 0;
      const spent = teamSpent[tid] || 0;
      const purseLeft = Math.max(0, (t.purse_balance ?? roomPurse) - spent);
      const formattedPurse = formatPrice(purseLeft).replace('₹', '');
      
      mHtml += `
        <div class="mobile-team-card" onclick="showTeamSquad('${tid}')" style="cursor:pointer">
          <div class="m-team-header">
            <span class="m-team-name">${escapeHtml(name)}</span>
            <span class="m-team-set">${count}</span>
          </div>
          <div class="m-team-stat">
            <span class="m-team-stat-icon">🪙</span> ${count}/${maxSquad}
          </div>
          <div class="m-team-stat">
            <span class="m-team-stat-icon">🪙</span> ${formattedPurse}
          </div>
        </div>
      `;
    });
    mTeamsContainer.innerHTML = mHtml;
  }
}

function updateSpectatorPanel(data = null) {
  if (!isSpectator) return;

  const current = data || currentAuctionData;
  const bidEl = document.getElementById('spectatorCurrentBid');
  const leaderEl = document.getElementById('spectatorLeadingTeam');
  const timerEl = document.getElementById('spectatorTimeLeft');
  if (!bidEl || !leaderEl || !timerEl) return;

  if (!current) {
    bidEl.textContent = '₹—';
    leaderEl.textContent = 'No bids yet';
    timerEl.textContent = '—';
    renderSpectatorBidHistory(current);
    updateSpectatorSideBid(current);
    return;
  }

  bidEl.textContent = formatPrice(current.currentBid);
  if (current.highestBidder) {
    const t = teamsData[current.highestBidder] || getRoomTeamMeta(current.highestBidder) || {};
    leaderEl.textContent = '';
    if (t.logo) {
      const logoEl = document.createElement('img');
      logoEl.className = 'spectator-team-logo';
      logoEl.src = t.logo;
      logoEl.alt = `${t.short || t.name || current.highestBidder} logo`;
      logoEl.loading = 'lazy';
      logoEl.decoding = 'async';
      leaderEl.appendChild(logoEl);
    }
    const nameEl = document.createElement('span');
    nameEl.className = 'spectator-team-name';
    nameEl.textContent = t.name || t.short || current.highestBidder;
    leaderEl.appendChild(nameEl);
  } else {
    leaderEl.textContent = 'No bids yet';
  }

  renderSpectatorBidHistory(current);
  updateSpectatorSideBid(current);

  if (paused || current.status !== 'bidding') {
    timerEl.textContent = paused ? 'Paused' : 'Closed';
    return;
  }

  if (unlimitedTimer) {
    timerEl.textContent = '∞';
    return;
  }

  const left = Math.max(0, Math.ceil((current.timerEnd - getSyncedNowMs()) / 1000));
  timerEl.textContent = `${left}s`;
}

function detachSpectatorPollListener() {
  if (spectatorPollRef && listeners.spectatorPollVotes) {
    spectatorPollRef.off('value', listeners.spectatorPollVotes);
  }
  listeners.spectatorPollVotes = null;
  spectatorPollRef = null;
  spectatorPollPlayerId = null;
  spectatorPollVotes = {};
}

function attachSpectatorPollListener(playerId) {
  if (!isSpectator || !playerId) return;
  const normalized = String(playerId);
  if (spectatorPollPlayerId === normalized && spectatorPollRef) return;

  detachSpectatorPollListener();
  spectatorPollPlayerId = normalized;
  spectatorPollRef = db.ref(`rooms/${roomCode}/spectatorPolls/${normalized}/votes`);
  listeners.spectatorPollVotes = (snap) => {
    spectatorPollVotes = snap.val() || {};
    renderSpectatorPredictionPoll(currentAuctionData);
  };
  spectatorPollRef.on('value', listeners.spectatorPollVotes);
}

function getSpectatorPollStats() {
  const tally = {};
  Object.values(spectatorPollVotes || {}).forEach((entry) => {
    const teamId = typeof entry === 'string' ? entry : entry?.teamId;
    if (!teamId) return;
    tally[teamId] = (tally[teamId] || 0) + 1;
  });

  const ranking = Object.entries(tally)
    .map(([teamId, votes]) => ({ teamId, votes }))
    .sort((a, b) => b.votes - a.votes || String(a.teamId).localeCompare(String(b.teamId)));

  const totalVotes = ranking.reduce((sum, row) => sum + row.votes, 0);
  const top = ranking[0] || null;
  const tie = !!(ranking[1] && top && ranking[1].votes === top.votes);
  const myVoteEntry = spectatorSessionId ? spectatorPollVotes?.[spectatorSessionId] : null;
  const myVoteTeamId = typeof myVoteEntry === 'string' ? myVoteEntry : (myVoteEntry?.teamId || null);

  return {
    ranking,
    totalVotes,
    topTeamId: tie ? null : (top?.teamId || null),
    tie,
    myVoteTeamId
  };
}

function renderSpectatorPredictionPoll(data = null) {
  if (!isSpectator) return;

  const card = document.getElementById('spectatorPollCard');
  const graphEl = document.getElementById('spectatorPollGraph');
  const listEl = document.getElementById('spectatorPollTeams');
  const totalEl = document.getElementById('spectatorPollTotalVotes');
  const subEl = document.getElementById('spectatorPollSub');
  if (!card || !graphEl || !listEl || !totalEl || !subEl) return;

  const auction = data || currentAuctionData;
  const currentPlayer = auction?.playerId ? playerMap[auction.playerId] : null;
  if (!auction || !currentPlayer) {
    totalEl.textContent = '0 votes';
    subEl.textContent = 'Vote which team will win this player.';
    graphEl.innerHTML = '';
    listEl.innerHTML = '<div class="bid-history-empty">Waiting for live player...</div>';
    return;
  }

  const { ranking, totalVotes, topTeamId, tie, myVoteTeamId } = getSpectatorPollStats();
  const teamIds = Object.keys(teamsData || {});

  totalEl.textContent = `${totalVotes} vote${totalVotes === 1 ? '' : 's'}`;
  if (auction.status === 'bidding') {
    if (isHostManager) {
      subEl.textContent = `${currentPlayer.name}: Manager mode cannot vote. Watching live graph only.`;
    } else if (myVoteTeamId) {
      const myTeam = getRoomTeamMeta(myVoteTeamId) || teamsData[myVoteTeamId] || {};
      subEl.textContent = `${currentPlayer.name}: You voted ${myTeam.short || myTeam.name || myVoteTeamId}. Vote is locked.`;
    } else {
      subEl.textContent = `${currentPlayer.name}: Vote now before this player is sold.`;
    }
  }

  if (!ranking.length) {
    graphEl.innerHTML = '<div class="spectator-poll-empty">No predictions yet. Be the first to vote.</div>';
  } else {
    const topRows = ranking.slice(0, 4);
    graphEl.innerHTML = topRows.map((row) => {
      const team = getRoomTeamMeta(row.teamId) || teamsData[row.teamId] || {};
      const pct = totalVotes > 0 ? Math.round((row.votes / totalVotes) * 100) : 0;
      const accent = team.primary || '#1DA0FF';
      return `
        <div class="spectator-poll-graph-row ${topTeamId === row.teamId ? 'leader' : ''}">
          <div class="spectator-poll-graph-meta">
            <span>${team.short || row.teamId}</span>
            <span>${row.votes} (${pct}%)</span>
          </div>
          <div class="spectator-poll-bar-track">
            <div class="spectator-poll-bar-fill" style="width:${pct}%;background:${accent};"></div>
          </div>
        </div>
      `;
    }).join('');
  }

  if (!teamIds.length) {
    listEl.innerHTML = '<div class="bid-history-empty">Team data unavailable.</div>';
    return;
  }

  const voteClosed = auction.status !== 'bidding';
  const sortedTeamIds = teamIds.slice().sort((a, b) => {
    const ta = teamsData[a] || getRoomTeamMeta(a) || {};
    const tb = teamsData[b] || getRoomTeamMeta(b) || {};
    return String(ta.short || ta.name || a).localeCompare(String(tb.short || tb.name || b));
  });

  listEl.innerHTML = sortedTeamIds.map((teamId) => {
    const team = teamsData[teamId] || getRoomTeamMeta(teamId) || {};
    const voteRow = ranking.find((r) => r.teamId === teamId);
    const votes = voteRow?.votes || 0;
    const pct = totalVotes > 0 ? Math.round((votes / totalVotes) * 100) : 0;
    const isMyVote = myVoteTeamId === teamId;
    const disabled = voteClosed || isHostManager || !!myVoteTeamId;
    return `
      <button class="spectator-poll-team-btn ${isMyVote ? 'selected' : ''}" ${disabled ? 'disabled' : ''} onclick="castSpectatorPollVote('${teamId}')">
        <span class="spectator-poll-team-left">
          ${team.logo ? `<img src="${team.logo}" alt="${team.short || teamId} logo" loading="lazy" decoding="async" />` : ''}
          <span>${team.short || team.name || teamId}</span>
        </span>
        <span class="spectator-poll-team-right">${votes} • ${pct}%</span>
      </button>
    `;
  }).join('');

  if (voteClosed) {
    if (auction.status === 'sold') {
      const soldTeam = teamsData[auction.highestBidder] || getRoomTeamMeta(auction.highestBidder) || {};
      if (tie) {
        subEl.textContent = `${currentPlayer.name} sold to ${soldTeam.short || soldTeam.name || auction.highestBidder}. Poll ended with tie.`;
      } else if (topTeamId) {
        const topTeam = teamsData[topTeamId] || getRoomTeamMeta(topTeamId) || {};
        subEl.textContent = `${currentPlayer.name} sold to ${soldTeam.short || soldTeam.name || auction.highestBidder}. Top predicted: ${topTeam.short || topTeam.name || topTeamId}.`;
      } else {
        subEl.textContent = `${currentPlayer.name} sold to ${soldTeam.short || soldTeam.name || auction.highestBidder}.`;
      }
    } else if (auction.status === 'unsold') {
      subEl.textContent = `${currentPlayer.name} remained unsold. Poll closed.`;
    }
  }
}

async function castSpectatorPollVote(teamId) {
  if (!isSpectator || isHostManager) return;
  if (!teamId || !currentAuctionData || currentAuctionData.status !== 'bidding') return;
  if (!currentAuctionData.playerId || spectatorPollPlayerId !== String(currentAuctionData.playerId)) return;

  const { myVoteTeamId } = getSpectatorPollStats();
  if (myVoteTeamId) {
    showToast('Your prediction is already locked for this player.', 'error');
    return;
  }

  try {
    const voteRef = db.ref(`rooms/${roomCode}/spectatorPolls/${spectatorPollPlayerId}/votes/${spectatorSessionId}`);
    const result = await voteRef.transaction((existing) => {
      if (existing) return; // Already voted; abort change.
      return {
        teamId,
        viewerName: playerName || 'Viewer',
        ts: firebase.database.ServerValue.TIMESTAMP
      };
    });

    if (!result.committed) {
      showToast('Your prediction is already locked for this player.', 'error');
    }
  } catch (err) {
    console.error('Spectator poll vote failed:', err);
    showToast('Vote failed. Please retry.', 'error');
  }
}

function maybeCelebrateSpectatorPollOutcome(data, player) {
  if (!isBidUiSpectator() || !data || data.status !== 'sold') return;

  // Prediction-hit banners are not reliable and can confuse users.
  // Keep the spectator poll UI (votes/graph), but do not show extra overlays.
  const pollCard = document.getElementById('spectatorPollCard');
  if (pollCard) {
    pollCard.classList.remove('prediction-hit', 'prediction-miss');
  }
}

// ---- RENDER AUCTION STATE ----
function renderAuction(data, prevData = null) {
  if (!data) return;
  const player = playerMap[data.playerId];
  if (!player) return;

  if (isBidUiSpectator() && data.playerId) {
    attachSpectatorPollListener(data.playerId);
    if (data.status === 'bidding') {
      const pollCard = document.getElementById('spectatorPollCard');
      if (pollCard) pollCard.classList.remove('prediction-hit', 'prediction-miss');
    }
    renderSpectatorPredictionPoll(data);
  }

  handleAudioEvents(data, prevData);

  if (data.status === 'bidding') {
    const currentPool = getCurrentPoolMeta();
    if (currentPool?.poolId) showPoolStartBanner(currentPool.poolId, currentPool.poolLabel || 'Category Pool');
  }

  renderCurrentPoolBanner();

  renderPlayerSpotlight(player);
  renderBidDisplay(data, player);
  updateProgressBar();

  // Handle result overlays
  if (data.status === 'sold') {
    const buyer = teamsData[data.highestBidder];
    showResultBanner('sold', `SOLD`, `${player.name} → ${buyer ? buyer.name : data.highestBidder} for ${formatPrice(data.currentBid)}`);
    maybeCelebrateSpectatorPollOutcome(data, player);
  } else if (data.status === 'unsold') {
    showResultBanner('unsold', `UNSOLD`, `${player.name} goes back to the pool`);
  } else {
    hideResultBanner();
  }
}

function renderPlayerSpotlight(player) {
  const color = getRoleColor(player.role);
  const initials = getPlayerInitials(player.name);
  const flag = getCountryFlag(player.country);
  const icon = getRoleIcon(player.role);
  const inWatchlist = !!watchlistForMe[player.id];
  const ageText = player.age ? ` · Age ${player.age}` : '';
  const categoryText = String(player.category || '').trim();
  const roleText = String(player.role || '').trim();
  const showCategory = !!categoryText && categoryText.toLowerCase() !== roleText.toLowerCase() && categoryText.toLowerCase() !== 'manual';
  const coreFieldKeys = new Set([
    'id', 'name', 'role', 'country', 'base_price_lakh', 'category', 'photo_url',
    'auction_status', 'extraFields', 'age', 'set_number', 'poolId', 'pool_id',
    'player_number', 'playerNumber', 'number',
    'team', 'teamId', 'team_id', 'soldPrice', 'sold_price', 'soldBy', 'sold_by'
  ]);
  const dynamicFieldChips = Object.entries(player || {})
    .filter(([key, value]) => {
      if (coreFieldKeys.has(key)) return false;
      const safe = String(value || '').trim();
      if (!safe) return false;
      return safe.toLowerCase() !== 'manual';
    })
    .map(([key, value]) => {
      const label = String(key || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
      const safeValue = String(value || '').trim();
      return `<span class="badge badge-extra-field">${label}: ${safeValue}</span>`;
    }).join('');
  const extraFields = player.extraFields && typeof player.extraFields === 'object' ? player.extraFields : {};
  const extraFieldChips = Object.entries(extraFields)
    .filter(([, value]) => {
      const safe = String(value || '').trim();
      return !!safe && safe.toLowerCase() !== 'manual';
    })
    .map(([key, value]) => {
      const label = String(key || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      const safeVal = String(value || '').trim();
      return `<span class="badge badge-extra-field">${label}: ${safeVal}</span>`;
    }).join('');
  const avatarInner = player.photo_url
    ? `<img src="${player.photo_url}" alt="${player.name}" loading="eager" decoding="async" fetchpriority="high" onerror="handlePlayerImageError(this, '${initials}')" />`
    : initials;
  const numberBadgeHtml = buildPlayerNumberBadgeHtml(player);

  document.getElementById('playerSpotlight').innerHTML = `
    <div class="player-avatar pulse-ring ${avatarBorderVariantClass}" style="background: linear-gradient(135deg, ${color}99, ${color}44);">
      ${numberBadgeHtml}
      ${avatarInner}
    </div>
    <div class="player-info-card">
      <h2 class="player-name">${player.name}</h2>
      <div class="player-badges">
        <span class="badge badge-role">${icon} ${player.role}</span>
        ${showCategory ? `<span class="badge badge-category-${player.category}">${player.category}</span>` : ''}
      </div>
      ${dynamicFieldChips ? `<div class="player-extra-fields">${dynamicFieldChips}</div>` : ''}
      ${extraFieldChips ? `<div class="player-extra-fields">${extraFieldChips}</div>` : ''}
      ${inWatchlist ? '<div class="watchlist-live-pill">⭐ Watchlist Player</div>' : ''}
      <div class="base-price">Base Price: <span>${formatPrice(player.base_price_lakh)}</span></div>
      <div class="player-bid-team-tile" id="playerBidTeamTile" style="display:none;"></div>
    </div>
  `;
}

function renderBidDisplay(data, player = null) {
  const resolvedPlayer = player || playerMap[data.playerId];
  if (!resolvedPlayer) return;

  const bidEl = document.getElementById('currentBidDisplay');
  bidEl.textContent = formatPrice(data.currentBid);
  bidEl.classList.remove('bumped');
  void bidEl.offsetWidth; // reflow for animation
  if (data.status === 'bidding') bidEl.classList.add('bumped');

  renderBidHistory(data);

  // Highest bidder chip
  const chipEl = document.getElementById('highestBidderChip');
  const playerBidTeamTileEl = document.getElementById('playerBidTeamTile');
  if (data.highestBidder) {
    const team = teamsData[data.highestBidder];
    const t = getRoomTeamMeta(data.highestBidder);
    const accent = t?.primary || '#FFCB30';
    if (chipEl) {
      chipEl.style.borderColor = (t?.primary || '#FFD700') + '80';
      chipEl.style.color = t?.primary || 'var(--gold)';
      chipEl.innerHTML = `${t?.logo ? `<img class="chip-team-logo" src="${t.logo}" alt="${t.short} logo" loading="lazy" decoding="async" />` : ''} ${team?.name || data.highestBidder}`;
    }

    if (playerBidTeamTileEl) {
      playerBidTeamTileEl.style.display = 'block';
      playerBidTeamTileEl.style.borderColor = accent + '66';
      playerBidTeamTileEl.style.boxShadow = `0 10px 28px ${accent}22`;
      playerBidTeamTileEl.innerHTML = `
        <div class="player-bid-team-label">CURRENT BID TEAM</div>
        <div class="player-bid-team-name" style="color:${accent};">
          ${t?.logo ? `<img class="player-bid-team-logo" src="${t.logo}" alt="${t.short} logo" loading="eager" decoding="async" />` : ''}
          <span class="player-bid-team-text">${team?.name || data.highestBidder}</span>
        </div>
      `;
    }
  } else {
    if (chipEl) {
      chipEl.style.borderColor = '';
      chipEl.style.color = '';
      chipEl.textContent = 'No bids yet';
    }
    if (playerBidTeamTileEl) {
      playerBidTeamTileEl.style.display = 'none';
      playerBidTeamTileEl.innerHTML = '';
      playerBidTeamTileEl.style.borderColor = '';
      playerBidTeamTileEl.style.boxShadow = '';
    }
  }

  // Bid buttons
  const quickBidRow = document.getElementById('quickBidRow');
  const baseBidBtn = document.getElementById('baseBidBtn');
  const withdrawBtn = document.getElementById('withdrawBtn');
  const withdrawnTeamsWrap = document.getElementById('withdrawnTeamsWrap');
  const withdrawnTeamsList = document.getElementById('withdrawnTeamsList');
  const sellNowBtn = document.getElementById('sellNowBtn');
  const unsoldNowBtn = document.getElementById('unsoldNowBtn');
  const undoActionBtn = document.getElementById('undoActionBtn');
  const passBtn = document.getElementById('passBtn');
  const skipPoolBtn = document.getElementById('skipPoolBtn');
  const warnEl = document.getElementById('noPurseWarn');
  const bidPanelEl = document.querySelector('.bid-panel');

  if (data.status === 'bidding') {
    if (isBidUiSpectator()) {
      updateSpectatorPanel(data);
      updateLiveListButtonsVisibility();
      return;
    }

    if (isHostProxyBidderActive()) {
      renderHostProxyBidPanel();
    }

    ensureHostProxyBidTeamSelected();
    const actingTeamId = getActingTeamIdForBidUi();
    const myTeam = actingTeamId ? teamsData[actingTeamId] : null;
    const canActAsTeam = !!(actingTeamId && myTeam);

    const bidJumps = getBidJumpOptions(resolvedPlayer.base_price_lakh, roomConfig.bidOptions);
    const withdrawn = !!(canActAsTeam && data.withdrawnTeams && data.withdrawnTeams[actingTeamId]);
    const withdrawnTeamIds = Object.keys(data.withdrawnTeams || {});
    const skipVoted = !!(canActAsTeam && data.skipVotes && data.skipVotes[actingTeamId]);
    const poolSkipVoted = !!(canActAsTeam && data.poolSkipVotes && data.poolSkipVotes[actingTeamId]);
    const totalTeams = Object.keys(teamsData).length;
    const skipCount = Object.keys(data.skipVotes || {}).length;
    const poolSkipCount = Object.keys(data.poolSkipVotes || {}).length;
    const currentPool = getCurrentPoolMeta();
    const canSkipPool = !!currentPool?.poolId;
    const affordableJumps = bidJumps.filter(j => myTeam && (myTeam.purse >= data.currentBid + j));
    const canAffordAny = affordableJumps.length > 0;
    const canAffordBase = !!(myTeam && myTeam.purse >= data.currentBid);
    const isLeading = !!(canActAsTeam && data.highestBidder === actingTeamId);
    const squadFull = myTeam && myTeam.squad && myTeam.squad.length >= roomConfig.maxSquadSize;

    if (squadFull && !isHostProxyBidderActive()) {
      autoWithdrawFromCurrentPlayerIfNeeded(data);
    }

    const canTryBid = canActAsTeam && !paused && !withdrawn && !isLeading && !squadFull;
    const canBaseBid = canTryBid && !data.highestBidder && canAffordBase;

    if (sellNowBtn) {
      const canUseSellNow = !!(isManualAuction && isHost && canDriveAuctionEngine() && !paused && data.highestBidder);
      sellNowBtn.style.display = canUseSellNow ? 'block' : 'none';
      sellNowBtn.disabled = !canUseSellNow;
      if (canUseSellNow) {
        const winnerMeta = data.highestBidder ? (teamsData[data.highestBidder] || getRoomTeamMeta(data.highestBidder) || {}) : {};
        const winnerName = winnerMeta.short || winnerMeta.name || data.highestBidder;
        sellNowBtn.textContent = `✅ SOLD NOW (${winnerName} · ${formatPrice(data.currentBid)})`;
      } else {
        sellNowBtn.textContent = '✅ SOLD NOW';
      }
    }

    if (unsoldNowBtn) {
      const canUseUnsoldNow = !!(isHostProxyBidderActive() && canDriveAuctionEngine() && !paused && !data.highestBidder);
      unsoldNowBtn.style.display = canUseUnsoldNow ? 'block' : 'none';
      unsoldNowBtn.disabled = !canUseUnsoldNow;
      unsoldNowBtn.textContent = '❌ UNSOLD NOW';
    }

    if (undoActionBtn) {
      const canUseUndo = !!(isManualAuction && isHost && canDriveAuctionEngine());
      undoActionBtn.style.display = canUseUndo ? 'block' : 'none';
      undoActionBtn.disabled = !canUseUndo;
      undoActionBtn.textContent = '↩ Undo Bid / Reopen Player';
    }

    if (baseBidBtn) {
      baseBidBtn.disabled = !canBaseBid;
      baseBidBtn.textContent = data.highestBidder ? 'Base Bid Locked' : `Bid at Base ${formatPrice(data.currentBid)}`;
    }

    if (quickBidRow) {
      quickBidRow.innerHTML = bidJumps.map(jump => {
        const canAffordThis = myTeam && myTeam.purse >= (data.currentBid + jump);
        const disabledAttr = (!canTryBid || !data.highestBidder || !canAffordThis) ? 'disabled' : '';
        return `<button class="quick-bid-btn" onclick="placeBid(${jump})" ${disabledAttr}>+${formatPrice(jump)}</button>`;
      }).join('');
    }

    if (withdrawnTeamsWrap && withdrawnTeamsList) {
      if (withdrawnTeamIds.length) {
        withdrawnTeamsWrap.style.display = 'block';
        withdrawnTeamsList.innerHTML = withdrawnTeamIds.map((tId) => {
          const team = teamsData[tId] || getRoomTeamMeta(tId) || {};
          const short = team.short || tId;
          const logo = team.logo ? `<img src="${team.logo}" alt="${short} logo" loading="lazy" decoding="async" />` : '';
          return `<span class="withdrawn-team-chip">${logo}${short}</span>`;
        }).join('');
      } else {
        withdrawnTeamsWrap.style.display = 'none';
        withdrawnTeamsList.innerHTML = '';
      }
    }

    if (withdrawn) {
      withdrawBtn.disabled = true;
      withdrawBtn.textContent = 'Withdrawn For This Player';
    } else if (isLeading) {
      withdrawBtn.disabled = true;
      withdrawBtn.textContent = 'Leading Bidder';
    } else {
      withdrawBtn.disabled = paused || squadFull || !canActAsTeam;
      withdrawBtn.textContent = 'Withdraw For This Player';
    }

    if (data.highestBidder) {
      passBtn.disabled = true;
      passBtn.textContent = 'Skip Closed After First Bid';
    } else if (squadFull) {
      passBtn.disabled = true;
      passBtn.textContent = 'Squad Full';
    } else if (skipVoted) {
      passBtn.disabled = true;
      passBtn.textContent = `Skip Voted (${skipCount}/${totalTeams})`;
    } else {
      passBtn.disabled = paused || !canActAsTeam;
      passBtn.textContent = `Skip Player (${skipCount}/${totalTeams})`;
    }

    if (!canSkipPool) {
      skipPoolBtn.disabled = true;
      skipPoolBtn.textContent = 'Skip Pool (Category Only)';
    } else if (squadFull) {
      skipPoolBtn.disabled = true;
      skipPoolBtn.textContent = 'Squad Full';
    } else if (poolSkipVoted) {
      skipPoolBtn.disabled = true;
      skipPoolBtn.textContent = `Pool Skip Voted (${poolSkipCount}/${totalTeams})`;
    } else {
      skipPoolBtn.disabled = paused || !canActAsTeam;
      skipPoolBtn.textContent = `Skip Current Pool (${poolSkipCount}/${totalTeams})`;
    }

    if (!canActAsTeam) { warnEl.textContent = '👆 Select a team to bid'; warnEl.style.display = 'block'; warnEl.style.color = 'var(--text-sec)'; }
    else if (paused) { warnEl.textContent = '⏸️ Auction is paused by host'; warnEl.style.display = 'block'; warnEl.style.color = 'var(--orange)'; }
    else if (squadFull) { warnEl.textContent = '✅ Your squad is complete. Bidding is disabled.'; warnEl.style.display = 'block'; warnEl.style.color = 'var(--green)'; }
    else if (withdrawn) { warnEl.textContent = '⏭️ You withdrew for this player'; warnEl.style.display = 'block'; warnEl.style.color = 'var(--text-sec)'; }
    else if (!canAffordAny) { warnEl.textContent = '⚠️ Not enough purse for available bid jumps!'; warnEl.style.display = 'block'; warnEl.style.color = 'var(--red)'; }
    else if (isLeading) { warnEl.textContent = '✓ You are the leading bidder'; warnEl.style.display = 'block'; warnEl.style.color = 'var(--green)'; }
    else { warnEl.style.display = 'none'; warnEl.style.color = 'var(--red)'; }

    replayBidPanelMotion(bidPanelEl);
  } else {
    if (baseBidBtn) {
      baseBidBtn.disabled = true;
      baseBidBtn.textContent = 'Bid at Base Price';
    }
    if (quickBidRow) quickBidRow.innerHTML = '';
    if (withdrawnTeamsWrap) withdrawnTeamsWrap.style.display = 'none';
    if (withdrawnTeamsList) withdrawnTeamsList.innerHTML = '';
    withdrawBtn.disabled = true;
    withdrawBtn.textContent = 'Withdraw For This Player';
    if (sellNowBtn) {
      sellNowBtn.style.display = 'none';
      sellNowBtn.disabled = true;
      sellNowBtn.textContent = '✅ SOLD NOW';
    }
    if (unsoldNowBtn) {
      unsoldNowBtn.style.display = 'none';
      unsoldNowBtn.disabled = true;
      unsoldNowBtn.textContent = '❌ UNSOLD NOW';
    }
    if (undoActionBtn) {
      const canUseUndo = !!(isManualAuction && isHost && canDriveAuctionEngine());
      undoActionBtn.style.display = canUseUndo ? 'block' : 'none';
      undoActionBtn.disabled = !canUseUndo;
      undoActionBtn.textContent = '↩ Undo Bid / Reopen Player';
    }
    passBtn.disabled = true;
    passBtn.textContent = 'Skip Player';
    skipPoolBtn.disabled = true;
    skipPoolBtn.textContent = 'Skip Current Pool';
    warnEl.style.display = 'none';

    if (bidPanelEl) bidPanelEl.classList.remove('motion-stagger');
  }

  updateLiveListButtonsVisibility();
}

async function sellNow() {
  if (!isManualAuction) {
    showToast('SOLD NOW is only available in manual auction.', 'error');
    return;
  }
  if (isBidUiSpectator()) {
    showToast('Viewer mode: host actions are disabled.', 'error');
    return;
  }
  if (!isHost || !canDriveAuctionEngine()) return;
  if (paused) {
    showToast('Auction is paused.', 'error');
    return;
  }
  if (!currentAuctionData || currentAuctionData.status !== 'bidding') return;
  if (!currentAuctionData.highestBidder) {
    showToast('No bids yet. Cannot sell.', 'error');
    return;
  }

  const player = playerMap[currentAuctionData.playerId];
  const winnerId = currentAuctionData.highestBidder;
  const winner = teamsData[winnerId] || getRoomTeamMeta(winnerId) || {};
  const winnerName = winner.name || winner.short || winnerId;
  const priceText = formatPrice(currentAuctionData.currentBid || 0);
  const playerNameText = player?.name || 'this player';

  const confirmed = window.confirm(`Confirm SOLD?\n\n${playerNameText}\n→ ${winnerName}\nFor ${priceText}\n\nThis will end bidding immediately.`);
  if (!confirmed) return;

  if (processingRound) return;
  processingRound = true;
  try {
    await processAuctionRound();
  } catch (err) {
    console.error('Sell now failed:', err);
    showToast('Failed to mark SOLD. Try again.', 'error');
    processingRound = false;
  }
}

async function unsoldNow() {
  if (!isHostProxyBidderActive()) {
    showToast('UNSOLD NOW is only available in paddle mode.', 'error');
    return;
  }
  if (isBidUiSpectator()) {
    showToast('Viewer mode: host actions are disabled.', 'error');
    return;
  }
  if (!isHost || !canDriveAuctionEngine()) return;
  if (paused) {
    showToast('Auction is paused.', 'error');
    return;
  }
  if (!currentAuctionData || currentAuctionData.status !== 'bidding') return;
  if (currentAuctionData.highestBidder) {
    showToast('Cannot mark unsold after bids start. Use SOLD NOW.', 'error');
    return;
  }

  const player = playerMap[currentAuctionData.playerId];
  const playerNameText = player?.name || 'this player';
  const confirmed = window.confirm(`Mark this player as UNSOLD now?\n\n${playerNameText}\n\nThis will move to the next player.`);
  if (!confirmed) return;

  if (processingRound) return;
  processingRound = true;
  try {
    await processAsUnsold();
  } catch (err) {
    console.error('Unsold now failed:', err);
    showToast('Failed to mark UNSOLD. Try again.', 'error');
    processingRound = false;
  }
}

async function undoAuctionAction() {
  if (!isManualAuction) {
    showToast('Undo is only available in manual auction.', 'error');
    return;
  }
  if (isBidUiSpectator()) {
    showToast('Viewer mode: host actions are disabled.', 'error');
    return;
  }
  if (!isHost || !canDriveAuctionEngine()) return;

  const mode = String(window.prompt(
    'Undo Options:\n1 = Undo last bid (current player)\n2 = Reopen player (sold/unsold)\n\nEnter 1 or 2',
    '1'
  ) || '').trim();
  if (!mode) return;

  if (mode === '1') {
    await undoLastBidForCurrentPlayer();
    return;
  }

  if (mode === '2') {
    const rawInput = String(window.prompt('Enter player name or ID to reopen for bidding:') || '').trim();
    if (!rawInput) return;
    const resolved = resolvePlayerIdForUndo(rawInput);
    if (!resolved) {
      showToast('Player not found. Use exact name or ID.', 'error');
      return;
    }
    await reopenPlayerForRebid(resolved.playerId, resolved.playerName);
    return;
  }

  showToast('Invalid option. Enter 1 or 2.', 'error');
}

async function undoLastBidForCurrentPlayer() {
  if (!currentAuctionData || currentAuctionData.status !== 'bidding') {
    showToast('No live bidding round to undo.', 'error');
    return;
  }

  try {
    const result = await db.ref(`rooms/${roomCode}/currentAuction`).transaction((auction) => {
      if (!auction || auction.status !== 'bidding') return;

      const history = Array.isArray(auction.bidHistory) ? [...auction.bidHistory] : [];
      if (!history.length) return;

      history.pop();
      const txnPlayer = playerMap[auction.playerId] || playerMap[String(auction.playerId)];
      if (!txnPlayer) return;

      auction.bidHistory = history;
      if (history.length) {
        const previousBid = history[history.length - 1] || {};
        auction.currentBid = Number(previousBid.bid) || txnPlayer.base_price_lakh;
        auction.highestBidder = previousBid.teamId || null;
      } else {
        auction.currentBid = txnPlayer.base_price_lakh;
        auction.highestBidder = null;
      }

      if (!unlimitedTimer) {
        auction.timerEnd = getSyncedNowMs() + timerSeconds * 1000;
      }
      return auction;
    });

    if (!result.committed) {
      showToast('No bid to undo for current player.', 'error');
      return;
    }

    showToast('Last bid undone successfully.', 'success');
  } catch (err) {
    console.error('Undo last bid failed:', err);
    showToast('Failed to undo bid.', 'error');
  }
}

function resolvePlayerIdForUndo(rawInput) {
  const query = String(rawInput || '').trim();
  if (!query) return null;
  const lowerQuery = query.toLowerCase();

  const byId = allPlayers.find((p) => String(p.id) === query);
  if (byId) return { playerId: String(byId.id), playerName: byId.name };

  const byExactName = allPlayers.find((p) => String(p.name || '').toLowerCase() === lowerQuery);
  if (byExactName) return { playerId: String(byExactName.id), playerName: byExactName.name };

  const partialMatches = allPlayers.filter((p) => String(p.name || '').toLowerCase().includes(lowerQuery));
  if (partialMatches.length === 1) {
    return { playerId: String(partialMatches[0].id), playerName: partialMatches[0].name };
  }

  if (partialMatches.length > 1) {
    const preview = partialMatches
      .slice(0, 6)
      .map((p) => `${p.id}: ${p.name}`)
      .join('\n');
    alert(`Multiple players matched. Please enter exact name or ID.\n\n${preview}`);
  }

  return null;
}

async function reopenPlayerForRebid(playerId, playerName = 'Player') {
  const targetIndex = playerQueue.findIndex((queuedPlayerId) => String(queuedPlayerId) === String(playerId));
  if (targetIndex < 0) {
    showToast('That player is not part of this auction queue.', 'error');
    return;
  }

  if (targetIndex > currentIndex) {
    showToast('Cannot reopen a future player. Bid them when their turn starts.', 'error');
    return;
  }

  const queuedPlayerId = playerQueue[targetIndex];
  const targetPlayer = playerMap[queuedPlayerId] || playerMap[String(queuedPlayerId)] || playerMap[playerId] || playerMap[String(playerId)];
  if (!targetPlayer) {
    showToast('Player data missing. Cannot reopen.', 'error');
    return;
  }

  const soldRef = db.ref(`rooms/${roomCode}/soldPlayers/${queuedPlayerId}`);

  try {
    const soldSnap = await soldRef.get();
    const soldEntry = soldSnap.exists() ? (soldSnap.val() || {}) : null;

    if (soldEntry) {
      await rollbackSoldPlayerEntry(String(queuedPlayerId), soldEntry);
    }

    const targetPool = getPoolMetaAtIndex(targetIndex);
    await db.ref(`rooms/${roomCode}/currentAuction`).set({
      playerId: queuedPlayerId,
      currentBid: targetPlayer.base_price_lakh,
      highestBidder: null,
      bidHistory: [],
      poolId: targetPool?.poolId || null,
      poolLabel: targetPool?.poolLabel || null,
      skipVotes: {},
      poolSkipVotes: {},
      withdrawnTeams: {},
      timerEnd: unlimitedTimer ? null : (getSyncedNowMs() + timerSeconds * 1000),
      status: 'bidding'
    });

    processingRound = false;
    showToast(`${playerName} reopened. Finish this round to continue flow.`, 'success');
  } catch (err) {
    console.error('Reopen player failed:', err);
    showToast('Failed to reopen player.', 'error');
  }
}

async function rollbackSoldPlayerEntry(playerId, soldEntry) {
  const winnerTeamId = String(soldEntry?.teamId || '').trim();
  const soldPrice = Number(soldEntry?.soldPrice || 0);
  const refund = Number.isFinite(soldPrice) && soldPrice > 0 ? soldPrice : 0;

  if (winnerTeamId) {
    await db.ref(`rooms/${roomCode}/teams/${winnerTeamId}/purse`).transaction((purse) => {
      const current = Number(purse || 0);
      return current + refund;
    });

    await db.ref(`rooms/${roomCode}/teams/${winnerTeamId}/squad`).transaction((squad) => {
      const list = Array.isArray(squad) ? [...squad] : [];
      const idx = list.findIndex((entry) => {
        if (entry && typeof entry === 'object') {
          const entryPlayerId = String(entry.playerId || entry.id || '').trim();
          return entryPlayerId === String(playerId);
        }
        return String(entry) === String(playerId);
      });

      if (idx >= 0) {
        list.splice(idx, 1);
      }
      return list;
    });
  }

  await db.ref(`rooms/${roomCode}/soldPlayers/${playerId}`).remove();
}

window.undoAuctionAction = undoAuctionAction;

async function autoWithdrawFromCurrentPlayerIfNeeded(data) {
  if (isSpectator) return;
  if (!data || data.status !== 'bidding') return;
  if (!data.playerId) return;
  if (data.highestBidder === myTeamId) return;
  if (data.withdrawnTeams && data.withdrawnTeams[myTeamId]) return;
  if (autoWithdrawInFlightForPlayerId === data.playerId) return;

  autoWithdrawInFlightForPlayerId = data.playerId;
  try {
    await db.ref(`rooms/${roomCode}/currentAuction`).transaction(auction => {
      if (!auction || auction.status !== 'bidding') return;
      if (auction.playerId !== data.playerId) return;
      if (auction.highestBidder === myTeamId) return;
      auction.withdrawnTeams = auction.withdrawnTeams || {};
      if (auction.withdrawnTeams[myTeamId]) return;
      auction.withdrawnTeams[myTeamId] = true;
      return auction;
    });
  } catch (err) {
    console.error('Auto-withdraw failed:', err);
  } finally {
    if (autoWithdrawInFlightForPlayerId === data.playerId) {
      autoWithdrawInFlightForPlayerId = null;
    }
  }
}

function renderBidHistory(data) {
  const listEl = document.getElementById('bidHistoryList');
  const countEl = document.getElementById('bidHistoryCount');
  if (!listEl || !countEl) return;

  const history = Array.isArray(data?.bidHistory) ? data.bidHistory : [];
  countEl.textContent = String(history.length);

  if (!history.length) {
    listEl.innerHTML = '<div class="bid-history-empty">No bids yet for this player.</div>';
    return;
  }

  const recent = history.slice(-12).reverse();
  listEl.innerHTML = recent.map((entry, idx) => {
    const team = teamsData[entry.teamId] || getRoomTeamMeta(entry.teamId) || {};
    const teamShort = team.short || entry.teamId || 'TEAM';
    const teamName = team.name || teamShort;
    const jumpText = entry.isBaseBid ? 'Base Bid' : `+${formatPrice(entry.jump || 0)}`;
    const bidText = formatPrice(entry.bid || 0);
    const stamp = entry.ts ? new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--:--';
    const latestCls = idx === 0 ? ' latest' : '';
    return `
      <div class="bid-history-item${latestCls}">
        <div class="bid-history-left">
          <span class="bid-history-team" title="${teamName}">${teamShort}</span>
          <span class="bid-history-jump">${jumpText}</span>
        </div>
        <div class="bid-history-right">
          <span class="bid-history-price">${bidText}</span>
          <span class="bid-history-time">${stamp}</span>
        </div>
      </div>
    `;
  }).join('');
}

function renderSpectatorBidHistory(data) {
  const listEl = document.getElementById('spectatorBidHistoryList');
  const countEl = document.getElementById('spectatorBidHistoryCount');
  if (!listEl || !countEl) return;

  const history = Array.isArray(data?.bidHistory) ? data.bidHistory : [];
  countEl.textContent = String(history.length);

  if (!history.length) {
    listEl.innerHTML = '<div class="bid-history-empty">No bids yet for this player.</div>';
    return;
  }

  const recent = history.slice(-12).reverse();
  listEl.innerHTML = recent.map((entry, idx) => {
    const team = teamsData[entry.teamId] || getRoomTeamMeta(entry.teamId) || {};
    const teamShort = team.short || entry.teamId || 'TEAM';
    const teamName = team.name || teamShort;
    const jumpText = entry.isBaseBid ? 'Base Bid' : `+${formatPrice(entry.jump || 0)}`;
    const bidText = formatPrice(entry.bid || 0);
    const stamp = entry.ts ? new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--:--';
    const latestCls = idx === 0 ? ' latest' : '';
    return `
      <div class="bid-history-item${latestCls}">
        <div class="bid-history-left">
          <span class="bid-history-team" title="${teamName}">${teamShort}</span>
          <span class="bid-history-jump">${jumpText}</span>
        </div>
        <div class="bid-history-right">
          <span class="bid-history-price">${bidText}</span>
          <span class="bid-history-time">${stamp}</span>
        </div>
      </div>
    `;
  }).join('');
}

function replayBidPanelMotion(panelEl) {
  if (!panelEl) return;
  if (activeMagneticButton) {
    resetMagneticButton(activeMagneticButton);
    activeMagneticButton = null;
  }
  panelEl.classList.remove('motion-stagger');
  void panelEl.offsetWidth;
  panelEl.classList.add('motion-stagger');
}

function initBidButtonMagneticHover() {
  if (magneticPointerEnabled) return;
  const canUseHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  if (!canUseHover) return;

  const panel = document.querySelector('.bid-panel');
  if (!panel) return;

  magneticPointerEnabled = true;

  panel.addEventListener('pointermove', (event) => {
    const btn = event.target.closest('.quick-bid-btn, .base-bid-btn');
    if (!btn || btn.disabled) {
      if (activeMagneticButton) {
        resetMagneticButton(activeMagneticButton);
        activeMagneticButton = null;
      }
      return;
    }

    if (activeMagneticButton && activeMagneticButton !== btn) {
      resetMagneticButton(activeMagneticButton);
    }
    activeMagneticButton = btn;

    const rect = btn.getBoundingClientRect();
    const relX = event.clientX - rect.left;
    const relY = event.clientY - rect.top;
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const dx = clamp((relX - centerX) * 0.08, -4, 4);
    const dy = clamp((relY - centerY) * 0.12, -3, 3);

    btn.style.setProperty('--mag-x', `${dx}px`);
    btn.style.setProperty('--mag-y', `${dy}px`);
    btn.style.setProperty('--glow-x', `${(relX / rect.width) * 100}%`);
    btn.style.setProperty('--glow-y', `${(relY / rect.height) * 100}%`);
    btn.classList.add('magnetic-active');
  });

  panel.addEventListener('pointerleave', () => {
    if (!activeMagneticButton) return;
    resetMagneticButton(activeMagneticButton);
    activeMagneticButton = null;
  });
}

function resetMagneticButton(btn) {
  if (!btn) return;
  btn.classList.remove('magnetic-active');
  btn.style.setProperty('--mag-x', '0px');
  btn.style.setProperty('--mag-y', '0px');
  btn.style.setProperty('--glow-x', '50%');
  btn.style.setProperty('--glow-y', '50%');
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function leaveAuction() {
  const confirmed = window.confirm('Leave this auction screen? You can join again later with the same room code.');
  if (!confirmed) return;
  detachSpectatorPollListener();
  if (isHost && hostPresenceRef) {
    hostPresenceRef.remove().catch(() => {});
  }
  removeSpectatorPresence();
  leaveVoiceChat();
  clearSession();
  window.location.href = 'index.html';
}

// ---- TIMER ----
function timerTick() {
  if (paused) {
    if (unlimitedTimer && currentAuctionData && currentAuctionData.status === 'bidding') {
      updateTimerDisplay(null, 1);
      updateSpectatorPanel(currentAuctionData);
      return;
    }

    const freezeLeft = currentAuctionData && currentAuctionData.status === 'bidding'
      ? Math.max(0, Math.ceil((currentAuctionData.timerEnd - getSyncedNowMs()) / 1000))
      : timerSeconds;
    updateTimerDisplay(freezeLeft, timerSeconds);
    updateSpectatorPanel(currentAuctionData);
    return;
  }

  if (!currentAuctionData || currentAuctionData.status !== 'bidding') {
    updateTimerDisplay(0, timerSeconds);
    updateSpectatorPanel(currentAuctionData);
    return;
  }

  if (unlimitedTimer) {
    updateTimerDisplay(null, 1);
    updateSpectatorPanel(currentAuctionData);
    return;
  }

  const timeLeft = Math.max(0, Math.ceil((currentAuctionData.timerEnd - getSyncedNowMs()) / 1000));
  updateTimerDisplay(timeLeft, timerSeconds);
  updateSpectatorPanel(currentAuctionData);

  // Host or fallback driver processes round when timer hits 0.
  if (timeLeft <= 0 && canDriveAuctionEngine() && !processingRound) {
    processingRound = true;
    processAuctionRound();
  }
}

function updateTimerDisplay(secondsLeft, total) {
  const val = document.getElementById('timerValue');
  const ring = document.getElementById('timerRing');
  if (!val || !ring) return;

  if (secondsLeft === null) {
    val.textContent = '∞';
    ring.style.strokeDashoffset = 0;
    ring.style.stroke = 'var(--blue)';
    val.style.color = 'var(--blue)';
    lastTimerSoundSecond = -1;
    return;
  }

  val.textContent = secondsLeft;

  const circumference = 2 * Math.PI * 45; // 283
  const offset = circumference * (1 - secondsLeft / total);
  ring.style.strokeDashoffset = offset;

  if (secondsLeft <= 5) { ring.style.stroke = '#FF4D4D'; val.style.color = '#FF4D4D'; }
  else if (secondsLeft <= 10) { ring.style.stroke = '#FF8C00'; val.style.color = '#FF8C00'; }
  else { ring.style.stroke = 'var(--gold)'; val.style.color = 'var(--gold)'; }

  if (!paused && currentAuctionData && currentAuctionData.status === 'bidding' && secondsLeft > 0 && secondsLeft <= 5) {
    if (lastTimerSoundSecond !== secondsLeft) {
      lastTimerSoundSecond = secondsLeft;
      playTimerCountdownSfx(secondsLeft);
    }
  } else if (secondsLeft > 5 || secondsLeft === 0) {
    lastTimerSoundSecond = -1;
  }
}

// ---- PLACE BID ----
async function placeBid(selectedJump = null, useBaseBid = false) {
  if (isBidUiSpectator()) {
    showToast('Viewer mode: bidding is disabled.', 'error');
    return;
  }
  if (!currentAuctionData || currentAuctionData.status !== 'bidding') return;
  if (paused) {
    showToast('Auction is paused.', 'error');
    return;
  }

  ensureHostProxyBidTeamSelected();
  const actingTeamId = getActingTeamIdForBidUi();
  const actingTeam = actingTeamId ? getHostProxyTeamState(actingTeamId) : null;
  if (!actingTeamId || !actingTeam) {
    showToast('Select a team to bid.', 'error');
    return;
  }

  const currentPlayer = playerMap[currentAuctionData.playerId];
  if (!currentPlayer) return;

  const allowedJumps = getBidJumpOptions(currentPlayer.base_price_lakh, roomConfig.bidOptions);
  const isBaseBid = !!useBaseBid;
  const jump = isBaseBid
    ? 0
    : (selectedJump && allowedJumps.includes(selectedJump) ? selectedJump : allowedJumps[0]);
  const nextBid = isBaseBid ? currentAuctionData.currentBid : (currentAuctionData.currentBid + jump);
  if (currentAuctionData.withdrawnTeams && currentAuctionData.withdrawnTeams[actingTeamId]) {
    showToast('You withdrew for this player.', 'error');
    return;
  }

  if (isBaseBid && currentAuctionData.highestBidder) {
    showToast('Base bid is available only before first bid.', 'error');
    return;
  }

  if (!isBaseBid && !currentAuctionData.highestBidder) {
    showToast('First bid must be at base price.', 'error');
    return;
  }

  const mySquadCount = (actingTeam.squad || []).length;
  if (mySquadCount >= roomConfig.maxSquadSize) {
    showToast('Your squad is full. You cannot bid.', 'error');
    return;
  }

  if (actingTeam.purse < nextBid) {
    showToast('You do not have enough purse for this bid.', 'error');
    return;
  }

  if (currentAuctionData.highestBidder === actingTeamId) {
    showToast('You are already the highest bidder.', 'error');
    return;
  }

  try {
    await db.ref(`rooms/${roomCode}/currentAuction`).transaction(auction => {
      if (!auction || auction.status !== 'bidding') return; // abort
      const txnPlayer = playerMap[auction.playerId];
      if (!txnPlayer) return;

      if (isBaseBid) {
        if (auction.highestBidder) return;
      } else {
        if (!auction.highestBidder) return;
        const txnAllowedJumps = getBidJumpOptions(txnPlayer.base_price_lakh, roomConfig.bidOptions);
        if (!txnAllowedJumps.includes(jump)) return;
      }

      const txnNextBid = isBaseBid ? auction.currentBid : (auction.currentBid + jump);
      if (txnNextBid !== nextBid) return; // stale UI value, abort and let client refresh
      if (auction.withdrawnTeams && auction.withdrawnTeams[actingTeamId]) return;
      auction.currentBid = txnNextBid;
      auction.highestBidder = actingTeamId;
      auction.bidHistory = Array.isArray(auction.bidHistory) ? auction.bidHistory : [];
      auction.bidHistory.push({
        teamId: actingTeamId,
        bid: txnNextBid,
        jump: isBaseBid ? 0 : jump,
        isBaseBid,
        ts: getSyncedNowMs()
      });
      if (auction.bidHistory.length > 30) {
        auction.bidHistory = auction.bidHistory.slice(-30);
      }
      // Reset timer on each bid
      if (!unlimitedTimer) {
        auction.timerEnd = getSyncedNowMs() + timerSeconds * 1000;
      }
      return auction;
    });
  } catch (err) {
    console.error('Bid failed:', err);
  }
}

// ---- PASS PLAYER (host only) ----
async function passPlayer() {
  if (isBidUiSpectator()) {
    showToast('Viewer mode: skip vote is disabled.', 'error');
    return;
  }
  if (!currentAuctionData || currentAuctionData.status !== 'bidding' || paused) return;

  ensureHostProxyBidTeamSelected();
  const actingTeamId = getActingTeamIdForBidUi();
  const actingTeam = actingTeamId ? getHostProxyTeamState(actingTeamId) : null;
  if (!actingTeamId || !actingTeam) {
    showToast('Select a team first.', 'error');
    return;
  }

  if (actingTeam && (actingTeam.squad || []).length >= roomConfig.maxSquadSize) {
    showToast('Your squad is complete. Skip is disabled.', 'error');
    return;
  }

  if (currentAuctionData.highestBidder) {
    showToast('Skip is only available before the first bid.', 'error');
    return;
  }

  try {
    await db.ref(`rooms/${roomCode}/currentAuction`).transaction(auction => {
      if (!auction || auction.status !== 'bidding') return;
      if (auction.highestBidder) return;
      auction.skipVotes = auction.skipVotes || {};
      auction.skipVotes[actingTeamId] = true;
      return auction;
    });
  } catch (err) {
    console.error('Skip vote failed:', err);
  }
}

async function skipCurrentPool() {
  if (isBidUiSpectator()) {
    showToast('Viewer mode: pool skip is disabled.', 'error');
    return;
  }
  if (!currentAuctionData || currentAuctionData.status !== 'bidding' || paused) return;

  ensureHostProxyBidTeamSelected();
  const actingTeamId = getActingTeamIdForBidUi();
  const actingTeam = actingTeamId ? getHostProxyTeamState(actingTeamId) : null;
  if (!actingTeamId || !actingTeam) {
    showToast('Select a team first.', 'error');
    return;
  }

  if (actingTeam && (actingTeam.squad || []).length >= roomConfig.maxSquadSize) {
    showToast('Your squad is complete. Pool skip is disabled.', 'error');
    return;
  }

  const currentPool = getCurrentPoolMeta();
  if (!currentPool?.poolId) {
    showToast('Pool skip is available only in category mode.', 'error');
    return;
  }

  try {
    await db.ref(`rooms/${roomCode}/currentAuction`).transaction(auction => {
      if (!auction || auction.status !== 'bidding') return;
      const poolId = auction.poolId || currentPool.poolId;
      if (!poolId) return;
      auction.poolSkipVotes = auction.poolSkipVotes || {};
      auction.poolSkipVotes[actingTeamId] = true;
      return auction;
    });
  } catch (err) {
    console.error('Pool skip vote failed:', err);
  }
}

async function withdrawFromPlayer() {
  if (isBidUiSpectator()) {
    showToast('Viewer mode: withdraw is disabled.', 'error');
    return;
  }
  if (!currentAuctionData || currentAuctionData.status !== 'bidding' || paused) return;

  ensureHostProxyBidTeamSelected();
  const actingTeamId = getActingTeamIdForBidUi();
  const actingTeam = actingTeamId ? teamsData[actingTeamId] : null;
  if (!actingTeamId || !actingTeam) {
    showToast('Select a team first.', 'error');
    return;
  }

  if (actingTeam && (actingTeam.squad || []).length >= roomConfig.maxSquadSize) {
    showToast('Your squad is complete. No manual action needed.', 'error');
    return;
  }

  if (currentAuctionData.highestBidder === actingTeamId) {
    showToast('Leading bidder cannot withdraw.', 'error');
    return;
  }

  try {
    await db.ref(`rooms/${roomCode}/currentAuction`).transaction(auction => {
      if (!auction || auction.status !== 'bidding') return;
      if (auction.highestBidder === actingTeamId) return;
      auction.withdrawnTeams = auction.withdrawnTeams || {};
      auction.withdrawnTeams[actingTeamId] = true;
      return auction;
    });
  } catch (err) {
    console.error('Withdraw failed:', err);
  }
}

async function hostEvaluateFastPath(data) {
  if (!canDriveAuctionEngine() || paused || !data || data.status !== 'bidding' || processingRound) return;

  const totalTeams = Object.keys(teamsData).length;
  const skipCount = Object.keys(data.skipVotes || {}).length;
  const poolSkipCount = Object.keys(data.poolSkipVotes || {}).length;
  const withdrawnCount = Object.keys(data.withdrawnTeams || {}).length;
  const currentPool = getCurrentPoolMeta();

  if (currentPool?.poolId && totalTeams > 0 && poolSkipCount >= totalTeams) {
    processingRound = true;
    await processSkipCurrentPool();
    return;
  }

  if (!data.highestBidder) {
    const eligibleTeams = Object.entries(teamsData).filter(([teamId, team]) => {
      if (data.withdrawnTeams && data.withdrawnTeams[teamId]) return false;
      const squadCount = (team.squad || []).length;
      if (squadCount >= roomConfig.maxSquadSize) return false;
      return (team.purse || 0) >= data.currentBid;
    });

    if (eligibleTeams.length === 0) {
      processingRound = true;
      await processAsUnsold();
      return;
    }

    if (totalTeams > 0 && (skipCount >= totalTeams || withdrawnCount >= totalTeams)) {
      processingRound = true;
      await processAsUnsold();
    }
    return;
  }

  const currentPlayer = playerMap[data.playerId];
  if (!currentPlayer) return;
  const minJump = getBidJumpOptions(currentPlayer.base_price_lakh, roomConfig.bidOptions)[0];
  const nextBid = data.currentBid + minJump;
  const openChallengers = Object.entries(teamsData).filter(([teamId, team]) => {
    if (teamId === data.highestBidder) return false;
    if (data.withdrawnTeams && data.withdrawnTeams[teamId]) return false;
    const squadCount = (team.squad || []).length;
    if (squadCount >= roomConfig.maxSquadSize) return false;
    return (team.purse || 0) >= nextBid;
  });

  if (openChallengers.length === 0) {
    processingRound = true;
    await processAuctionRound();
  }
}

async function processSkipCurrentPool() {
  const statusRef = db.ref(`rooms/${roomCode}/currentAuction/status`);
  const result = await statusRef.transaction(status => {
    if (status === 'bidding') return 'processing';
    return undefined;
  });
  if (!result.committed) return;
  await skipToNextPool();
}

async function skipToNextPool() {
  const currentPool = getCurrentPoolMeta();
  const currentPoolId = currentPool?.poolId;
  if (!currentPoolId) {
    await markUnsold();
    return;
  }

  let nextIndex = currentIndex + 1;
  while (nextIndex < playerQueue.length) {
    const nextPool = getPoolMetaAtIndex(nextIndex);
    if (!nextPool?.poolId || nextPool.poolId !== currentPoolId) break;
    nextIndex += 1;
  }

  if (nextIndex >= playerQueue.length) {
    await db.ref(`rooms/${roomCode}/config/status`).set('finished');
    await syncAuctionHistoryStatus('finished', { finishedAt: Date.now(), finishReason: 'pool-skip-end' });
    return;
  }

  const nextPlayerId = playerQueue[nextIndex];
  const nextPlayer = playerMap[nextPlayerId];
  if (!nextPlayer) {
    await advanceHelper(nextIndex);
    return;
  }
  const nextPool = getPoolMetaAtIndex(nextIndex);

  await db.ref(`rooms/${roomCode}/currentIndex`).set(nextIndex);
  await db.ref(`rooms/${roomCode}/currentAuction`).set({
    playerId: nextPlayerId,
    currentBid: nextPlayer.base_price_lakh,
    highestBidder: null,
    bidHistory: [],
    poolId: nextPool?.poolId || null,
    poolLabel: nextPool?.poolLabel || null,
    skipVotes: {},
    poolSkipVotes: {},
    withdrawnTeams: {},
    timerEnd: unlimitedTimer ? null : (getSyncedNowMs() + timerSeconds * 1000),
    status: 'bidding'
  });
}

async function processAsUnsold() {
  const statusRef = db.ref(`rooms/${roomCode}/currentAuction/status`);
  const result = await statusRef.transaction(status => {
    if (status === 'bidding') return 'processing';
    return undefined;
  });
  if (!result.committed) return;
  await markUnsold();
}

// ---- PROCESS AUCTION ROUND (host) ----
async function processAuctionRound() {
  if (!currentAuctionData) return;

  // Use a transaction to atomically change status to prevent double-processing
  const ref = db.ref(`rooms/${roomCode}/currentAuction/status`);
  const result = await ref.transaction(status => {
    if (status === 'bidding') return 'processing';
    return undefined; // abort
  });

  if (!result.committed) return; // someone else already handled it

  const { playerId, currentBid, highestBidder } = currentAuctionData;

  if (highestBidder) {
    await markSold(playerId, highestBidder, currentBid);
  } else {
    await markUnsold();
  }
}

async function markSold(playerId, winnerTeamId, price) {
  await db.ref(`rooms/${roomCode}/currentAuction/status`).set('sold');

  // Record sale
  await db.ref(`rooms/${roomCode}/soldPlayers/${playerId}`).set({
    teamId: winnerTeamId,
    soldPrice: price,
    soldAt: Date.now()
  });

  // Deduct purse
  await db.ref(`rooms/${roomCode}/teams/${winnerTeamId}/purse`).transaction(purse => {
    return (purse || 0) - price;
  });

  // Add to squad (push to array)
  const squadRef = db.ref(`rooms/${roomCode}/teams/${winnerTeamId}/squad`);
  const squadSnap = await squadRef.get();
  const squad = squadSnap.val() || [];
  squad.push(playerId);
  await squadRef.set(squad);

  // Advance after delay
  setTimeout(advanceToNextPlayer, 3000);
}

async function markUnsold() {
  await db.ref(`rooms/${roomCode}/currentAuction/status`).set('unsold');
  setTimeout(advanceToNextPlayer, 3000);
}

async function advanceToNextPlayer() {
  if (await areAllTeamsComplete()) {
    const finishedAt = Date.now();
    await db.ref(`rooms/${roomCode}/config`).update({
      status: 'finished',
      finishedAt,
      finishReason: 'all-squads-complete'
    });
    await syncAuctionHistoryStatus('finished', { finishedAt, finishReason: 'all-squads-complete' });
    return;
  }

  const nextIndex = currentIndex + 1;

  if (nextIndex >= playerQueue.length) {
    // Auction over
    await db.ref(`rooms/${roomCode}/config/status`).set('finished');
    await syncAuctionHistoryStatus('finished', { finishedAt: Date.now(), finishReason: 'queue-complete' });
    return;
  }

  const nextPlayerId = playerQueue[nextIndex];
  const nextPlayer = playerMap[nextPlayerId];
  if (!nextPlayer) { await advanceHelper(nextIndex); return; }
  const nextPool = getPoolMetaAtIndex(nextIndex);

  await db.ref(`rooms/${roomCode}/currentIndex`).set(nextIndex);
  await db.ref(`rooms/${roomCode}/currentAuction`).set({
    playerId: nextPlayerId,
    currentBid: nextPlayer.base_price_lakh,
    highestBidder: null,
    bidHistory: [],
    poolId: nextPool?.poolId || null,
    poolLabel: nextPool?.poolLabel || null,
    skipVotes: {},
    poolSkipVotes: {},
    withdrawnTeams: {},
    timerEnd: unlimitedTimer ? null : (getSyncedNowMs() + timerSeconds * 1000),
    status: 'bidding'
  });
}

async function areAllTeamsComplete() {
  if (!roomConfig || !roomConfig.maxSquadSize) return false;

  const teamsSnap = await db.ref(`rooms/${roomCode}/teams`).get();
  if (!teamsSnap.exists()) return false;

  const teams = teamsSnap.val() || {};
  const teamList = Object.values(teams);
  if (!teamList.length) return false;

  return teamList.every(team => (team.squad || []).length >= roomConfig.maxSquadSize);
}

function getPoolMetaAtIndex(index) {
  if (!poolByIndex) return null;
  return poolByIndex[index] || poolByIndex[String(index)] || null;
}

function buildPoolIndexMap() {
  poolIndexMap = {};
  if (!Array.isArray(playerQueue) || !poolByIndex) return;

  playerQueue.forEach((playerId, idx) => {
    const meta = getPoolMetaAtIndex(idx);
    if (!meta?.poolId) return;
    if (!poolIndexMap[meta.poolId]) {
      poolIndexMap[meta.poolId] = {
        poolId: meta.poolId,
        poolLabel: meta.poolLabel || 'Category Pool',
        players: []
      };
    }
    poolIndexMap[meta.poolId].players.push({ playerId, index: idx });
  });
}

function getCurrentPoolMeta() {
  if (currentAuctionData?.poolId) {
    return {
      poolId: currentAuctionData.poolId,
      poolLabel: currentAuctionData.poolLabel || 'Category Pool'
    };
  }
  const fromIndex = getPoolMetaAtIndex(currentIndex);
  if (fromIndex?.poolId) return fromIndex;
  return null;
}

function formatPoolLabelForDisplay(label) {
  if (!label) return 'Category Pool';
  return label.replace(/\s*\([^)]*\)/g, '').trim();
}

function getPoolPlayerStatus(playerId, queueIndex) {
  const sold = !!soldPlayersData[playerId];
  if (sold) return 'sold';

  if (queueIndex < currentIndex) return 'unsold';

  if (queueIndex === currentIndex && currentAuctionData) {
    if (currentAuctionData.status === 'sold' && (currentAuctionData.playerId === playerId)) return 'sold';
    if (currentAuctionData.status === 'unsold' && (currentAuctionData.playerId === playerId)) return 'unsold';
  }

  return 'remaining';
}

function getPoolStats(poolId) {
  const pool = poolIndexMap[poolId];
  if (!pool || !pool.players) return { total: 0, sold: 0, unsold: 0, remaining: 0 };

  const stats = { total: pool.players.length, sold: 0, unsold: 0, remaining: 0 };
  pool.players.forEach(({ playerId, index }) => {
    const status = getPoolPlayerStatus(playerId, index);
    stats[status] += 1;
  });

  return stats;
}

function getPlayerQueueIndex(playerId) {
  const normalized = String(playerId || '').trim();
  if (!normalized) return -1;
  const idx = playerQueue.findIndex((id) => String(id) === normalized);
  if (idx >= 0) return idx;
  return allPlayers.findIndex((player) => String(player.id) === normalized);
}

function getLivePlayerStatus(playerId) {
  const normalized = String(playerId || '').trim();
  if (!normalized) return 'available';
  const sold = !!soldPlayersData[normalized] || !!soldPlayersData[String(normalized)];
  if (sold) return 'sold';

  if (currentAuctionData?.playerId && String(currentAuctionData.playerId) === normalized) {
    if (currentAuctionData.status === 'sold') return 'sold';
    if (currentAuctionData.status === 'unsold') return 'unsold';
    return 'available';
  }

  const queueIndex = getPlayerQueueIndex(normalized);
  if (queueIndex >= 0 && queueIndex < currentIndex) return 'unsold';
  return 'available';
}

function openLivePlayerListModal(type) {
  const safeType = type === 'sold' || type === 'unsold' ? type : 'available';
  const overlayEl = document.getElementById('livePlayerListModalOverlay');
  const titleEl = document.getElementById('livePlayerListModalTitle');
  const summaryEl = document.getElementById('livePlayerListSummary');
  const contentEl = document.getElementById('livePlayerListContent');
  if (!overlayEl || !titleEl || !summaryEl || !contentEl) return;

  const filteredPlayers = [...allPlayers]
    .filter((player) => getLivePlayerStatus(player.id) === safeType)
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

  const rows = filteredPlayers.map((player) => {
    const status = getLivePlayerStatus(player.id);
    const soldInfo = soldPlayersData[player.id] || soldPlayersData[String(player.id)] || null;
    const buyer = soldInfo?.teamId ? (teamsData[soldInfo.teamId] || getRoomTeamMeta(soldInfo.teamId) || null) : null;
    const buyerLabel = buyer ? (buyer.short || buyer.name || soldInfo.teamId) : '';
    const avatarHtml = player.photo_url
      ? `<img src="${player.photo_url}" alt="${player.name}" loading="lazy" decoding="async" onerror="handlePlayerImageError(this, '${getPlayerInitials(player.name)}')" />`
      : getPlayerInitials(player.name);
    const numberBadgeHtml = buildPlayerNumberBadgeHtml(player, true);
    const detailText = status === 'sold'
      ? `${buyerLabel} · ${formatPrice(Number(soldInfo?.soldPrice || 0))}`
      : status === 'unsold'
        ? 'Moved to unsold list'
        : 'Still available in live pool';

    return `
      <div class="live-player-row ${status}">
        <div class="result-player-avatar" style="background:linear-gradient(135deg,${getRoleColor(player.role)}99,${getRoleColor(player.role)}44)">${numberBadgeHtml}${avatarHtml}</div>
        <div class="live-player-main">
          <div class="result-player-name">${player.name}</div>
          <div class="live-player-sub">${getRoleIcon(player.role)} ${player.role} · ${formatPrice(player.base_price_lakh)}</div>
          <div class="live-player-detail">${detailText}</div>
        </div>
        <span class="pool-status ${status}">${status.toUpperCase()}</span>
      </div>
    `;
  }).join('');

  titleEl.textContent = `${safeType.charAt(0).toUpperCase()}${safeType.slice(1)} Players`;
  summaryEl.innerHTML = `<span class="pool-summary-pill ${safeType}">${filteredPlayers.length} players</span>`;
  contentEl.innerHTML = rows || '<div class="state-empty" style="padding:1.5rem 1rem;"><p>No players found for this view.</p></div>';
  overlayEl.classList.add('visible');
}

function closeLivePlayerListModal() {
  const overlayEl = document.getElementById('livePlayerListModalOverlay');
  if (overlayEl) overlayEl.classList.remove('visible');
}

function renderCurrentPoolBanner() {
  const banner = document.getElementById('currentPoolBanner');
  const nameEl = document.getElementById('currentPoolBannerName');
  const metaEl = document.getElementById('currentPoolBannerMeta');
  if (!banner || !nameEl || !metaEl) return;

  const currentPool = getCurrentPoolMeta();
  if (!currentPool?.poolId || !poolIndexMap[currentPool.poolId]) {
    banner.style.display = 'none';
    return;
  }

  const stats = getPoolStats(currentPool.poolId);
  banner.style.display = 'inline-flex';
  nameEl.textContent = formatPoolLabelForDisplay(currentPool.poolLabel);
  metaEl.textContent = `${stats.total} players · Sold ${stats.sold} · Unsold ${stats.unsold} · Remaining ${stats.remaining}`;
}

function showCurrentPoolDetails() {
  const currentPool = getCurrentPoolMeta();
  if (!currentPool?.poolId) return;

  const pool = poolIndexMap[currentPool.poolId];
  if (!pool) return;

  const titleEl = document.getElementById('poolModalTitle');
  const summaryEl = document.getElementById('poolSummaryRow');
  const contentEl = document.getElementById('poolModalContent');
  const overlayEl = document.getElementById('poolModalOverlay');
  if (!titleEl || !summaryEl || !contentEl || !overlayEl) return;

  const stats = getPoolStats(currentPool.poolId);
  titleEl.textContent = currentPool.poolLabel;
  summaryEl.innerHTML = `
    <span class="pool-summary-pill sold">Sold: ${stats.sold}</span>
    <span class="pool-summary-pill unsold">Unsold: ${stats.unsold}</span>
    <span class="pool-summary-pill remaining">Remaining: ${stats.remaining}</span>
    <span class="pool-summary-total">Total: ${stats.total}</span>
  `;

  const displayPlayers = [...pool.players].sort((a, b) => {
    const pa = playerMap[a.playerId];
    const pb = playerMap[b.playerId];
    return String(pa?.name || '').localeCompare(String(pb?.name || ''));
  });

  const rows = displayPlayers.map(({ playerId, index }) => {
    const player = playerMap[playerId];
    if (!player) return '';
    const status = getPoolPlayerStatus(playerId, index);
    const soldInfo = soldPlayersData[playerId] || null;
    const buyerTeam = soldInfo?.teamId ? teamsData[soldInfo.teamId] : null;
    const buyerDef = soldInfo?.teamId ? getRoomTeamMeta(soldInfo.teamId) : null;
    const soldTeamCode = status === 'sold'
      ? (buyerTeam?.short || buyerDef?.short || soldInfo?.teamId || 'TEAM')
      : '';
    const soldTeamColor = buyerDef?.primary || '#00C48C';
    const soldPriceText = status === 'sold' && soldInfo?.soldPrice
      ? formatPrice(soldInfo.soldPrice)
      : '';
    const avatarHtml = player.photo_url
      ? `<img src="${player.photo_url}" alt="${player.name}" loading="eager" decoding="async" fetchpriority="high" onerror="handlePlayerImageError(this, '${getPlayerInitials(player.name)}')" />`
      : getPlayerInitials(player.name);
    const numberBadgeHtml = buildPlayerNumberBadgeHtml(player, true);
    return `
      <div class="pool-player-row">
        <div class="result-player-avatar" style="background:linear-gradient(135deg,${getRoleColor(player.role)}99,${getRoleColor(player.role)}44)">${numberBadgeHtml}${avatarHtml}</div>
        <div style="flex:1;min-width:0;">
          <div class="result-player-name">${player.name}</div>
          <div style="font-size:0.72rem;color:var(--text-dim)">${getRoleIcon(player.role)} ${player.role} · ${formatPrice(player.base_price_lakh)}</div>
        </div>
        <div class="pool-row-right">
          ${status === 'sold' ? `<span class="pool-sold-team" style="--sold-team-color:${soldTeamColor}">${soldTeamCode}</span>` : ''}
          ${status === 'sold' ? `<span class="pool-sold-price">${soldPriceText}</span>` : ''}
          <span class="pool-status ${status}">${status.toUpperCase()}</span>
        </div>
      </div>
    `;
  }).join('');

  contentEl.innerHTML = rows || '<div class="state-empty" style="padding:1.5rem 1rem;"><p>No players in this pool.</p></div>';
  overlayEl.classList.add('visible');
}

function closePoolDetailsModal() {
  const overlayEl = document.getElementById('poolModalOverlay');
  if (overlayEl) overlayEl.classList.remove('visible');
}

function showPoolStartBanner(poolId, poolLabel) {
  if (!poolId || poolId === lastPoolNoticeId) return;
  lastPoolNoticeId = poolId;

  const banner = document.getElementById('poolStartBanner');
  const nameEl = document.getElementById('poolStartName');
  if (!banner || !nameEl) return;

  nameEl.textContent = formatPoolLabelForDisplay(poolLabel);
  banner.classList.add('show');
  setTimeout(() => {
    banner.classList.remove('show');
  }, 2300);
}

async function advanceHelper(idx) {
  // Skip invalid player IDs
  if (idx >= playerQueue.length) {
    await db.ref(`rooms/${roomCode}/config/status`).set('finished');
    return;
  }
  await advanceToNextPlayer();
}

// ---- SIDEBAR ----
function normalizeTeamSquadEntries(team) {
  const rawSquad = Array.isArray(team?.squad) ? team.squad : [];
  return rawSquad
    .map((entry) => {
      if (entry && typeof entry === 'object') {
        const playerId = String(entry.playerId || entry.id || '').trim();
        if (!playerId) return null;
        const sold = soldPlayersData[playerId] || soldPlayersData[String(playerId)] || null;
        return {
          playerId,
          isIcon: entry.type === 'icon' || sold?.via === 'icon' || sold?.type === 'icon',
          iconPrice: Number(entry.priceLakh || sold?.soldPrice || 0)
        };
      }

      const playerId = String(entry || '').trim();
      if (!playerId) return null;
      const sold = soldPlayersData[playerId] || soldPlayersData[String(playerId)] || null;
      return {
        playerId,
        isIcon: sold?.via === 'icon' || sold?.type === 'icon',
        iconPrice: Number(sold?.soldPrice || 0)
      };
    })
    .filter(Boolean);
}

function renderSidebar() {
  const container = document.getElementById('sidebarTeams');
  const sortedTeams = Object.entries(teamsData).sort((a, b) => {
    if (a[0] === myTeamId && b[0] !== myTeamId) return -1;
    if (b[0] === myTeamId && a[0] !== myTeamId) return 1;
    return (b[1].purse || 0) - (a[1].purse || 0);
  });

  container.innerHTML = sortedTeams.map(([tId, team]) => {
    const t = getRoomTeamMeta(tId);
    const isLeading = currentAuctionData && currentAuctionData.highestBidder === tId;
    const isMe = tId === myTeamId;
    const squadEntries = normalizeTeamSquadEntries(team);
    const squadCount = squadEntries.length;
    const maxSquad = Number(roomConfig?.maxSquadSize || 0);
    const minSquad = Number(roomConfig?.minSquadSize || 1);
    const squadText = maxSquad > 0 ? `${squadCount}/${maxSquad}` : `${squadCount}`;
    const minRequiredRemaining = Math.max(0, minSquad - squadCount);
    const minNoteText = minRequiredRemaining > 0
      ? `min ${minRequiredRemaining} required`
      : 'minimum satisfied';

    return `
      <div class="sidebar-team ${isLeading ? 'leading' : ''} ${isMe ? 'mine' : ''}"
           onclick="showTeamSquad('${tId}')"
           style="--team-color:${t?.primary || '#888'}">
        <div class="team-row-top">
          <span class="team-short-badge">${t?.logo ? `<img class="sidebar-team-logo" src="${t.logo}" alt="${team.short} logo" loading="lazy" decoding="async" />` : ''} ${team.short}</span>
          <span class="team-owner-name">${team.ownerName}</span>
          ${(isHost && !isMe) ? `<button class="team-remove-btn" onclick="event.stopPropagation(); removeTeamFromAuction('${tId}')" title="Remove ${team.ownerName}">Remove</button>` : ''}
          ${team.isHost ? '<span class="leading-crown">👑</span>' : ''}
        </div>
        <div class="team-row-bottom">
          <span class="team-stat">💰 <span>${formatPrice(team.purse)}</span></span>
          <span class="team-stat">🏃 <span>${squadText} players</span><small class="team-min-note">${minNoteText}</small></span>
        </div>
      </div>
    `;
  }).join('');
}

async function removeTeamFromAuction(targetTeamId) {
  if (!isHost) return;
  if (!targetTeamId || targetTeamId === myTeamId) {
    showToast('Host team cannot be removed.', 'error');
    return;
  }

  const target = teamsData[targetTeamId];
  if (!target) {
    showToast('Team not found.', 'error');
    return;
  }

  if (!confirm(`Remove ${target.ownerName} (${target.short}) from this auction?`)) return;

  try {
    await db.ref(`rooms/${roomCode}/teams/${targetTeamId}`).remove();
    await db.ref(`rooms/${roomCode}/voice/participants/${targetTeamId}`).remove();
    await db.ref(`rooms/${roomCode}/voice/muted/${targetTeamId}`).remove();
    await db.ref(`rooms/${roomCode}/voice/signals/${targetTeamId}`).remove();

    // Clean up this team from the current round state.
    await db.ref(`rooms/${roomCode}/currentAuction`).transaction(auction => {
      if (!auction) return auction;

      if (auction.skipVotes) delete auction.skipVotes[targetTeamId];
      if (auction.poolSkipVotes) delete auction.poolSkipVotes[targetTeamId];
      if (auction.withdrawnTeams) delete auction.withdrawnTeams[targetTeamId];

      if (auction.highestBidder === targetTeamId) {
        auction.highestBidder = null;
        const currentPlayer = playerMap[auction.playerId];
        if (currentPlayer) auction.currentBid = currentPlayer.base_price_lakh;
        if (!unlimitedTimer) {
          auction.timerEnd = getSyncedNowMs() + timerSeconds * 1000;
        }
      }

      return auction;
    });

    showToast(`${target.ownerName} removed`, 'success');
  } catch (err) {
    console.error('Remove user failed:', err);
    showToast('Failed to remove user.', 'error');
  }
}

function showTeamSquad(teamId) {
  const team = teamsData[teamId];
  if (!team) return;

  const t = getRoomTeamMeta(teamId);
  const squadEntries = normalizeTeamSquadEntries(team);

  document.getElementById('teamModalTitle').innerHTML = `${t?.logo ? `<img class="chip-team-logo" src="${t.logo}" alt="${team.short} logo" loading="lazy" decoding="async" />` : ''} ${team.name} Squad`;

  const roleSections = [
    { key: 'Batsman', label: 'Batsman' },
    { key: 'Wicket-keeper', label: 'Wicket-keeper' },
    { key: 'All-rounder', label: 'All-rounder' },
    { key: 'Fast Bowler', label: 'Fast Bowler' },
    { key: 'Spinner', label: 'Spinner' },
    { key: 'Bowler', label: 'Bowler' }
  ];

  const grouped = roleSections.reduce((acc, section) => {
    acc[section.key] = [];
    return acc;
  }, { Others: [] });

  function normalizeRole(role) {
    const token = String(role || '').toLowerCase().replace(/[\s-]+/g, '');
    if (token === 'batsman') return 'Batsman';
    if (token === 'wicketkeeper') return 'Wicket-keeper';
    if (token === 'allrounder') return 'All-rounder';
    if (token === 'fastbowler') return 'Fast Bowler';
    if (token === 'spinner') return 'Spinner';
    if (token === 'bowler') return 'Bowler';
    return 'Others';
  }

  for (const entry of squadEntries) {
    const p = playerMap[entry.playerId] || playerMap[String(entry.playerId)];
    if (!p) continue;
    const sectionKey = normalizeRole(p.role);
    grouped[sectionKey] = grouped[sectionKey] || [];
    grouped[sectionKey].push(entry);
  }

  for (const key of Object.keys(grouped)) {
    grouped[key].sort((a, b) => {
      const pa = playerMap[a.playerId] || playerMap[String(a.playerId)];
      const pb = playerMap[b.playerId] || playerMap[String(b.playerId)];
      return String(pa?.name || '').localeCompare(String(pb?.name || ''));
    });
  }

  const html = squadEntries.length === 0
    ? `<div class="state-empty" style="padding:1.5rem 1rem;"><p>No players bought yet.</p></div>`
    : [...roleSections, { key: 'Others', label: 'Others' }].map(section => {
        const sectionPlayers = grouped[section.key] || [];
        if (!sectionPlayers.length) return '';

        const sectionRows = sectionPlayers.map((entry) => {
          const p = playerMap[entry.playerId] || playerMap[String(entry.playerId)];
          if (!p) return '';
          const sold = soldPlayersData[entry.playerId] || soldPlayersData[String(entry.playerId)];
          const isIcon = !!entry.isIcon;
          const avatarHtml = p.photo_url
            ? `<img src="${p.photo_url}" alt="${p.name}" loading="lazy" decoding="async" onerror="handlePlayerImageError(this, '${getPlayerInitials(p.name)}')" />`
            : getPlayerInitials(p.name);
          const numberBadgeHtml = buildPlayerNumberBadgeHtml(p, true);
          return `
            <div class="result-player-row">
              <div class="result-player-avatar" style="background:linear-gradient(135deg,${getRoleColor(p.role)}99,${getRoleColor(p.role)}44)">${numberBadgeHtml}${avatarHtml}</div>
              <div style="flex:1;">
                <div class="result-player-name">${p.name}${isIcon ? '<span class="icon-player-tag">ICON</span>' : ''}</div>
                <div style="font-size:0.72rem;color:var(--text-dim)">${getRoleIcon(p.role)} ${p.role} · ${getCountryFlag(p.country)} ${p.country}${isIcon ? ' · Icon Player' : ''}</div>
              </div>
              <div class="result-player-price">${formatPrice(sold ? sold.soldPrice : p.base_price_lakh)}</div>
            </div>
          `;
        }).join('');

        return `
          <div style="margin-bottom:1rem;">
            <div style="display:flex;justify-content:space-between;align-items:center;padding:0.35rem 0.55rem;border:1px solid rgba(255,255,255,0.08);border-radius:8px;margin-bottom:0.45rem;background:rgba(255,255,255,0.02);">
              <span style="font-size:0.78rem;font-weight:700;color:var(--gold);text-transform:uppercase;letter-spacing:0.03em;">${section.label}</span>
              <span style="font-size:0.72rem;color:var(--text-dim);">${sectionPlayers.length} players</span>
            </div>
            ${sectionRows}
          </div>
        `;
      }).join('');

  document.getElementById('teamModalContent').innerHTML = html;
  document.getElementById('teamModalOverlay').classList.add('visible');
}

function closeTeamSquadModal() {
  document.getElementById('teamModalOverlay').classList.remove('visible');
}

function updateAuctionStatusBadge() {
  const statusEl = document.getElementById('auctionStatus');
  if (!statusEl) return;

  if (paused) {
    statusEl.textContent = 'PAUSED';
    statusEl.style.background = 'var(--orange)';
    statusEl.style.color = '#060B18';
  } else {
    statusEl.textContent = 'LIVE';
    statusEl.style.background = 'var(--gold-dim)';
    statusEl.style.color = 'var(--gold)';
  }

  const pauseBtn = document.getElementById('pauseBtn');
  if (pauseBtn) pauseBtn.textContent = paused ? 'Resume' : 'Pause';
}

async function togglePauseAuction() {
  if (!isHost) return;
  const actorId = myTeamId || 'host-manager';

  const controlRef = db.ref(`rooms/${roomCode}/auctionControl`);
  if (!paused) {
    await controlRef.update({ paused: true, pausedAt: getSyncedNowMs(), pausedBy: actorId });
    showToast('Auction paused', 'success');
    return;
  }

  const now = getSyncedNowMs();
  const pauseDuration = pausedAt ? (now - pausedAt) : 0;

  if (pauseDuration > 0 && !unlimitedTimer) {
    await db.ref(`rooms/${roomCode}/currentAuction`).transaction(auction => {
      if (!auction || auction.status !== 'bidding') return auction;
      auction.timerEnd = (auction.timerEnd || now) + pauseDuration;
      return auction;
    });
  }

  await controlRef.update({ paused: false, pausedAt: null, resumedAt: now, resumedBy: actorId });
  showToast('Auction resumed', 'success');
}

async function terminateAuction() {
  if (!isHost) return;
  const actorId = myTeamId || 'host-manager';
  const terminatedAt = Date.now();
  if (!confirm('Terminate auction now and show results?')) return;
  await db.ref(`rooms/${roomCode}/config`).update({ status: 'finished', terminatedAt, terminatedBy: actorId });
  await syncAuctionHistoryStatus('finished', { terminatedAt, terminatedBy: actorId, finishReason: 'terminated' });
  // NOTE: Do NOT cleanup Cloudinary here.
  // Re-auction uses the same room and still needs manual player images.
  // Cleanup is triggered when the host clicks "New Auction" from results.
}

function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'toast show ' + type;
  setTimeout(() => { t.className = 'toast'; }, 2500);
}

function copyAuctionCode() {
  if (!roomCode) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(roomCode)
      .then(() => showToast('Auction code copied!', 'success'))
      .catch(() => showToast('Failed to copy auction code.', 'error'));
    return;
  }

  // Fallback for older browsers.
  const temp = document.createElement('textarea');
  temp.value = roomCode;
  temp.style.position = 'fixed';
  temp.style.opacity = '0';
  document.body.appendChild(temp);
  temp.select();
  try {
    document.execCommand('copy');
    showToast('Auction code copied!', 'success');
  } catch (_) {
    showToast('Failed to copy auction code.', 'error');
  }
  document.body.removeChild(temp);
}

function updateSoundToggleButton() {
  const btn = document.getElementById('soundToggleBtn');
  if (!btn) return;
  btn.textContent = soundEnabled ? '🔊 Sound On' : '🔇 Sound Off';
}

function toggleSoundPack() {
  soundEnabled = !soundEnabled;
  localStorage.setItem('ipl_sound_enabled', soundEnabled ? '1' : '0');
  updateSoundToggleButton();
  showToast(soundEnabled ? 'Sound pack enabled' : 'Sound pack disabled', 'success');
}

function handleAudioEvents(data, prevData) {
  if (!soundEnabled) return;

  if (
    prevData &&
    prevData.status === 'bidding' &&
    data.status === 'bidding' &&
    data.currentBid > (prevData.currentBid || 0)
  ) {
    playBidSfx();
  }

  const resultKey = `${data.playerId}:${data.status}:${data.highestBidder || ''}:${data.currentBid || 0}`;
  if ((data.status === 'sold' || data.status === 'unsold') && lastAnnouncedResultKey !== resultKey) {
    lastAnnouncedResultKey = resultKey;

    if (data.status === 'sold') {
      playSoldSfx();
      const winner = teamsData[data.highestBidder] || getRoomTeamMeta(data.highestBidder);
      const winnerName = winner?.short || winner?.name || 'Unknown team';
      speakCallout(`Sold to ${winnerName} for ${formatPrice(data.currentBid)}`);
    } else {
      playUnsoldSfx();
      speakCallout('Unsold. No valid bids.');
    }
  }

  if (data.status === 'bidding') {
    lastAnnouncedResultKey = '';
  }
}

function playTone(frequency, duration = 0.08, type = 'sine', delayMs = 0) {
  if (!soundEnabled) return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;

    const trigger = () => {
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = type;
      osc.frequency.value = frequency;

      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.14, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + duration + 0.02);

      setTimeout(() => ctx.close(), Math.max(180, Math.ceil(duration * 1000) + 90));
    };

    if (delayMs > 0) setTimeout(trigger, delayMs);
    else trigger();
  } catch (err) {
    console.warn('Audio tone failed:', err);
  }
}

function playBidSfx() {
  playTone(760, 0.07, 'square');
  playTone(980, 0.07, 'square', 70);
}

function playTimerCountdownSfx(second) {
  const freq = second <= 2 ? 420 : 520;
  playTone(freq, 0.06, 'triangle');
}

function playSoldSfx() {
  playTone(620, 0.09, 'triangle');
  playTone(820, 0.09, 'triangle', 90);
  playTone(1040, 0.12, 'triangle', 180);
}

function playUnsoldSfx() {
  playTone(420, 0.09, 'sawtooth');
  playTone(320, 0.11, 'sawtooth', 100);
}

function speakCallout(text) {
  if (!soundEnabled || !window.speechSynthesis || !text) return;
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text.replace('₹', 'Rupees '));
    utterance.rate = 1.02;
    utterance.pitch = 1;
    utterance.volume = 1;
    window.speechSynthesis.speak(utterance);
  } catch (err) {
    console.warn('Voice callout failed:', err);
  }
}

function isWebRtcSupported() {
  if (!voiceFeatureEnabled) return false;
  return !!(
    window.isSecureContext &&
    window.RTCPeerConnection &&
    navigator.mediaDevices &&
    navigator.mediaDevices.getUserMedia
  );
}

function initVoiceSocket() {
  if (!voiceFeatureEnabled) return;
  if (voiceSocket) return;
  if (typeof io !== 'function') {
    console.error('Socket.io client not available.');
    return;
  }

  voiceSocket = io({ transports: ['websocket', 'polling'] });

  voiceSocket.on('connect', () => {
    voiceSocketConnected = true;
    if (voiceJoined) {
      const myTeam = teamsData[myTeamId] || getRoomTeamMeta(myTeamId) || {};
      voiceSocket.emit('voice:join', {
        roomCode,
        teamId: myTeamId,
        ownerName: myTeam.ownerName || playerName || 'Player',
        short: myTeam.short || myTeamId,
        isHost: !!isHost
      });
    }
  });

  voiceSocket.on('disconnect', () => {
    voiceSocketConnected = false;
    voiceParticipants = {};
    voiceHostMutedMap = {};
    isVoiceHostMuted = false;
    renderVoiceParticipants();
    updateVoiceControls();
    syncVoicePeers();
  });

  voiceSocket.on('connect_error', (err) => {
    console.error('Voice socket connect error:', err);
    voiceSocketConnected = false;
    renderVoiceParticipants();
    showToast('Voice server connection failed.', 'error');
  });

  voiceSocket.on('voice:state', (payload = {}) => {
    voiceParticipants = payload.participants || {};
    voiceHostMutedMap = payload.muted || {};
    const wasHostMuted = isVoiceHostMuted;
    isVoiceHostMuted = !!voiceHostMutedMap[myTeamId];

    applyLocalVoiceTrackState();
    updateVoiceControls();
    renderVoiceParticipants();
    syncVoicePeers();

    const badge = document.getElementById('voiceStatusBadge');
    if (badge) badge.style.display = isVoiceHostMuted ? 'inline-flex' : 'none';
    if (!wasHostMuted && isVoiceHostMuted) {
      showToast('Host muted your voice.', 'error');
    }
  });

  voiceSocket.on('voice:signal', async (payload = {}) => {
    try {
      await handleVoiceSignalPayload(payload);
    } catch (err) {
      console.error('Voice signal handling failed:', err);
    }
  });

  voiceSocket.on('voice:error', (payload = {}) => {
    if (payload.message) showToast(payload.message, 'error');
  });
}

function updateVoiceControls() {
  const joinBtn = document.getElementById('voiceJoinBtn');
  const muteBtn = document.getElementById('voiceMuteBtn');
  if (!joinBtn || !muteBtn) return;

  if (!isWebRtcSupported()) {
    joinBtn.disabled = true;
    joinBtn.textContent = 'Voice Unsupported';
    muteBtn.disabled = true;
    muteBtn.textContent = 'Mute';
    return;
  }

  joinBtn.disabled = false;
  joinBtn.textContent = voiceJoined ? 'Leave Voice' : 'Join Voice';
  joinBtn.classList.toggle('active', voiceJoined);

  muteBtn.disabled = !voiceJoined || isVoiceHostMuted;
  if (!voiceJoined) muteBtn.textContent = 'Mute';
  else if (isVoiceHostMuted) muteBtn.textContent = 'Muted by Host';
  else muteBtn.textContent = voiceMutedSelf ? 'Unmute' : 'Mute';
}

function applyLocalVoiceTrackState() {
  if (!localVoiceStream) return;
  const shouldEnable = voiceJoined && !voiceMutedSelf && !isVoiceHostMuted;
  console.log(`[Voice] Applying track state - shouldEnable: ${shouldEnable}, voiceJoined: ${voiceJoined}, voiceMutedSelf: ${voiceMutedSelf}, isVoiceHostMuted: ${isVoiceHostMuted}`);
  for (const track of localVoiceStream.getAudioTracks()) {
    console.log(`[Voice] Setting track enabled from ${track.enabled} to ${shouldEnable}`);
    track.enabled = shouldEnable;
  }
}

async function toggleVoiceJoin() {
  if (isSpectator) {
    showToast('Viewer mode: voice is disabled.', 'error');
    return;
  }
  if (voiceJoined) {
    await leaveVoiceChat();
    showToast('Left voice chat.', 'success');
    return;
  }
  if (!window.isSecureContext) {
    showToast('Voice needs HTTPS (or localhost). Open the secure site link.', 'error');
    return;
  }
  await joinVoiceChat();
}

async function joinVoiceChat() {
  if (isSpectator) return;
  if (voiceJoined) return;
  if (!isWebRtcSupported()) {
    showToast('Voice chat unsupported. Use latest Chrome/Edge on HTTPS.', 'error');
    return;
  }
  if (!voiceSocket) initVoiceSocket();

  try {
    console.log('[Voice] Requesting microphone access...');
    localVoiceStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    console.log('[Voice] Microphone access granted, tracks:', localVoiceStream.getAudioTracks().map(t => `id=${t.id}, enabled=${t.enabled}, readyState=${t.readyState}`));
    
    voiceJoined = true;
    voiceMutedSelf = false;

    const myTeam = teamsData[myTeamId] || getRoomTeamMeta(myTeamId) || {};
    if (voiceSocket && voiceSocketConnected) {
      console.log('[Voice] Emitting voice:join to server');
      voiceSocket.emit('voice:join', {
        roomCode,
        teamId: myTeamId,
        ownerName: myTeam.ownerName || playerName || 'Player',
        short: myTeam.short || myTeamId,
        isHost: !!isHost
      });
    } else {
      console.warn('[Voice] Voice socket not connected, will join when connected');
    }

    applyLocalVoiceTrackState();
    updateVoiceControls();
    renderVoiceParticipants();
    syncVoicePeers();
    showToast('Voice chat connected.', 'success');
  } catch (err) {
    console.error('Join voice failed:', err);
    if (err && err.name === 'NotAllowedError') {
      showToast('Microphone permission denied. Allow mic access and try again.', 'error');
    } else if (err && err.name === 'NotFoundError') {
      showToast('No microphone device found on this system.', 'error');
    } else if (err && err.name === 'NotReadableError') {
      showToast('Microphone is busy in another app. Close it and retry.', 'error');
    } else {
      showToast('Unable to access microphone. Please retry.', 'error');
    }
    voiceJoined = false;
    if (localVoiceStream) {
      localVoiceStream.getTracks().forEach(track => track.stop());
      localVoiceStream = null;
    }
    updateVoiceControls();
  }
}

async function leaveVoiceChat() {
  if (voiceJoined && voiceSocket && voiceSocketConnected) {
    try {
      voiceSocket.emit('voice:leave', { roomCode, teamId: myTeamId });
    } catch (_) {}
  }

  voiceJoined = false;
  voiceMutedSelf = false;

  if (localVoiceStream) {
    localVoiceStream.getTracks().forEach(track => track.stop());
    localVoiceStream = null;
  }

  Object.keys(voicePeerState).forEach(detachVoicePeer);
  updateVoiceControls();
  renderVoiceParticipants();
}

function syncVoicePeers() {
  if (!voiceJoined) {
    Object.keys(voicePeerState).forEach(detachVoicePeer);
    return;
  }

  const activeRemoteIds = Object.keys(voiceParticipants || {}).filter(teamId => teamId !== myTeamId);
  const activeSet = new Set(activeRemoteIds);

  Object.keys(voicePeerState).forEach(teamId => {
    if (!activeSet.has(teamId)) detachVoicePeer(teamId);
  });

  activeRemoteIds.forEach(teamId => {
    const state = ensureVoicePeer(teamId);
    if (!state) return;
    if (myTeamId < teamId && !state.offerSent && state.pc.signalingState === 'stable') {
      state.offerSent = true;
      makeVoiceOffer(teamId).catch(err => {
        console.error('Voice offer failed:', err);
        state.offerSent = false;
      });
    }
  });
}

function ensureVoicePeer(remoteTeamId) {
  if (!voiceJoined || !remoteTeamId || remoteTeamId === myTeamId) return null;
  if (voicePeerState[remoteTeamId]) return voicePeerState[remoteTeamId];

  const pc = new RTCPeerConnection(voiceRtcConfig);
  const state = {
    pc,
    remoteStream: null,
    audioEl: null,
    offerSent: false,
    pendingCandidates: [],
    senders: []
  };
  voicePeerState[remoteTeamId] = state;

  if (localVoiceStream) {
    // Ensure tracks are in the correct enabled state before adding
    const shouldEnable = voiceJoined && !voiceMutedSelf && !isVoiceHostMuted;
    localVoiceStream.getAudioTracks().forEach(track => {
      console.log(`[Voice] Adding track to peer ${remoteTeamId}, enabled: ${track.enabled}, shouldEnable: ${shouldEnable}`);
      track.enabled = shouldEnable;
      const sender = pc.addTrack(track, localVoiceStream);
      state.senders.push(sender);
    });
  }

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendVoiceSignal(remoteTeamId, { candidate: event.candidate.toJSON() });
    }
  };

  pc.ontrack = (event) => {
    const stream = event.streams && event.streams[0] ? event.streams[0] : null;
    if (!stream) return;
    state.remoteStream = stream;
    attachRemoteVoiceAudio(remoteTeamId, stream);
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    console.log(`[Voice] Peer ${remoteTeamId} connection state: ${s}`);
    if (s === 'failed' || s === 'closed' || s === 'disconnected') {
      detachVoicePeer(remoteTeamId);
    }
  };

  return state;
}

async function makeVoiceOffer(remoteTeamId) {
  const state = ensureVoicePeer(remoteTeamId);
  if (!state) return;

  console.log(`[Voice] Creating offer for peer ${remoteTeamId}`);
  const offer = await state.pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false });
  await state.pc.setLocalDescription(offer);
  console.log(`[Voice] Sending offer to peer ${remoteTeamId}`);
  await sendVoiceSignal(remoteTeamId, { description: state.pc.localDescription });
}

async function sendVoiceSignal(targetTeamId, payload) {
  if (!targetTeamId || targetTeamId === myTeamId) return;
  if (!voiceSocket || !voiceSocketConnected) {
    console.warn('[Voice] Cannot send signal, socket not connected');
    return;
  }
  console.log(`[Voice] Sending signal to ${targetTeamId}:`, payload.description ? payload.description.type : payload.candidate ? 'ICE candidate' : 'unknown');
  voiceSocket.emit('voice:signal', {
    roomCode,
    targetTeamId,
    ...payload
  });
}

async function handleVoiceSignalPayload(payload) {
  if (!payload || !voiceJoined) return;
  const fromTeamId = payload.fromTeamId;
  if (!fromTeamId || fromTeamId === myTeamId) return;

  console.log(`[Voice] Received signal from ${fromTeamId}:`, payload.description ? payload.description.type : payload.candidate ? 'ICE candidate' : 'unknown');

  const state = ensureVoicePeer(fromTeamId);
  if (!state) return;

  if (payload.description) {
    const remoteDesc = new RTCSessionDescription(payload.description);
    if (remoteDesc.type === 'offer') {
      console.log(`[Voice] Processing offer from ${fromTeamId}`);
      await state.pc.setRemoteDescription(remoteDesc);
      while (state.pendingCandidates.length) {
        const cand = state.pendingCandidates.shift();
        await state.pc.addIceCandidate(cand);
      }
      const answer = await state.pc.createAnswer();
      await state.pc.setLocalDescription(answer);
      console.log(`[Voice] Sending answer to ${fromTeamId}`);
      await sendVoiceSignal(fromTeamId, { description: state.pc.localDescription });
      return;
    }

    if (remoteDesc.type === 'answer') {
      console.log(`[Voice] Processing answer from ${fromTeamId}`);
      await state.pc.setRemoteDescription(remoteDesc);
      while (state.pendingCandidates.length) {
        const cand = state.pendingCandidates.shift();
        await state.pc.addIceCandidate(cand);
      }
      return;
    }
  }

  if (payload.candidate) {
    const ice = new RTCIceCandidate(payload.candidate);
    if (!state.pc.remoteDescription) {
      state.pendingCandidates.push(ice);
      return;
    }
    try {
      await state.pc.addIceCandidate(ice);
    } catch (err) {
      console.warn('Add ICE candidate failed:', err);
    }
  }
}

function attachRemoteVoiceAudio(remoteTeamId, stream) {
  const state = voicePeerState[remoteTeamId];
  if (!state) return;
  if (state.audioEl) {
    state.audioEl.srcObject = stream;
    state.audioEl.play().catch(() => {});
    return;
  }

  const audio = document.createElement('audio');
  audio.autoplay = true;
  audio.playsInline = true;
  audio.srcObject = stream;
  audio.dataset.remoteTeamId = remoteTeamId;
  audio.style.display = 'none';
  document.body.appendChild(audio);
  state.audioEl = audio;
  audio.play().catch(() => {});
}

function detachVoicePeer(remoteTeamId) {
  const state = voicePeerState[remoteTeamId];
  if (!state) return;
  try { state.pc.close(); } catch (_) {}
  if (state.audioEl) {
    try {
      state.audioEl.srcObject = null;
      state.audioEl.remove();
    } catch (_) {}
  }
  delete voicePeerState[remoteTeamId];
}

function renderVoiceParticipants() {
  const listEl = document.getElementById('voiceParticipantList');
  const countEl = document.getElementById('voiceRoomCount');
  if (!listEl) return;

  const mergedParticipants = { ...(voiceParticipants || {}) };
  if (voiceJoined && myTeamId && !mergedParticipants[myTeamId]) {
    const myTeam = teamsData[myTeamId] || getRoomTeamMeta(myTeamId) || {};
    mergedParticipants[myTeamId] = {
      teamId: myTeamId,
      ownerName: myTeam.ownerName || playerName || 'You',
      short: myTeam.short || myTeamId,
      joinedAt: Date.now(),
      isHost: !!isHost,
      localOnly: true
    };
  }

  const participants = Object.entries(mergedParticipants).sort((a, b) => (a[1]?.joinedAt || 0) - (b[1]?.joinedAt || 0));
  if (countEl) countEl.textContent = `${participants.length} live`;
  if (!participants.length) {
    listEl.innerHTML = '<div class="chat-empty">No one in voice room.</div>';
    return;
  }

  listEl.innerHTML = participants.map(([teamId, info]) => {
    const team = teamsData[teamId] || getRoomTeamMeta(teamId) || {};
    const short = team.short || info.short || teamId;
    const owner = team.ownerName || info.ownerName || 'Player';
    const isMe = teamId === myTeamId;
    const isMuted = !!voiceHostMutedMap[teamId];
    const hostAction = isHost && !isMe
      ? `<button class="voice-host-btn" onclick="toggleHostVoiceMute('${teamId}')">${isMuted ? 'Unmute' : 'Mute'}</button>`
      : '';

    return `
      <div class="voice-row ${isMe ? 'mine' : ''}">
        <div class="voice-row-main">
          <span class="voice-team">${escapeHtml(short)}</span>
          <span class="voice-owner">${escapeHtml(owner)}</span>
          ${isMuted ? '<span class="chat-muted-pill">Muted</span>' : '<span class="voice-live-pill">Live</span>'}
        </div>
        ${hostAction}
      </div>
    `;
  }).join('');
}

async function toggleVoiceMute() {
  if (!voiceJoined) {
    showToast('Join voice first.', 'error');
    return;
  }
  if (isVoiceHostMuted) {
    showToast('Host muted your voice.', 'error');
    return;
  }

  voiceMutedSelf = !voiceMutedSelf;
  applyLocalVoiceTrackState();
  updateVoiceControls();
  showToast(voiceMutedSelf ? 'Microphone muted.' : 'Microphone unmuted.', 'success');
}

async function toggleHostVoiceMute(teamId) {
  if (!isHost || !teamId || teamId === myTeamId) return;
  try {
    if (!voiceSocket || !voiceSocketConnected) {
      showToast('Voice signaling disconnected.', 'error');
      return;
    }
    const muted = !voiceHostMutedMap[teamId];
    voiceSocket.emit('voice:host-mute', { roomCode, targetTeamId: teamId, muted });
    showToast(muted ? 'Voice muted for player.' : 'Voice unmuted for player.', 'success');
  } catch (err) {
    console.error('Host voice mute update failed:', err);
    showToast('Failed to update voice mute.', 'error');
  }
}

function initChatPopup() {
  const popup = document.getElementById('chatPopup');
  const handle = document.getElementById('chatPopupDragHandle');
  if (!popup || !handle || popup.dataset.ready === '1') return;

  popup.dataset.ready = '1';

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    
    // Skip drag if clicking on action buttons like close
    if (event.target.closest('.chat-popup-actions')) return;
    
    chatPopupDragState.dragging = true;
    chatPopupDragState.pointerId = event.pointerId;

    const rect = popup.getBoundingClientRect();
    chatPopupDragState.offsetX = event.clientX - rect.left;
    chatPopupDragState.offsetY = event.clientY - rect.top;

    popup.style.left = `${rect.left}px`;
    popup.style.top = `${rect.top}px`;
    popup.style.right = 'auto';
    popup.style.bottom = 'auto';
    popup.classList.add('dragging');

    handle.setPointerCapture(event.pointerId);
  });

  handle.addEventListener('pointermove', (event) => {
    if (!chatPopupDragState.dragging || chatPopupDragState.pointerId !== event.pointerId) return;
    event.preventDefault();

    const margin = 8;
    const nextLeftRaw = event.clientX - chatPopupDragState.offsetX;
    const nextTopRaw = event.clientY - chatPopupDragState.offsetY;
    const maxLeft = Math.max(margin, window.innerWidth - popup.offsetWidth - margin);
    const maxTop = Math.max(margin, window.innerHeight - popup.offsetHeight - margin);
    const nextLeft = Math.min(Math.max(nextLeftRaw, margin), maxLeft);
    const nextTop = Math.min(Math.max(nextTopRaw, margin), maxTop);

    popup.style.left = `${nextLeft}px`;
    popup.style.top = `${nextTop}px`;
  });

  const releaseDrag = (event) => {
    if (!chatPopupDragState.dragging) return;
    if (chatPopupDragState.pointerId !== null && event.pointerId !== chatPopupDragState.pointerId) return;

    chatPopupDragState.dragging = false;
    chatPopupDragState.pointerId = null;
    popup.classList.remove('dragging');
    try { handle.releasePointerCapture(event.pointerId); } catch (_) {}
  };

  handle.addEventListener('pointerup', releaseDrag);
  handle.addEventListener('pointercancel', releaseDrag);

  // Mobile/tablet: keep chat visible by default. Desktop starts closed.
  toggleChatPopup(window.innerWidth <= 1050);
}

function toggleChatPopup(forceState) {
  const popup = document.getElementById('chatPopup');
  const btn = document.getElementById('chatToggleBtn');
  if (!popup || !btn) return;

  const shouldOpen = typeof forceState === 'boolean'
    ? forceState
    : !popup.classList.contains('open');

  popup.classList.toggle('open', shouldOpen);
  btn.textContent = shouldOpen ? 'Chat On' : 'Chat';
  btn.classList.toggle('active', shouldOpen);

  if (shouldOpen) {
    const messages = document.getElementById('chatMessages');
    if (messages) messages.scrollTop = messages.scrollHeight;
  }
}

function updateChatMuteState() {
  const input = document.getElementById('chatInput');
  const sendBtn = document.getElementById('chatSendBtn');
  const badge = document.getElementById('chatMuteBadge');
  const quickButtons = document.querySelectorAll('.chat-quick-btn');

  if (input) input.disabled = isChatMuted;
  if (sendBtn) sendBtn.disabled = isChatMuted;
  quickButtons.forEach(btn => { btn.disabled = isChatMuted; });
  if (badge) badge.style.display = isChatMuted ? 'inline-flex' : 'none';
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatChatTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function renderChatMessages() {
  const el = document.getElementById('chatMessages');
  if (!el) return;

  const rows = Object.values(chatMessages || {}).sort((a, b) => (a?.at || 0) - (b?.at || 0));
  const visibleRows = rows.slice(-80);

  if (!visibleRows.length) {
    el.innerHTML = '<div class="chat-empty">No messages yet. Start the banter.</div>';
    return;
  }

  el.innerHTML = visibleRows.map(msg => {
    const senderTeam = msg.senderTeamId;
    const team = teamsData[senderTeam] || getRoomTeamMeta(senderTeam) || {};
    const short = team.short || msg.senderShort || senderTeam || 'TEAM';
    const owner = team.ownerName || msg.senderName || 'Unknown';
    const isMine = senderTeam === myTeamId;
    const isMuted = !!chatMutedMap[senderTeam];
    const hostControls = isHost && !isMine
      ? `<div class="chat-host-actions">
          <button onclick="toggleMuteTeam('${senderTeam}')">${isMuted ? 'Unmute' : 'Mute'}</button>
          <button onclick="kickTeamFromChat('${senderTeam}')">Kick</button>
        </div>`
      : '';

    return `
      <div class="chat-msg ${isMine ? 'mine' : ''}">
        <div class="chat-msg-head">
          <span class="chat-team">${escapeHtml(short)}</span>
          <span class="chat-owner">${escapeHtml(owner)}</span>
          ${isMuted ? '<span class="chat-muted-pill">Muted</span>' : ''}
          <span class="chat-time">${formatChatTime(msg.at)}</span>
        </div>
        <div class="chat-msg-text">${escapeHtml(msg.text)}</div>
        ${hostControls}
      </div>
    `;
  }).join('');

  el.scrollTop = el.scrollHeight;
}

async function sendChatMessage(presetText = '', options = {}) {
  if (isSpectator && !isHostManager) {
    showToast('Viewer mode: chat is disabled.', 'error');
    return false;
  }
  if (isChatMuted) {
    showToast('You are muted by host.', 'error');
    return false;
  }

  const input = document.getElementById('chatInput');
  const text = String(presetText || '').trim() || (input ? input.value.trim() : '');
  if (!text) return false;

  const now = Date.now();
  if (now - lastChatSentAt < 700) {
    showToast('Please slow down.', 'error');
    return false;
  }
  lastChatSentAt = now;

  const myTeam = teamsData[myTeamId] || getRoomTeamMeta(myTeamId) || {};

  try {
    await db.ref(`rooms/${roomCode}/chat/messages`).push({
      senderTeamId: myTeamId,
      senderShort: myTeam.short || myTeamId,
      senderName: myTeam.ownerName || playerName,
      text,
      quick: !!options.quick,
      at: now
    });
    if (input) input.value = '';
    return true;
  } catch (err) {
    console.error('Send chat failed:', err);
    showToast('Failed to send message.', 'error');
    return false;
  }
}

function handleIncomingQuickChatEffects(messageMap) {
  const entries = Object.entries(messageMap || {}).sort((a, b) => (a[1]?.at || 0) - (b[1]?.at || 0));

  if (!chatEffectsReady) {
    seenChatMessageIds = {};
    entries.forEach(([id]) => {
      seenChatMessageIds[id] = true;
    });
    chatEffectsReady = true;
    return;
  }

  const incomingQuick = [];
  entries.forEach(([id, msg]) => {
    if (seenChatMessageIds[id]) return;
    seenChatMessageIds[id] = true;
    if (msg?.quick && msg.senderTeamId !== myTeamId && msg.text) {
      incomingQuick.push(msg);
    }
  });

  // Prevent unbounded growth when chat rolls forward.
  const latestIds = new Set(entries.map(([id]) => id));
  Object.keys(seenChatMessageIds).forEach((id) => {
    if (!latestIds.has(id)) delete seenChatMessageIds[id];
  });

  incomingQuick.slice(-4).forEach((msg, idx) => {
    setTimeout(() => animateQuickChatPulse(msg.text, null, { incoming: true }), idx * 220);
  });
}

function animateQuickChatPulse(message, sourceBtn = null, options = {}) {
  const layer = document.getElementById('quickChatFxLayer');
  if (!layer) return;
  const isIncoming = !!options.incoming;

  const pulse = document.createElement('div');
  pulse.className = `quick-chat-fx-bubble${isIncoming ? ' incoming' : ''}`;
  pulse.textContent = message;

  const burst = document.createElement('div');
  burst.className = `quick-chat-fx-burst${isIncoming ? ' incoming' : ''}`;

  for (let i = 0; i < 4; i += 1) {
    const spark = document.createElement('span');
    spark.className = 'quick-chat-fx-spark';
    spark.style.setProperty('--spark-angle', `${(360 / 4) * i}deg`);
    burst.appendChild(spark);
  }

  const rect = sourceBtn?.getBoundingClientRect?.();
  let x = window.innerWidth / 2;
  let y = 116;

  if (rect) {
    x = rect.left + rect.width / 2;
    y = rect.top - 8;
  } else if (isIncoming) {
    x = (window.innerWidth / 2) + ((Math.random() * 44) - 22);
    y = 132;
  }

  const clampedX = Math.max(40, Math.min(window.innerWidth - 40, x));
  const clampedY = Math.max(80, y);

  pulse.style.left = `${clampedX}px`;
  pulse.style.top = `${Math.max(80, y)}px`;
  burst.style.left = `${clampedX}px`;
  burst.style.top = `${clampedY}px`;

  layer.appendChild(burst);
  layer.appendChild(pulse);

  const cleanup = () => pulse.remove();
  const cleanupBurst = () => burst.remove();
  pulse.addEventListener('animationend', cleanup, { once: true });
  burst.addEventListener('animationend', cleanupBurst, { once: true });
}

async function toggleMuteTeam(teamId) {
  if (!isHost || !teamId || teamId === myTeamId) return;
  const ref = db.ref(`rooms/${roomCode}/chat/muted/${teamId}`);
  try {
    if (chatMutedMap[teamId]) {
      await ref.remove();
      showToast('Team unmuted.', 'success');
    } else {
      await ref.set(true);
      showToast('Team muted.', 'success');
    }
  } catch (err) {
    console.error('Toggle mute failed:', err);
    showToast('Failed to update mute state.', 'error');
  }
}

async function kickTeamFromChat(teamId) {
  if (!isHost || !teamId || teamId === myTeamId) return;
  await removeTeamFromAuction(teamId);
}

function updateMyPurse() {
  const el = document.getElementById('myPurseDisplay');
  if (!el) return;

  if (isBidUiSpectator()) {
    el.textContent = 'Viewer';
    return;
  }

  ensureHostProxyBidTeamSelected();
  const actingTeamId = getActingTeamIdForBidUi();
  const actingTeam = actingTeamId ? teamsData[actingTeamId] : null;
  if (!actingTeam) {
    el.textContent = isHostProxyBidderActive() ? 'Select Team' : '—';
    return;
  }

  el.textContent = formatPrice(actingTeam.purse);
}

function updateProgressBar() {
  const total = playerQueue.length;
  const done = currentIndex;
  document.getElementById('progressText').textContent = `Player ${done + 1}/${total}`;
  document.getElementById('progressBar').style.width = total > 0 ? `${(done / total) * 100}%` : '0%';
}

// ---- RESULT BANNER ----
function showResultBanner(type, word, detail) {
  const overlay = document.getElementById('resultOverlay');
  const banner = document.getElementById('resultBanner');
  const wordEl = document.getElementById('resultWord');
  const detailEl = document.getElementById('resultDetail');

  banner.className = `result-banner ${type}`;
  wordEl.textContent = word;
  detailEl.textContent = detail;
  overlay.classList.add('visible');

  banner.classList.remove('animate-in');
  void banner.offsetWidth;
  banner.classList.add('animate-in');

  window.clearTimeout(window.resultBannerHideTimer);
  window.resultBannerHideTimer = window.setTimeout(() => {
    overlay.classList.remove('visible');
    banner.classList.remove('animate-in');
  }, 2600);
}

function hideResultBanner() {
  const overlay = document.getElementById('resultOverlay');
  const banner = document.getElementById('resultBanner');
  if (overlay) overlay.classList.remove('visible');
  if (banner) banner.classList.remove('animate-in');
  window.clearTimeout(window.resultBannerHideTimer);
}

// ---- CLEANUP ----
window.addEventListener('beforeunload', () => {
  detachSpectatorPollListener();
  removeSpectatorPresence();
  if (isHost && hostPresenceRef) {
    try { hostPresenceRef.remove(); } catch (_) {}
  }
  if (voiceFeatureEnabled) leaveVoiceChat();
  if (voiceSocket) {
    try { voiceSocket.disconnect(); } catch (_) {}
    voiceSocket = null;
    voiceSocketConnected = false;
  }
  clearInterval(timerInterval);
  db.ref(`rooms/${roomCode}/teams`).off('value', listeners.teams);
  db.ref(`rooms/${roomCode}/soldPlayers`).off('value', listeners.soldPlayers);
  db.ref(`rooms/${roomCode}/auctionControl`).off('value', listeners.pause);
  db.ref(`rooms/${roomCode}/currentAuction`).off('value', listeners.auction);
  db.ref(`rooms/${roomCode}/currentIndex`).off('value', listeners.index);
  db.ref(`rooms/${roomCode}/config/status`).off('value', listeners.status);
  if (listeners.currentHostUid) {
    db.ref(`rooms/${roomCode}/config/currentHostUid`).off('value', listeners.currentHostUid);
  }
  if (listeners.hostPresence) {
    db.ref(`rooms/${roomCode}/hostPresence`).off('value', listeners.hostPresence);
  }
  if (listeners.spectatorCount) {
    db.ref(`rooms/${roomCode}/spectators`).off('value', listeners.spectatorCount);
  }
  if (listeners.spectatorConnected) {
    db.ref('.info/connected').off('value', listeners.spectatorConnected);
  }
  unregisterHostPresenceListener();
  if (!isSpectator && listeners.watchlist) {
    db.ref(`rooms/${roomCode}/watchlists/${myTeamId}`).off('value', listeners.watchlist);
  }
  db.ref(`rooms/${roomCode}/chat/messages`).off('value', listeners.chatMessages);
  db.ref(`rooms/${roomCode}/chat/muted`).off('value', listeners.chatMutedMap);
  if (!isSpectator && listeners.chatMuted) {
    db.ref(`rooms/${roomCode}/chat/muted/${myTeamId}`).off('value', listeners.chatMuted);
  }
  db.ref('.info/serverTimeOffset').off('value', listeners.serverTimeOffset);
});

// Broadcast Mode: All Teams Modal
window.openAllTeamsModal = function() {
  const modal = document.getElementById('allTeamsModalOverlay');
  const content = document.getElementById('allTeamsModalContent');
  if (!modal || !content) return;

  const teamIds = Object.keys(teamsData || {});
  if (teamIds.length === 0) {
    content.innerHTML = '<div style="color:var(--text-sec);padding:2rem;">No teams joined yet.</div>';
    modal.classList.add('visible');
    return;
  }

  content.innerHTML = teamIds.map(tId => {
    const team = teamsData[tId];
    const meta = getRoomTeamMeta(tId) || {};
    const short = meta.short || team.short || team.name || tId;
    const owner = team.ownerName || 'Unknown owner';
    const logo = meta.logo
      ? `<img src="${meta.logo}" alt="${short} logo" class="sidebar-team-logo" loading="lazy" decoding="async" />`
      : '';
    const squadCount = normalizeTeamSquadEntries(team).length;
    const minPlayers = Number(team.minPlayers) > 0 ? Number(team.minPlayers) : 0;
    const purseText = formatPrice(team.purse);
    
    return `
      <button class="broadcast-team-list-card" onclick="closeAllTeamsModal(); showTeamSquad('${tId}')">
        <div class="team-row-top">
          <span class="team-short-badge">${short}</span>
          ${logo}
          <span class="team-owner-name">${owner}</span>
        </div>
        <div class="team-row-bottom">
          <span class="team-stat">💰 <span>${purseText}</span></span>
          <span class="team-stat">🏃 <span>${squadCount}/25 players</span></span>
        </div>
        <span class="team-min-note">min ${minPlayers} required</span>
      </button>
    `;
  }).join('');

  modal.classList.add('visible');
};

window.closeAllTeamsModal = function() {
  const modal = document.getElementById('allTeamsModalOverlay');
  if (modal) modal.classList.remove('visible');
};

window.openTeamSquadModal = function(teamId) {
  showTeamSquad(teamId);
};

window.openLivePlayerListModal = openLivePlayerListModal;
window.closeLivePlayerListModal = closeLivePlayerListModal;
window.showTeamSquad = showTeamSquad;


