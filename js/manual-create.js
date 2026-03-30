// ============================================================
// MANUAL-CREATE.JS — Full manual auction room setup
// ============================================================

let teamCounter = 0;
let playerCounter = 0;

window.addEventListener('DOMContentLoaded', initManualSetup);

function initManualSetup() {
  for (let i = 0; i < 4; i += 1) addTeamRow();
  for (let i = 0; i < 12; i += 1) addPlayerRow();
}

function normalizeTeamShort(name) {
  const cleaned = String(name || '').trim().toUpperCase().replace(/[^A-Z0-9 ]/g, '');
  if (!cleaned) return '';
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length === 1) return tokens[0].slice(0, 4);
  return tokens.map(t => t[0]).join('').slice(0, 4);
}

function addTeamRow() {
  teamCounter += 1;
  const rowId = `teamRow_${teamCounter}`;
  const container = document.getElementById('manualTeamsList');

  const defaultName = `Team ${teamCounter}`;

  const row = document.createElement('div');
  row.className = 'manual-row manual-team-row';
  row.id = rowId;
  row.innerHTML = `
    <input class="form-input team-name" type="text" maxlength="32" value="${defaultName}" placeholder="Team name" oninput="syncHostTeamOptions()" />
    <input class="form-input team-short" type="text" maxlength="6" value="${normalizeTeamShort(defaultName)}" placeholder="Short" oninput="syncHostTeamOptions()" />
    <input class="form-input team-logo-file" type="file" accept="image/*" />
    <input class="form-input team-color" type="color" value="#1da462" />
    <button class="btn btn-danger" onclick="removeRow('${rowId}', syncHostTeamOptions)">Remove</button>
  `;

  container.appendChild(row);
  syncHostTeamOptions();
}

function addPlayerRow() {
  playerCounter += 1;
  const rowId = `playerRow_${playerCounter}`;
  const container = document.getElementById('manualPlayersList');

  const row = document.createElement('div');
  row.className = 'manual-row manual-player-row';
  row.id = rowId;
  row.innerHTML = `
    <input class="form-input p-name" type="text" maxlength="48" placeholder="Player name" />
    <input class="form-input p-age" type="number" min="14" max="60" step="1" placeholder="Age" />
    <select class="form-input p-category">
      <option value="Batsman">Batsman</option>
      <option value="Bowler">Bowler</option>
      <option value="All-rounder">All-rounder</option>
      <option value="Wicket-keeper">Wicket-keeper</option>
      <option value="Spinner">Spinner</option>
      <option value="Fast Bowler">Fast Bowler</option>
    </select>
    <input class="form-input p-base" type="number" min="1" step="1" placeholder="Base Lakh" />
    <input class="form-input p-photo-file" type="file" accept="image/*" />
    <button class="btn btn-danger" onclick="removeRow('${rowId}')">Remove</button>
  `;

  container.appendChild(row);
}

function removeRow(rowId, callback = null) {
  const row = document.getElementById(rowId);
  if (row && row.parentNode) row.parentNode.removeChild(row);
  if (typeof callback === 'function') callback();
}

function applyBasePriceToAll() {
  const value = Number(document.getElementById('bulkBasePrice').value);
  if (!value || value <= 0) {
    showToast('Enter valid base price first.', 'error');
    return;
  }

  document.querySelectorAll('.manual-player-row .p-base').forEach(input => {
    input.value = value;
  });

  showToast('Applied base price to all players.', 'success');
}

function syncHostTeamOptions() {
  const select = document.getElementById('hostTeamSelect');
  if (!select) return;

  const teams = collectTeams(false);
  const current = select.value;

  select.innerHTML = teams.map(t => `<option value="${t.id}">${t.name} (${t.short})</option>`).join('');

  if (current && teams.some(t => t.id === current)) {
    select.value = current;
  }
}

function collectTeams(strict = true) {
  const rows = [...document.querySelectorAll('.manual-team-row')];
  return rows.map((row, idx) => {
    const name = row.querySelector('.team-name').value.trim();
    const shortRaw = row.querySelector('.team-short').value.trim();
    const short = shortRaw || normalizeTeamShort(name);
    const primary = row.querySelector('.team-color').value || '#1da462';
    const logoFile = row.querySelector('.team-logo-file')?.files?.[0] || null;

    if (strict && (!name || !short)) return null;

    return {
      id: `mt_${idx + 1}`,
      name,
      short,
      logoFile,
      primary,
      secondary: '#ffffff'
    };
  }).filter(Boolean);
}

function collectPlayers() {
  const rows = [...document.querySelectorAll('.manual-player-row')];

  return rows.map((row, idx) => {
    const name = row.querySelector('.p-name').value.trim();
    const age = Number(row.querySelector('.p-age').value || 0);
    const category = row.querySelector('.p-category').value;
    const base = Number(row.querySelector('.p-base').value || 0);
    const photoFile = row.querySelector('.p-photo-file')?.files?.[0] || null;

    if (!name || !base) return null;

    return {
      id: `mp_${idx + 1}`,
      name,
      age: age || null,
      category,
      role: category,
      base_price_lakh: base,
      country: 'Manual',
      photoFile
    };
  }).filter(Boolean);
}

function parseBidOptions() {
  const raw = document.getElementById('bidOptions').value.trim();
  const options = raw
    .split(',')
    .map(x => Number(String(x).trim()))
    .filter(x => Number.isFinite(x) && x > 0);

  return [...new Set(options)].sort((a, b) => a - b);
}

async function getSignedUploadParams(payload) {
  const resp = await fetch('/api/cloudinary-sign-upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const contentType = resp.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    const text = await resp.text();
    if (text && text.includes('<!DOCTYPE')) {
      throw new Error('Upload API is not running. Use Vercel deployment or run with vercel dev (not static serve).');
    }
    throw new Error('Upload API returned invalid response format.');
  }

  const json = await resp.json();
  if (!resp.ok || !json?.signature) {
    throw new Error(json?.error || 'Failed to sign Cloudinary upload');
  }
  return json;
}

async function uploadFileToCloudinary(file, signPayload) {
  const signed = await getSignedUploadParams(signPayload);
  const form = new FormData();

  form.append('file', file);
  form.append('api_key', signed.apiKey);
  form.append('timestamp', String(signed.timestamp));
  form.append('signature', signed.signature);
  form.append('folder', signed.folder);
  form.append('public_id', signed.publicId);
  form.append('tags', signed.tags);

  const uploadResp = await fetch(`https://api.cloudinary.com/v1_1/${signed.cloudName}/image/upload`, {
    method: 'POST',
    body: form
  });

  const uploadJson = await uploadResp.json();
  if (!uploadResp.ok || !uploadJson?.secure_url) {
    throw new Error(uploadJson?.error?.message || 'Cloudinary upload failed');
  }

  return uploadJson.secure_url;
}

async function uploadManualAssets(roomCode, teams, players) {
  for (const team of teams) {
    if (!team.logoFile) continue;
    team.logo = await uploadFileToCloudinary(team.logoFile, {
      roomCode,
      entityType: 'team',
      entityId: team.id,
      fileName: team.logoFile.name || 'logo'
    });
  }

  for (const player of players) {
    if (!player.photoFile) continue;
    player.photo_url = await uploadFileToCloudinary(player.photoFile, {
      roomCode,
      entityType: 'player',
      entityId: player.id,
      fileName: player.photoFile.name || 'photo'
    });
  }
}

async function createManualRoom() {
  const errEl = document.getElementById('manualSetupError');
  errEl.style.display = 'none';

  const hostName = document.getElementById('hostName').value.trim();
  const passcode = document.getElementById('invitePasscode').value.trim();
  const budget = Number(document.getElementById('budgetLakh').value || 0);
  const maxSquadSize = Number(document.getElementById('maxSquadSize').value || 0);
  const timerSeconds = Number(document.getElementById('timerSeconds').value || 0);
  const bidOptions = parseBidOptions();

  const teams = collectTeams(true);
  const players = collectPlayers();
  const hostTeamId = document.getElementById('hostTeamSelect').value;

  if (!hostName) return showError('Host name is required.');
  if (teams.length < 2) return showError('Add at least 2 teams.');
  if (players.length < 1) return showError('Add at least 1 player.');
  if (budget <= 0) return showError('Purse must be positive.');
  if (maxSquadSize <= 0) return showError('Max players per team must be positive.');
  if (timerSeconds < 5) return showError('Timer must be at least 5 seconds.');
  if (!bidOptions.length) return showError('Add at least one bid option.');

  const hostTeam = teams.find(t => t.id === hostTeamId);
  if (!hostTeam) return showError('Select host team.');

  const btn = document.getElementById('createManualRoomBtn');
  btn.disabled = true;
  btn.textContent = 'Uploading assets...';

  try {
    const code = generateRoomCode();

    await uploadManualAssets(code, teams, players);

    const manualTeams = {};
    teams.forEach(t => {
      manualTeams[t.id] = {
        id: t.id,
        name: t.name,
        short: t.short,
        logo: t.logo || '',
        primary: t.primary,
        secondary: t.secondary || '#ffffff'
      };
    });

    const finalPlayers = players.map(p => ({
      id: p.id,
      name: p.name,
      age: p.age || null,
      category: p.category,
      role: p.role,
      base_price_lakh: p.base_price_lakh,
      country: p.country || 'Manual',
      photo_url: p.photo_url || null
    }));

    const playerQueue = finalPlayers.map(p => p.id);

    btn.textContent = 'Creating room...';

    await db.ref(`rooms/${code}`).set({
      config: {
        auctionType: 'manual',
        hostTeamId: hostTeam.id,
        budget,
        maxSquadSize,
        timerSeconds,
        bidOptions,
        auctionMode: 'manual',
        invitePasscode: passcode || null,
        status: 'lobby',
        createdAt: Date.now()
      },
      manualTeams,
      manualPlayers: finalPlayers,
      teams: {
        [hostTeam.id]: {
          name: hostTeam.name,
          short: hostTeam.short,
          primary: hostTeam.primary,
          logo: hostTeam.logo || '',
          ownerName: hostName,
          purse: budget,
          squad: [],
          isHost: true,
          joinedAt: Date.now()
        }
      },
      playerQueue
    });

    saveSession({ roomCode: code, teamId: hostTeam.id, playerName: hostName, isHost: true });
    window.location.href = 'lobby.html';
  } catch (err) {
    console.error(err);
    showError(err.message || 'Failed to create manual room.');
    btn.disabled = false;
    btn.textContent = 'Create Manual Auction Room';
  }

  function showError(message) {
    errEl.textContent = message;
    errEl.style.display = 'block';
  }
}
