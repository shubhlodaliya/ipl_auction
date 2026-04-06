// ============================================================
// AUCTION.JS — Core real-time bidding engine
// ============================================================

const session = requireSession();
if (!session) throw new Error('No session');

const { roomCode, teamId: myTeamId, playerName, isHost } = session;

let roomConfig = null;
let allPlayers = [];
let playerMap = {};
let currentAuctionData = null;
let playerQueue = [];
let currentIndex = 0;
let timerInterval = null;
let timerSeconds = 30;
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
let voiceParticipants = {};
let voiceHostMutedMap = {};
let isVoiceHostMuted = false;
let voiceJoined = false;
let voiceMutedSelf = false;
let localVoiceStream = null;
let voicePeerState = {};
let soundEnabled = true;
let lastTimerSoundSecond = -1;
let lastAnnouncedResultKey = '';
let cleanupRequested = false;
let magneticPointerEnabled = false;
let activeMagneticButton = null;
let autoWithdrawInFlightForPlayerId = null;
let chatPopupDragState = { dragging: false, pointerId: null, offsetX: 0, offsetY: 0 };
const avatarBorderVariantClass = 'border-bold';
const voiceFeatureEnabled = true;
const voiceRtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// ---- Firebase listeners ----
let listeners = {};

function getRoomTeamMeta(teamId) {
  return roomTeamCatalog[teamId] || teamsData[teamId] || getTeam(teamId);
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
  isManualAuction = roomConfig.auctionType === 'manual';
  roomTeamCatalog = isManualAuction
    ? (room.manualTeams || {})
    : Object.fromEntries(IPL_TEAMS.map(t => [t.id, t]));
  timerSeconds = roomConfig.timerSeconds || 30;

  // Load players
  allPlayers = isManualAuction ? (room.manualPlayers || []) : await loadPlayers();
  allPlayers.forEach(p => { playerMap[p.id] = p; });

  // Show my team chip
  const me = getRoomTeamMeta(myTeamId);
  if (me) {
    const chip = document.getElementById('myTeamChip');
    chip.style.display = 'flex';
    chip.innerHTML = `${me.logo ? `<img class="chip-team-logo" src="${me.logo}" alt="${me.short} logo" />` : ''} ${me.short}`;
    if (me.primary) {
      chip.style.borderColor = me.primary + '60';
      chip.style.color = me.primary;
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

  // Listen to teams (sidebar)
  listeners.teams = db.ref(`rooms/${roomCode}/teams`).on('value', snap => {
    teamsData = snap.val() || {};

    // If this client's team no longer exists, the host removed them.
    if (!teamsData[myTeamId]) {
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
    if (isHost) hostEvaluateFastPath(currentAuctionData);
  });

  listeners.watchlist = db.ref(`rooms/${roomCode}/watchlists/${myTeamId}`).on('value', snap => {
    watchlistForMe = snap.val() || {};
    if (currentAuctionData && currentAuctionData.playerId) {
      const currentPlayer = playerMap[currentAuctionData.playerId];
      if (currentPlayer) renderPlayerSpotlight(currentPlayer);
    }
  });

  listeners.chatMessages = db.ref(`rooms/${roomCode}/chat/messages`).limitToLast(80).on('value', snap => {
    chatMessages = snap.val() || {};
    renderChatMessages();
  });

  listeners.chatMutedMap = db.ref(`rooms/${roomCode}/chat/muted`).on('value', snap => {
    chatMutedMap = snap.val() || {};
    renderChatMessages();
  });

  listeners.chatMuted = db.ref(`rooms/${roomCode}/chat/muted/${myTeamId}`).on('value', snap => {
    isChatMuted = !!snap.val();
    updateChatMuteState();
  });

  if (voiceFeatureEnabled) {
    listeners.voiceParticipants = db.ref(`rooms/${roomCode}/voice/participants`).on('value', snap => {
      voiceParticipants = snap.val() || {};
      renderVoiceParticipants();
      syncVoicePeers();
    });

    listeners.voiceHostMutedMap = db.ref(`rooms/${roomCode}/voice/muted`).on('value', snap => {
      voiceHostMutedMap = snap.val() || {};
      renderVoiceParticipants();
    });

    listeners.voiceHostMuted = db.ref(`rooms/${roomCode}/voice/muted/${myTeamId}`).on('value', snap => {
      isVoiceHostMuted = !!snap.val();
      applyLocalVoiceTrackState();
      updateVoiceControls();
      const badge = document.getElementById('voiceStatusBadge');
      if (badge) badge.style.display = isVoiceHostMuted ? 'inline-flex' : 'none';
      if (isVoiceHostMuted) {
        showToast('Host muted your voice.', 'error');
      }
    });

    listeners.voiceSignals = db.ref(`rooms/${roomCode}/voice/signals/${myTeamId}`).on('child_added', async snap => {
      try {
        const payload = snap.val() || {};
        await handleVoiceSignalPayload(payload);
      } catch (err) {
        console.error('Voice signal handling failed:', err);
      } finally {
        snap.ref.remove().catch(() => {});
      }
    });

    updateVoiceControls();
    renderVoiceParticipants();
  }

  // Listen to room status (finished → results)
  listeners.status = db.ref(`rooms/${roomCode}/config/status`).on('value', snap => {
    if (snap.val() === 'finished') {
      if (voiceFeatureEnabled) leaveVoiceChat();
      requestCloudinaryCleanup();
      setTimeout(() => { window.location.href = 'results.html'; }, 2000);
    }
  });

  // Start local timer tick
  timerInterval = setInterval(timerTick, 500);
}

// ---- RENDER AUCTION STATE ----
function renderAuction(data, prevData = null) {
  if (!data) return;
  const player = playerMap[data.playerId];
  if (!player) return;

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
  const manualPlayer = isManualAuction || String(player.country || '').toLowerCase() === 'manual';
  const categoryText = String(player.category || '').trim();
  const roleText = String(player.role || '').trim();
  const showCategory = !!categoryText && categoryText.toLowerCase() !== roleText.toLowerCase();
  const extraFields = player.extraFields && typeof player.extraFields === 'object' ? player.extraFields : {};
  const extraFieldChips = Object.entries(extraFields)
    .filter(([, value]) => String(value || '').trim())
    .map(([key, value]) => {
      const label = String(key || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      const safeVal = String(value || '').trim();
      return `<span class="badge badge-extra-field">${label}: ${safeVal}</span>`;
    }).join('');
  const avatarInner = player.photo_url
    ? `<img src="${player.photo_url}" alt="${player.name}" />`
    : initials;

  document.getElementById('playerSpotlight').innerHTML = `
    <div class="player-avatar pulse-ring ${avatarBorderVariantClass}" style="background: linear-gradient(135deg, ${color}99, ${color}44);">
      ${avatarInner}
    </div>
    <div class="player-info-card">
      <h2 class="player-name">${player.name}</h2>
      <div class="player-badges">
        <span class="badge badge-role">${icon} ${player.role}</span>
        ${manualPlayer ? (player.age ? `<span class="badge badge-country">Age ${player.age}</span>` : '') : `<span class="badge badge-country">${flag} ${player.country}${ageText}</span>`}
        ${showCategory ? `<span class="badge badge-category-${player.category}">${player.category}</span>` : ''}
      </div>
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
      chipEl.innerHTML = `${t?.logo ? `<img class="chip-team-logo" src="${t.logo}" alt="${t.short} logo" />` : ''} ${team?.name || data.highestBidder}`;
    }

    if (playerBidTeamTileEl) {
      playerBidTeamTileEl.style.display = 'block';
      playerBidTeamTileEl.style.borderColor = accent + '66';
      playerBidTeamTileEl.style.boxShadow = `0 10px 28px ${accent}22`;
      playerBidTeamTileEl.innerHTML = `
        <div class="player-bid-team-label">CURRENT BID TEAM</div>
        <div class="player-bid-team-name" style="color:${accent};">
          ${t?.logo ? `<img class="player-bid-team-logo" src="${t.logo}" alt="${t.short} logo" />` : ''}
          <span>${team?.name || data.highestBidder}</span>
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
  const passBtn = document.getElementById('passBtn');
  const skipPoolBtn = document.getElementById('skipPoolBtn');
  const warnEl = document.getElementById('noPurseWarn');
  const bidPanelEl = document.querySelector('.bid-panel');

  if (data.status === 'bidding') {
    const bidJumps = getBidJumpOptions(resolvedPlayer.base_price_lakh, roomConfig.bidOptions);
    const myTeam = teamsData[myTeamId];
    const withdrawn = !!(data.withdrawnTeams && data.withdrawnTeams[myTeamId]);
    const withdrawnTeamIds = Object.keys(data.withdrawnTeams || {});
    const skipVoted = !!(data.skipVotes && data.skipVotes[myTeamId]);
    const poolSkipVoted = !!(data.poolSkipVotes && data.poolSkipVotes[myTeamId]);
    const totalTeams = Object.keys(teamsData).length;
    const skipCount = Object.keys(data.skipVotes || {}).length;
    const poolSkipCount = Object.keys(data.poolSkipVotes || {}).length;
    const currentPool = getCurrentPoolMeta();
    const canSkipPool = !!currentPool?.poolId;
    const affordableJumps = bidJumps.filter(j => myTeam && (myTeam.purse >= data.currentBid + j));
    const canAffordAny = affordableJumps.length > 0;
    const canAffordBase = !!(myTeam && myTeam.purse >= data.currentBid);
    const isLeading = data.highestBidder === myTeamId;
    const squadFull = myTeam && myTeam.squad && myTeam.squad.length >= roomConfig.maxSquadSize;

    if (squadFull) {
      autoWithdrawFromCurrentPlayerIfNeeded(data);
    }

    const canTryBid = !paused && !withdrawn && !isLeading && !squadFull;
    const canBaseBid = canTryBid && !data.highestBidder && canAffordBase;

    if (baseBidBtn) {
      baseBidBtn.disabled = !canBaseBid;
      baseBidBtn.textContent = data.highestBidder ? 'Base Bid Locked' : `Bid at Base ${formatPrice(data.currentBid)}`;
    }

    if (quickBidRow) {
      quickBidRow.innerHTML = bidJumps.map(jump => {
        const canAffordThis = myTeam && myTeam.purse >= (data.currentBid + jump);
        const disabledAttr = (!canTryBid || !canAffordThis) ? 'disabled' : '';
        return `<button class="quick-bid-btn" onclick="placeBid(${jump})" ${disabledAttr}>+${formatPrice(jump)}</button>`;
      }).join('');
    }

    if (withdrawnTeamsWrap && withdrawnTeamsList) {
      if (withdrawnTeamIds.length) {
        withdrawnTeamsWrap.style.display = 'block';
        withdrawnTeamsList.innerHTML = withdrawnTeamIds.map((tId) => {
          const team = teamsData[tId] || getRoomTeamMeta(tId) || {};
          const short = team.short || tId;
          const logo = team.logo ? `<img src="${team.logo}" alt="${short} logo" />` : '';
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
      withdrawBtn.disabled = paused || squadFull;
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
      passBtn.disabled = paused;
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
      skipPoolBtn.disabled = paused;
      skipPoolBtn.textContent = `Skip Current Pool (${poolSkipCount}/${totalTeams})`;
    }

    if (paused) { warnEl.textContent = '⏸️ Auction is paused by host'; warnEl.style.display = 'block'; warnEl.style.color = 'var(--orange)'; }
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
    passBtn.disabled = true;
    passBtn.textContent = 'Skip Player';
    skipPoolBtn.disabled = true;
    skipPoolBtn.textContent = 'Skip Current Pool';
    warnEl.style.display = 'none';

    if (bidPanelEl) bidPanelEl.classList.remove('motion-stagger');
  }
}

async function autoWithdrawFromCurrentPlayerIfNeeded(data) {
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
  leaveVoiceChat();
  clearSession();
  window.location.href = 'index.html';
}

// ---- TIMER ----
function timerTick() {
  if (paused) {
    const freezeLeft = currentAuctionData && currentAuctionData.status === 'bidding'
      ? Math.max(0, Math.ceil((currentAuctionData.timerEnd - Date.now()) / 1000))
      : timerSeconds;
    updateTimerDisplay(freezeLeft, timerSeconds);
    return;
  }

  if (!currentAuctionData || currentAuctionData.status !== 'bidding') {
    updateTimerDisplay(0, timerSeconds);
    return;
  }

  const timeLeft = Math.max(0, Math.ceil((currentAuctionData.timerEnd - Date.now()) / 1000));
  updateTimerDisplay(timeLeft, timerSeconds);

  // Host processes round when timer hits 0
  if (timeLeft <= 0 && isHost && !processingRound) {
    processingRound = true;
    processAuctionRound();
  }
}

function updateTimerDisplay(secondsLeft, total) {
  const val = document.getElementById('timerValue');
  const ring = document.getElementById('timerRing');
  if (!val || !ring) return;

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
  if (!currentAuctionData || currentAuctionData.status !== 'bidding') return;
  if (paused) {
    showToast('Auction is paused.', 'error');
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
  const myTeam = teamsData[myTeamId];
  if (currentAuctionData.withdrawnTeams && currentAuctionData.withdrawnTeams[myTeamId]) {
    showToast('You withdrew for this player.', 'error');
    return;
  }
  if (!myTeam) return;

  if (isBaseBid && currentAuctionData.highestBidder) {
    showToast('Base bid is available only before first bid.', 'error');
    return;
  }

  const mySquadCount = (myTeam.squad || []).length;
  if (mySquadCount >= roomConfig.maxSquadSize) {
    showToast('Your squad is full. You cannot bid.', 'error');
    return;
  }

  if (myTeam.purse < nextBid) {
    showToast('You do not have enough purse for this bid.', 'error');
    return;
  }

  if (currentAuctionData.highestBidder === myTeamId) {
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
        const txnAllowedJumps = getBidJumpOptions(txnPlayer.base_price_lakh, roomConfig.bidOptions);
        if (!txnAllowedJumps.includes(jump)) return;
      }

      const txnNextBid = isBaseBid ? auction.currentBid : (auction.currentBid + jump);
      if (txnNextBid !== nextBid) return; // stale UI value, abort and let client refresh
      if (auction.withdrawnTeams && auction.withdrawnTeams[myTeamId]) return;
      auction.currentBid = txnNextBid;
      auction.highestBidder = myTeamId;
      auction.bidHistory = Array.isArray(auction.bidHistory) ? auction.bidHistory : [];
      auction.bidHistory.push({
        teamId: myTeamId,
        bid: txnNextBid,
        jump: isBaseBid ? 0 : jump,
        isBaseBid,
        ts: Date.now()
      });
      if (auction.bidHistory.length > 30) {
        auction.bidHistory = auction.bidHistory.slice(-30);
      }
      // Reset timer on each bid
      auction.timerEnd = Date.now() + timerSeconds * 1000;
      return auction;
    });
  } catch (err) {
    console.error('Bid failed:', err);
  }
}

// ---- PASS PLAYER (host only) ----
async function passPlayer() {
  if (!currentAuctionData || currentAuctionData.status !== 'bidding' || paused) return;

  const myTeam = teamsData[myTeamId];
  if (myTeam && (myTeam.squad || []).length >= roomConfig.maxSquadSize) {
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
      auction.skipVotes[myTeamId] = true;
      return auction;
    });
  } catch (err) {
    console.error('Skip vote failed:', err);
  }
}

async function skipCurrentPool() {
  if (!currentAuctionData || currentAuctionData.status !== 'bidding' || paused) return;

  const myTeam = teamsData[myTeamId];
  if (myTeam && (myTeam.squad || []).length >= roomConfig.maxSquadSize) {
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
      auction.poolSkipVotes[myTeamId] = true;
      return auction;
    });
  } catch (err) {
    console.error('Pool skip vote failed:', err);
  }
}

async function withdrawFromPlayer() {
  if (!currentAuctionData || currentAuctionData.status !== 'bidding' || paused) return;

  const myTeam = teamsData[myTeamId];
  if (myTeam && (myTeam.squad || []).length >= roomConfig.maxSquadSize) {
    showToast('Your squad is complete. No manual action needed.', 'error');
    return;
  }

  if (currentAuctionData.highestBidder === myTeamId) {
    showToast('Leading bidder cannot withdraw.', 'error');
    return;
  }

  try {
    await db.ref(`rooms/${roomCode}/currentAuction`).transaction(auction => {
      if (!auction || auction.status !== 'bidding') return;
      if (auction.highestBidder === myTeamId) return;
      auction.withdrawnTeams = auction.withdrawnTeams || {};
      auction.withdrawnTeams[myTeamId] = true;
      return auction;
    });
  } catch (err) {
    console.error('Withdraw failed:', err);
  }
}

async function hostEvaluateFastPath(data) {
  if (!isHost || paused || !data || data.status !== 'bidding' || processingRound) return;

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
    timerEnd: Date.now() + timerSeconds * 1000,
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
    await db.ref(`rooms/${roomCode}/config`).update({
      status: 'finished',
      finishedAt: Date.now(),
      finishReason: 'all-squads-complete'
    });
    return;
  }

  const nextIndex = currentIndex + 1;

  if (nextIndex >= playerQueue.length) {
    // Auction over
    await db.ref(`rooms/${roomCode}/config/status`).set('finished');
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
    timerEnd: Date.now() + timerSeconds * 1000,
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

  const rows = pool.players.map(({ playerId, index }) => {
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
    return `
      <div class="pool-player-row">
        <div class="result-player-avatar" style="background:linear-gradient(135deg,${getRoleColor(player.role)}99,${getRoleColor(player.role)}44)">${getPlayerInitials(player.name)}</div>
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
    const squadCount = (team.squad || []).length;

    return `
      <div class="sidebar-team ${isLeading ? 'leading' : ''} ${isMe ? 'mine' : ''}"
           onclick="showTeamSquad('${tId}')"
           style="--team-color:${t?.primary || '#888'}">
        <div class="team-row-top">
          <span class="team-short-badge">${t?.logo ? `<img class="sidebar-team-logo" src="${t.logo}" alt="${team.short} logo" />` : ''} ${team.short}</span>
          <span class="team-owner-name">${team.ownerName}</span>
          ${(isHost && !isMe) ? `<button class="team-remove-btn" onclick="event.stopPropagation(); removeTeamFromAuction('${tId}')" title="Remove ${team.ownerName}">Remove</button>` : ''}
          ${(isHost && isLeading) ? '<span class="leading-crown">👑</span>' : ''}
        </div>
        <div class="team-row-bottom">
          <span class="team-stat">💰 <span>${formatPrice(team.purse)}</span></span>
          <span class="team-stat">🏃 <span>${squadCount} players</span></span>
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
        auction.timerEnd = Date.now() + timerSeconds * 1000;
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
  const squadIds = team.squad || [];

  document.getElementById('teamModalTitle').innerHTML = `${t?.logo ? `<img class="chip-team-logo" src="${t.logo}" alt="${team.short} logo" />` : ''} ${team.name} Squad`;

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

  for (const pid of squadIds) {
    const p = playerMap[pid];
    if (!p) continue;
    const sectionKey = normalizeRole(p.role);
    grouped[sectionKey] = grouped[sectionKey] || [];
    grouped[sectionKey].push(pid);
  }

  for (const key of Object.keys(grouped)) {
    grouped[key].sort((a, b) => {
      const pa = playerMap[a];
      const pb = playerMap[b];
      return String(pa?.name || '').localeCompare(String(pb?.name || ''));
    });
  }

  const html = squadIds.length === 0
    ? `<div class="state-empty" style="padding:1.5rem 1rem;"><p>No players bought yet.</p></div>`
    : [...roleSections, { key: 'Others', label: 'Others' }].map(section => {
        const sectionPlayers = grouped[section.key] || [];
        if (!sectionPlayers.length) return '';

        const sectionRows = sectionPlayers.map(pid => {
          const p = playerMap[pid];
          if (!p) return '';
          const sold = soldPlayersData[pid];
          return `
            <div class="result-player-row">
              <div class="result-player-avatar" style="background:linear-gradient(135deg,${getRoleColor(p.role)}99,${getRoleColor(p.role)}44)">${getPlayerInitials(p.name)}</div>
              <div style="flex:1;">
                <div class="result-player-name">${p.name}</div>
                <div style="font-size:0.72rem;color:var(--text-dim)">${getRoleIcon(p.role)} ${p.role} · ${getCountryFlag(p.country)} ${p.country}</div>
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

  const controlRef = db.ref(`rooms/${roomCode}/auctionControl`);
  if (!paused) {
    await controlRef.update({ paused: true, pausedAt: Date.now(), pausedBy: myTeamId });
    showToast('Auction paused', 'success');
    return;
  }

  const now = Date.now();
  const pauseDuration = pausedAt ? (now - pausedAt) : 0;

  if (pauseDuration > 0) {
    await db.ref(`rooms/${roomCode}/currentAuction`).transaction(auction => {
      if (!auction || auction.status !== 'bidding') return auction;
      auction.timerEnd = (auction.timerEnd || now) + pauseDuration;
      return auction;
    });
  }

  await controlRef.update({ paused: false, pausedAt: null, resumedAt: now, resumedBy: myTeamId });
  showToast('Auction resumed', 'success');
}

async function terminateAuction() {
  if (!isHost) return;
  if (!confirm('Terminate auction now and show results?')) return;
  await db.ref(`rooms/${roomCode}/config`).update({ status: 'finished', terminatedAt: Date.now(), terminatedBy: myTeamId });
  await requestCloudinaryCleanup();
}

function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'toast show ' + type;
  setTimeout(() => { t.className = 'toast'; }, 2500);
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
  for (const track of localVoiceStream.getAudioTracks()) {
    track.enabled = shouldEnable;
  }
}

async function toggleVoiceJoin() {
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
  if (voiceJoined) return;
  if (!isWebRtcSupported()) {
    showToast('Voice chat unsupported. Use latest Chrome/Edge on HTTPS.', 'error');
    return;
  }

  try {
    localVoiceStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    voiceJoined = true;
    voiceMutedSelf = false;

    const myTeam = teamsData[myTeamId] || getRoomTeamMeta(myTeamId) || {};
    await db.ref(`rooms/${roomCode}/voice/participants/${myTeamId}`).set({
      joinedAt: Date.now(),
      ownerName: myTeam.ownerName || playerName || 'Player',
      short: myTeam.short || myTeamId
    });

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
  if (voiceJoined) {
    try {
      await db.ref(`rooms/${roomCode}/voice/participants/${myTeamId}`).remove();
      await db.ref(`rooms/${roomCode}/voice/signals/${myTeamId}`).remove();
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
    pendingCandidates: []
  };
  voicePeerState[remoteTeamId] = state;

  if (localVoiceStream) {
    localVoiceStream.getAudioTracks().forEach(track => {
      pc.addTrack(track, localVoiceStream);
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
    if (s === 'failed' || s === 'closed' || s === 'disconnected') {
      detachVoicePeer(remoteTeamId);
    }
  };

  return state;
}

async function makeVoiceOffer(remoteTeamId) {
  const state = ensureVoicePeer(remoteTeamId);
  if (!state) return;

  const offer = await state.pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false });
  await state.pc.setLocalDescription(offer);
  await sendVoiceSignal(remoteTeamId, { description: state.pc.localDescription });
}

async function sendVoiceSignal(targetTeamId, payload) {
  if (!targetTeamId || targetTeamId === myTeamId) return;
  await db.ref(`rooms/${roomCode}/voice/signals/${targetTeamId}`).push({
    fromTeamId: myTeamId,
    at: Date.now(),
    ...payload
  });
}

async function handleVoiceSignalPayload(payload) {
  if (!payload || !voiceJoined) return;
  const fromTeamId = payload.fromTeamId;
  if (!fromTeamId || fromTeamId === myTeamId) return;

  const state = ensureVoicePeer(fromTeamId);
  if (!state) return;

  if (payload.description) {
    const remoteDesc = new RTCSessionDescription(payload.description);
    if (remoteDesc.type === 'offer') {
      await state.pc.setRemoteDescription(remoteDesc);
      while (state.pendingCandidates.length) {
        const cand = state.pendingCandidates.shift();
        await state.pc.addIceCandidate(cand);
      }
      const answer = await state.pc.createAnswer();
      await state.pc.setLocalDescription(answer);
      await sendVoiceSignal(fromTeamId, { description: state.pc.localDescription });
      return;
    }

    if (remoteDesc.type === 'answer') {
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

  const participants = Object.entries(voiceParticipants || {}).sort((a, b) => (a[1]?.joinedAt || 0) - (b[1]?.joinedAt || 0));
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
  const ref = db.ref(`rooms/${roomCode}/voice/muted/${teamId}`);
  try {
    if (voiceHostMutedMap[teamId]) {
      await ref.remove();
      showToast('Voice unmuted for player.', 'success');
    } else {
      await ref.set(true);
      showToast('Voice muted for player.', 'success');
    }
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

  if (input) input.disabled = isChatMuted;
  if (sendBtn) sendBtn.disabled = isChatMuted;
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

async function sendChatMessage() {
  if (isChatMuted) {
    showToast('You are muted by host.', 'error');
    return;
  }

  const input = document.getElementById('chatInput');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;

  const now = Date.now();
  if (now - lastChatSentAt < 700) {
    showToast('Please slow down.', 'error');
    return;
  }
  lastChatSentAt = now;

  const myTeam = teamsData[myTeamId] || getRoomTeamMeta(myTeamId) || {};

  try {
    await db.ref(`rooms/${roomCode}/chat/messages`).push({
      senderTeamId: myTeamId,
      senderShort: myTeam.short || myTeamId,
      senderName: myTeam.ownerName || playerName,
      text,
      at: now
    });
    input.value = '';
  } catch (err) {
    console.error('Send chat failed:', err);
    showToast('Failed to send message.', 'error');
  }
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
  const myTeam = teamsData[myTeamId];
  const el = document.getElementById('myPurseDisplay');
  if (el && myTeam) el.textContent = formatPrice(myTeam.purse);
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
}

function hideResultBanner() {
  document.getElementById('resultOverlay').classList.remove('visible');
}

// ---- CLEANUP ----
window.addEventListener('beforeunload', () => {
  if (voiceFeatureEnabled) leaveVoiceChat();
  clearInterval(timerInterval);
  db.ref(`rooms/${roomCode}/teams`).off('value', listeners.teams);
  db.ref(`rooms/${roomCode}/soldPlayers`).off('value', listeners.soldPlayers);
  db.ref(`rooms/${roomCode}/auctionControl`).off('value', listeners.pause);
  db.ref(`rooms/${roomCode}/currentAuction`).off('value', listeners.auction);
  db.ref(`rooms/${roomCode}/currentIndex`).off('value', listeners.index);
  db.ref(`rooms/${roomCode}/config/status`).off('value', listeners.status);
  db.ref(`rooms/${roomCode}/watchlists/${myTeamId}`).off('value', listeners.watchlist);
  db.ref(`rooms/${roomCode}/chat/messages`).off('value', listeners.chatMessages);
  db.ref(`rooms/${roomCode}/chat/muted`).off('value', listeners.chatMutedMap);
  db.ref(`rooms/${roomCode}/chat/muted/${myTeamId}`).off('value', listeners.chatMuted);
  if (voiceFeatureEnabled) {
    db.ref(`rooms/${roomCode}/voice/participants`).off('value', listeners.voiceParticipants);
    db.ref(`rooms/${roomCode}/voice/muted`).off('value', listeners.voiceHostMutedMap);
    db.ref(`rooms/${roomCode}/voice/muted/${myTeamId}`).off('value', listeners.voiceHostMuted);
    db.ref(`rooms/${roomCode}/voice/signals/${myTeamId}`).off('child_added', listeners.voiceSignals);
  }
});
