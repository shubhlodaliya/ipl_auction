// ============================================================
// CREATE.JS — Room creation & join from the landing page
// ============================================================

let selectedCreateTeam = null;
let selectedJoinTeam = null;
let joinRoomListener = null; // Firebase listener for join team check

window.addEventListener('DOMContentLoaded', initCreatePage);

function initCreatePage() {
  initAuctionModeToggle();
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
      <img class="team-logo" src="${t.logo}" alt="${t.short} logo" />
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

  const takenTeams = Object.keys(room.teams || {});

  grid.innerHTML = IPL_TEAMS.map(t => {
    const taken = takenTeams.includes(t.id);
    return `
      <div class="team-option ${taken ? 'taken' : ''}" id="join-team-${t.id}"
           onclick="${taken ? '' : `selectJoinTeam('${t.id}')`}"
           title="${t.name}"
           style="--team-color:${t.primary}">
        <img class="team-logo" src="${t.logo}" alt="${t.short} logo" />
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
  const name = document.getElementById('createName').value.trim();
  const teamId = selectedCreateTeam;
  const passcode = document.getElementById('createPasscode').value.trim();
  const budget = parseInt(document.getElementById('budgetRange').value);
  const maxSquad = parseInt(document.getElementById('squadRange').value);
  const timerSec = parseInt(document.getElementById('timerRange').value);
  const auctionMode = document.querySelector('input[name="auctionMode"]:checked')?.value || 'random';

  const errEl = document.getElementById('createError');
  errEl.style.display = 'none';

  if (!name) { showError(errEl, 'Please enter your name.'); return; }
  if (!teamId) { showError(errEl, 'Please select an IPL team.'); return; }

  const btn = document.getElementById('createBtn');
  btn.disabled = true;
  btn.textContent = 'Creating...';

  try {
    const code = generateRoomCode();
    const team = getTeam(teamId);

    await db.ref(`rooms/${code}`).set({
      config: {
        hostTeamId: teamId,
        budget,
        maxSquadSize: maxSquad,
        timerSeconds: timerSec,
        auctionMode,
        invitePasscode: passcode || null,
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
          purse: budget,
          squad: [],
          isHost: true,
          joinedAt: Date.now()
        }
      }
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
  const code = document.getElementById('joinCode').value.trim().toUpperCase();
  const name = document.getElementById('joinName').value.trim();
  const passcode = document.getElementById('joinPasscode').value.trim();
  const teamId = selectedJoinTeam;

  const errEl = document.getElementById('joinError');
  errEl.style.display = 'none';

  if (code.length !== 6) { showError(errEl, 'Enter a valid 6-character room code.'); return; }
  if (!name) { showError(errEl, 'Please enter your name.'); return; }
  if (!teamId) { showError(errEl, 'Please pick an IPL team.'); return; }

  const btn = document.getElementById('joinBtn');
  btn.disabled = true;
  btn.textContent = 'Joining...';

  try {
    const snap = await db.ref(`rooms/${code}`).get();
    if (!snap.exists()) { showError(errEl, 'Room not found. Check the code and try again.'); btn.disabled = false; btn.textContent = '🚀 Join Auction'; return; }

    const room = snap.val();
    if (room.config.status === 'auction') { showError(errEl, 'This auction has already started!'); btn.disabled = false; btn.textContent = '🚀 Join Auction'; return; }
    if (room.config.status === 'finished') { showError(errEl, 'This auction has ended.'); btn.disabled = false; btn.textContent = '🚀 Join Auction'; return; }
    if (room.config.invitePasscode && room.config.invitePasscode !== passcode) {
      showError(errEl, 'Invalid room passcode.');
      btn.disabled = false;
      btn.textContent = '🚀 Join Auction';
      return;
    }

    const existing = room.teams && room.teams[teamId];
    if (existing) { showError(errEl, 'That team is already taken! Pick another.'); btn.disabled = false; btn.textContent = '🚀 Join Auction'; return; }

    const team = getTeam(teamId);
    await db.ref(`rooms/${code}/teams/${teamId}`).set({
      name: team.name,
      short: team.short,
      primary: team.primary,
      logo: team.logo,
      ownerName: name,
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

function showError(el, msg) {
  el.textContent = msg;
  el.style.display = 'block';
}
