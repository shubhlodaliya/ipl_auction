// ============================================================
// MANUAL-CREATE.JS — Full manual auction room setup
// ============================================================

let teamCounter = 0;
let playerCounter = 0;
let customPlayerFields = [];

window.addEventListener('DOMContentLoaded', initManualSetup);

function initManualSetup() {
  for (let i = 0; i < 4; i += 1) addTeamRow();
  for (let i = 0; i < 12; i += 1) addPlayerRow();
}

function toggleManualTimerUnlimited(enabled) {
  const timerInput = document.getElementById('timerSeconds');
  if (!timerInput) return;
  timerInput.disabled = !!enabled;
  if (enabled) timerInput.value = '0';
  else if (!Number(timerInput.value) || Number(timerInput.value) < 5) timerInput.value = '30';
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

function addPlayerRow(prefill = null) {
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
    <div class="manual-player-custom" data-custom-wrap="1"></div>
  `;

  container.appendChild(row);
  syncCustomFieldsToRows();

  if (prefill) {
    row.querySelector('.p-name').value = prefill.name || '';
    row.querySelector('.p-age').value = prefill.age || '';
    row.querySelector('.p-category').value = prefill.category || 'Batsman';
    row.querySelector('.p-base').value = prefill.base_price_lakh || '';
    if (prefill.photo_url) row.dataset.photoUrl = prefill.photo_url;

    if (prefill.extraFields) {
      Object.entries(prefill.extraFields).forEach(([key, value]) => {
        const input = row.querySelector(`.p-extra[data-extra-key="${key}"]`);
        if (input) input.value = value;
      });
    }
  }
}

function normalizeHeader(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeCategory(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return 'Batsman';
  if (value.includes('keeper')) return 'Wicket-keeper';
  if (value.includes('all')) return 'All-rounder';
  if (value.includes('spin')) return 'Spinner';
  if (value.includes('fast') || value.includes('pace')) return 'Fast Bowler';
  if (value.includes('bowl')) return 'Bowler';
  if (value.includes('bat')) return 'Batsman';
  return 'Batsman';
}

function parseNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(String(value).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(num) ? num : null;
}

async function importExcelPlayers() {
  if (typeof XLSX === 'undefined') {
    showToast('Excel parser failed to load. Refresh and try again.', 'error');
    return;
  }

  const fileInput = document.getElementById('excelPlayersFile');
  const file = fileInput?.files?.[0];
  if (!file) {
    showToast('Choose an Excel file first.', 'error');
    return;
  }

  const baseFallback = Number(document.getElementById('bulkBasePrice').value || 0);

  try {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    if (!rows.length) {
      showToast('Excel file is empty.', 'error');
      return;
    }

    const headers = rows[0].map(h => String(h || '').trim());
    const headerKeys = headers.map(normalizeHeader);

    const findHeaderIndex = (variants) => headerKeys.findIndex(k => variants.includes(k));

    const idxName = findHeaderIndex(['name', 'player_name', 'player']);
    const idxAge = findHeaderIndex(['age']);
    const idxCategory = findHeaderIndex(['category', 'role', 'player_role']);
    const idxBase = findHeaderIndex(['base_price', 'base', 'base_lakh', 'base_price_lakh', 'price']);
    const idxPhoto = findHeaderIndex(['photo', 'photo_url', 'image', 'image_url', 'avatar']);

    if (idxName === -1) {
      showToast('Excel must contain Name column.', 'error');
      return;
    }

    if (idxBase === -1 && !(baseFallback > 0)) {
      showToast('No base price column found. Enter default Base Lakh first.', 'error');
      return;
    }

    const usedIndexes = new Set([idxName, idxAge, idxCategory, idxBase, idxPhoto].filter(i => i >= 0));
    const extraColumns = headers
      .map((label, idx) => ({ label: String(label || '').trim(), idx }))
      .filter(col => col.label && !usedIndexes.has(col.idx));

    customPlayerFields = extraColumns.map((col, i) => {
      const key = toFieldKey(col.label) || `field_${i + 1}`;
      return { key, label: col.label, excelIndex: col.idx };
    });
    renderCustomFieldList();

    const importedPlayers = [];
    for (let i = 1; i < rows.length; i += 1) {
      const row = rows[i] || [];
      const name = String(row[idxName] || '').trim();
      if (!name) continue;

      const age = idxAge >= 0 ? parseNumber(row[idxAge]) : null;
      const category = idxCategory >= 0 ? normalizeCategory(row[idxCategory]) : 'Batsman';
      const baseFromExcel = idxBase >= 0 ? parseNumber(row[idxBase]) : null;
      const basePrice = baseFromExcel && baseFromExcel > 0 ? baseFromExcel : baseFallback;
      const photoUrl = idxPhoto >= 0 ? String(row[idxPhoto] || '').trim() : '';

      const extraFields = {};
      customPlayerFields.forEach((f) => {
        const value = String(row[f.excelIndex] || '').trim();
        if (value) extraFields[f.key] = value;
      });

      importedPlayers.push({
        name,
        age: age || '',
        category,
        base_price_lakh: basePrice,
        photo_url: photoUrl,
        extraFields
      });
    }

    if (!importedPlayers.length) {
      showToast('No valid player rows found in Excel.', 'error');
      return;
    }

    const container = document.getElementById('manualPlayersList');
    container.innerHTML = '';
    playerCounter = 0;
    importedPlayers.forEach((p) => addPlayerRow(p));

    showToast(`Imported ${importedPlayers.length} players from Excel.`, 'success');
  } catch (err) {
    console.error('Excel import failed:', err);
    showToast('Failed to import Excel file.', 'error');
  }
}

function toFieldKey(label) {
  return String(label || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
}

function renderCustomFieldList() {
  const list = document.getElementById('customFieldList');
  if (!list) return;
  list.innerHTML = customPlayerFields.map((f) => `
    <span class="manual-custom-field-chip">
      ${f.label}
      <button type="button" onclick="removeCustomPlayerField('${f.key}')">×</button>
    </span>
  `).join('');
}

function addCustomPlayerField() {
  const input = document.getElementById('customFieldLabel');
  if (!input) return;
  const label = input.value.trim();
  if (!label) {
    showToast('Enter custom field name first.', 'error');
    return;
  }

  const key = toFieldKey(label);
  if (!key) {
    showToast('Invalid custom field name.', 'error');
    return;
  }
  if (customPlayerFields.some(f => f.key === key)) {
    showToast('Custom field already exists.', 'error');
    return;
  }

  customPlayerFields.push({ key, label });
  input.value = '';
  renderCustomFieldList();
  syncCustomFieldsToRows();
}

function removeCustomPlayerField(fieldKey) {
  customPlayerFields = customPlayerFields.filter(f => f.key !== fieldKey);
  renderCustomFieldList();
  syncCustomFieldsToRows();
}

function syncCustomFieldsToRows() {
  const rows = [...document.querySelectorAll('.manual-player-row')];
  rows.forEach((row) => {
    const wrap = row.querySelector('[data-custom-wrap="1"]');
    if (!wrap) return;

    const existingValues = {};
    wrap.querySelectorAll('input[data-extra-key]').forEach((el) => {
      existingValues[el.dataset.extraKey] = el.value;
    });

    wrap.innerHTML = customPlayerFields.map((field) => {
      const value = existingValues[field.key] || '';
      return `<input class="form-input p-extra" data-extra-key="${field.key}" type="text" maxlength="40" placeholder="${field.label}" value="${value.replace(/"/g, '&quot;')}" />`;
    }).join('');

    wrap.style.display = customPlayerFields.length ? 'grid' : 'none';
  });
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
    const photoUrl = String(row.dataset.photoUrl || '').trim();
    const extraFields = {};
    row.querySelectorAll('.p-extra[data-extra-key]').forEach((el) => {
      const key = el.dataset.extraKey;
      const value = el.value.trim();
      if (key && value) extraFields[key] = value;
    });

    if (!name || !base) return null;

    return {
      id: `mp_${idx + 1}`,
      name,
      age: age || null,
      category,
      role: category,
      base_price_lakh: base,
      country: 'Manual',
      extraFields,
      photoFile,
      photo_url: photoUrl || null
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

async function uploadFileToCloudinary(fileOrSource, signPayload) {
  const signed = await getSignedUploadParams(signPayload);
  const form = new FormData();

  form.append('file', fileOrSource);
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
    if (player.photoFile) {
      player.photo_url = await uploadFileToCloudinary(player.photoFile, {
        roomCode,
        entityType: 'player',
        entityId: player.id,
        fileName: player.photoFile.name || 'photo'
      });
      continue;
    }

    const source = String(player.photo_url || '').trim();
    if (!source) continue;

    const isRemoteUrl = /^https?:\/\//i.test(source);
    const isDataUrl = /^data:image\//i.test(source);
    if (!isRemoteUrl && !isDataUrl) continue;

    player.photo_url = await uploadFileToCloudinary(source, {
      roomCode,
      entityType: 'player',
      entityId: player.id,
      fileName: isRemoteUrl ? 'photo-url' : 'photo-data-url'
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
  const minSquadSize = Number(document.getElementById('minSquadSize').value || 0);
  const timerSeconds = Number(document.getElementById('timerSeconds').value || 0);
  const timerUnlimited = !!document.getElementById('timerUnlimited')?.checked;
  const bidOptions = parseBidOptions();

  const teams = collectTeams(true);
  const players = collectPlayers();
  const hostTeamId = document.getElementById('hostTeamSelect').value;

  if (!hostName) return showError('Host name is required.');
  if (!passcode) return showError('Room passcode is required.');
  if (teams.length < 2) return showError('Add at least 2 teams.');
  if (players.length < 1) return showError('Add at least 1 player.');
  if (budget <= 0) return showError('Purse must be positive.');
  if (maxSquadSize <= 0) return showError('Max players per team must be positive.');
  if (minSquadSize <= 0) return showError('Min players per team must be positive.');
  if (minSquadSize > maxSquadSize) return showError('Min players per team cannot be greater than max players per team.');
  if (!timerUnlimited && timerSeconds < 5) return showError('Timer must be at least 5 seconds, or enable Unlimited Timer.');
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
      extraFields: p.extraFields || {},
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
        minSquadSize,
        timerSeconds: timerUnlimited ? 0 : timerSeconds,
        timerMode: timerUnlimited ? 'unlimited' : 'countdown',
        unlimitedTimer: timerUnlimited,
        bidOptions,
        manualPlayerFields: customPlayerFields,
        auctionMode: 'manual',
        invitePasscode: passcode,
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
