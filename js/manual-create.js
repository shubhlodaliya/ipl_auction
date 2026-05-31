// ============================================================
// MANUAL-CREATE.JS — Full manual auction room setup
// ============================================================

let teamCounter = 0;
let playerCounter = 0;
let customPlayerFields = [];
const MANUAL_ASSET_CACHE_KEY = 'ipl_manual_asset_cache_v1';
const MANUAL_ASSET_CACHE_LIMIT = 500;
const MANUAL_PAYMENT_TIERS = [
  { maxTeams: 3, amount: 0, label: 'Free plan' },
  { maxTeams: 4, amount: 299, label: '₹299 plan' },
  { maxTeams: 6, amount: 399, label: '₹399 plan' },
  { maxTeams: 8, amount: 499, label: '₹499 plan' },
  { maxTeams: 12, amount: 599, label: '₹599 plan' },
  { maxTeams: 16, amount: 699, label: '₹699 plan' },
  { maxTeams: 20, amount: 799, label: '₹799 plan' },
  { maxTeams: 30, amount: 999, label: '₹999 plan' }
];

async function reserveAvailableRoomCode(maxAttempts = 30) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const code = generateRoomCode();
    const snap = await db.ref(`rooms/${code}`).get();
    if (!snap.exists()) return code;
  }
  throw new Error('Could not generate unique room code');
}

window.addEventListener('DOMContentLoaded', initManualSetup);

async function initManualSetup() {
  if (typeof requireAuth === 'function' && !requireAuth('index.html')) return;

  if (typeof waitForAuthReady === 'function') {
    await waitForAuthReady();
  }

  for (let i = 0; i < 3; i += 1) addTeamRow();
  for (let i = 0; i < 12; i += 1) addPlayerRow();
  updateManualPaymentUi();
  refreshManualPaymentStatus();
}

function toggleManualTimerUnlimited(enabled) {
  const timerInput = document.getElementById('timerSeconds');
  if (!timerInput) return;
  timerInput.disabled = !!enabled;
  if (enabled) timerInput.value = '0';
  else if (!Number(timerInput.value) || Number(timerInput.value) < 5) timerInput.value = '30';
}

function toggleHostManagerOnly(enabled) {
  const hostTeamSelect = document.getElementById('hostTeamSelect');
  if (!hostTeamSelect) return;
  hostTeamSelect.disabled = !!enabled;
}

function toggleHostBidsForAllTeams(enabled) {
  const bidOptionsInput = document.getElementById('bidOptions');
  if (bidOptionsInput) {
    if (enabled) {
      bidOptionsInput.dataset.prevVal = bidOptionsInput.value;
      const options = parseBidOptions();
      const single = options[0] || 25;
      bidOptionsInput.value = String(single);
      bidOptionsInput.disabled = true;
    } else {
      bidOptionsInput.disabled = false;
      if (bidOptionsInput.dataset.prevVal) {
        bidOptionsInput.value = bidOptionsInput.dataset.prevVal;
        delete bidOptionsInput.dataset.prevVal;
      }
    }
  }
}

function toggleHostRoleMode(mode) {
  const hostTeamSelect = document.getElementById('hostTeamSelect');
  if (!hostTeamSelect) return;

  const isPlaying = mode === 'playing';
  const isPaddle = mode === 'paddle';

  hostTeamSelect.disabled = !isPlaying;
  toggleHostBidsForAllTeams(isPaddle);
}

function getSelectedHostRoleMode() {
  const selected = document.querySelector('input[name="hostRoleMode"]:checked');
  const mode = String(selected?.value || 'playing');
  if (mode === 'manager' || mode === 'paddle' || mode === 'playing') return mode;
  return 'playing';
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
    <input class="form-input team-logo-file" type="file" accept="image/*" />
    <input class="form-input team-color" type="color" value="#1da462" />
    <button class="btn btn-danger" onclick="removeRow('${rowId}', syncHostTeamOptions)">Remove</button>
  `;

  container.appendChild(row);
  syncHostTeamOptions();
  updateManualPaymentUi();
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
    if (Number.isFinite(Number(prefill.player_number)) && Number(prefill.player_number) > 0) {
      row.dataset.playerNumber = String(Number(prefill.player_number));
    }
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

function parseDateTimeLocal(value) {
  const raw = String(value || '').trim();
  if (!raw) return 0;
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return 0;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6] || 0);
  const dt = new Date(year, month - 1, day, hour, minute, second, 0);
  const ms = dt.getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function parseHyperlinkFormulaUrl(formula) {
  const f = String(formula || '').trim();
  if (!/^HYPERLINK\(/i.test(f)) return '';
  const m = f.match(/^HYPERLINK\(\s*"([^"]+)"/i);
  return m?.[1] ? String(m[1]).trim() : '';
}

function getExcelCellHyperlink(sheet, rowIndex, colIndex) {
  if (!sheet || rowIndex < 0 || colIndex < 0) return '';
  const ref = XLSX.utils.encode_cell({ r: rowIndex, c: colIndex });
  const cell = sheet[ref];
  if (!cell) return '';

  const link = String(cell?.l?.Target || '').trim();
  if (link) return link;

  return parseHyperlinkFormulaUrl(cell?.f);
}

function normalizeImageSource(rawSource) {
  const source = String(rawSource || '').trim();
  if (!source) return '';

  // Excel hyperlinks often show only display text unless we read cell metadata.
  if (/^www\./i.test(source)) return `https://${source}`;
  return source;
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
      const rawPhotoUrl = idxPhoto >= 0 ? String(row[idxPhoto] || '').trim() : '';
      const photoLink = idxPhoto >= 0 ? getExcelCellHyperlink(sheet, i, idxPhoto) : '';
      const photoUrl = normalizeImageSource(photoLink || rawPhotoUrl);

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
        player_number: importedPlayers.length + 1,
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
  updateManualPaymentUi();
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

  select.innerHTML = teams.map(t => `<option value="${t.id}">${t.name}</option>`).join('');

  if (current && teams.some(t => t.id === current)) {
    select.value = current;
  }

  const managerOnly = !!document.getElementById('hostManagerOnly')?.checked;
  toggleHostManagerOnly(managerOnly);
}

function collectTeams(strict = true) {
  const rows = [...document.querySelectorAll('.manual-team-row')];
  return rows.map((row, idx) => {
    const name = row.querySelector('.team-name').value.trim();
    const short = normalizeTeamShort(name);
    const primary = row.querySelector('.team-color').value || '#1da462';
    const logoFile = row.querySelector('.team-logo-file')?.files?.[0] || null;

    if (strict && (!name)) return null;

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
      player_number: Number(row.dataset.playerNumber || (idx + 1)),
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

function hashText(input) {
  // Small deterministic hash for stable local cache keys.
  let hash = 2166136261;
  const str = String(input || '');
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function readManualAssetCache() {
  try {
    const raw = localStorage.getItem(MANUAL_ASSET_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function saveManualAssetCache(cache) {
  try {
    const entries = Object.entries(cache || {});
    const sliced = entries.slice(-MANUAL_ASSET_CACHE_LIMIT);
    localStorage.setItem(MANUAL_ASSET_CACHE_KEY, JSON.stringify(Object.fromEntries(sliced)));
  } catch (_) {
    // Ignore cache persistence failures.
  }
}

function isCloudinaryUrl(url) {
  return /^https?:\/\/res\.cloudinary\.com\//i.test(String(url || '').trim());
}

function getFileAssetKey(file, kind) {
  const sig = [
    String(file?.name || ''),
    String(file?.size || 0),
    String(file?.lastModified || 0),
    String(file?.type || '')
  ].join('|');
  return `${kind}-file-${hashText(sig)}`;
}

function getSourceAssetKey(source, kind) {
  return `${kind}-source-${hashText(String(source || '').trim())}`;
}

function getCachedAssetUrl(cache, key) {
  const url = String(cache?.[key] || '').trim();
  return isCloudinaryUrl(url) ? url : '';
}

function setCachedAssetUrl(cache, key, url) {
  if (!cache || !key) return;
  const safeUrl = String(url || '').trim();
  if (!isCloudinaryUrl(safeUrl)) return;

  if (Object.prototype.hasOwnProperty.call(cache, key)) {
    delete cache[key];
  }
  cache[key] = safeUrl;
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

function extractGoogleDriveFileId(url) {
  const source = String(url || '').trim();
  if (!source) return '';

  let parsed;
  try {
    parsed = new URL(source);
  } catch (_) {
    return '';
  }

  if (!/drive\.google\.com$/i.test(parsed.hostname)) return '';

  const byQuery = parsed.searchParams.get('id');
  if (byQuery) return byQuery;

  const fileMatch = parsed.pathname.match(/\/file\/d\/([^/]+)/i);
  if (fileMatch?.[1]) return fileMatch[1];

  const dMatch = parsed.pathname.match(/\/d\/([^/]+)/i);
  if (dMatch?.[1]) return dMatch[1];

  return '';
}

function buildDriveUploadCandidates(source) {
  const fileId = extractGoogleDriveFileId(source);
  if (!fileId) return [source];

  // Cloudinary needs a direct resource URL, not a Drive preview page.
  return [
    `https://drive.google.com/uc?export=download&id=${fileId}`,
    `https://drive.google.com/uc?export=view&id=${fileId}`,
    source
  ];
}

async function uploadRemoteSourceWithFallback(source, signPayload) {
  const candidates = buildDriveUploadCandidates(source);
  let lastErr = null;

  for (const candidate of candidates) {
    try {
      return await uploadFileToCloudinary(candidate, signPayload);
    } catch (err) {
      lastErr = err;
    }
  }

  const fileId = extractGoogleDriveFileId(source);
  if (fileId) {
    throw new Error('Google Drive image could not be fetched. Make the file public (Anyone with the link) and try again.');
  }

  throw lastErr || new Error('Image URL could not be uploaded.');
}

async function uploadManualAssets(roomCode, teams, players, options = {}) {
  const assetCache = readManualAssetCache();
  const failedAssets = [];
  let auctionPhoto = '';

  const auctionPhotoFile = options?.auctionPhotoFile || null;
  if (auctionPhotoFile) {
    const auctionAssetKey = getFileAssetKey(auctionPhotoFile, 'auction');
    const cachedAuctionPhoto = getCachedAssetUrl(assetCache, auctionAssetKey);
    if (cachedAuctionPhoto) {
      auctionPhoto = cachedAuctionPhoto;
    } else {
      try {
        auctionPhoto = await uploadFileToCloudinary(auctionPhotoFile, {
          roomCode,
          entityType: 'player',
          entityId: 'auction-cover',
          fileName: auctionPhotoFile.name || 'auction-photo',
          sharedAssetKey: auctionAssetKey
        });
        setCachedAssetUrl(assetCache, auctionAssetKey, auctionPhoto);
      } catch (error) {
        failedAssets.push(`Auction Photo: ${error?.message || String(error)}`);
      }
    }
  }

  for (const team of teams) {
    if (!team.logoFile) continue;

    const teamAssetKey = getFileAssetKey(team.logoFile, 'team');
    const cachedTeamLogo = getCachedAssetUrl(assetCache, teamAssetKey);
    if (cachedTeamLogo) {
      team.logo = cachedTeamLogo;
      continue;
    }

    try {
      team.logo = await uploadFileToCloudinary(team.logoFile, {
        roomCode,
        entityType: 'team',
        entityId: team.id,
        fileName: team.logoFile.name || 'logo',
        sharedAssetKey: teamAssetKey
      });
      setCachedAssetUrl(assetCache, teamAssetKey, team.logo);
    } catch (error) {
      failedAssets.push(`Team ${team.name}: ${error?.message || String(error)}`);
    }
  }

  for (const player of players) {
    if (player.photoFile) {
      const playerAssetKey = getFileAssetKey(player.photoFile, 'player');
      const cachedPlayerPhoto = getCachedAssetUrl(assetCache, playerAssetKey);
      if (cachedPlayerPhoto) {
        player.photo_url = cachedPlayerPhoto;
        continue;
      }

      try {
        player.photo_url = await uploadFileToCloudinary(player.photoFile, {
          roomCode,
          entityType: 'player',
          entityId: player.id,
          fileName: player.photoFile.name || 'photo',
          sharedAssetKey: playerAssetKey
        });
        setCachedAssetUrl(assetCache, playerAssetKey, player.photo_url);
      } catch (error) {
        failedAssets.push(`Player ${player.name}: ${error?.message || String(error)}`);
      }
      continue;
    }

    const source = String(player.photo_url || '').trim();
    if (!source) continue;
    if (isCloudinaryUrl(source)) continue;

    const isRemoteUrl = /^https?:\/\//i.test(source);
    const isDataUrl = /^data:image\//i.test(source);
    if (!isRemoteUrl && !isDataUrl) continue;

    const sourceAssetKey = getSourceAssetKey(source, isRemoteUrl ? 'player-url' : 'player-data');
    const cachedSourcePhoto = getCachedAssetUrl(assetCache, sourceAssetKey);
    if (cachedSourcePhoto) {
      player.photo_url = cachedSourcePhoto;
      continue;
    }

    const signPayload = {
      roomCode,
      entityType: 'player',
      entityId: player.id,
      fileName: isRemoteUrl ? 'photo-url' : 'photo-data-url',
      sharedAssetKey: sourceAssetKey
    };

    try {
      player.photo_url = isRemoteUrl
        ? await uploadRemoteSourceWithFallback(source, signPayload)
        : await uploadFileToCloudinary(source, signPayload);
      setCachedAssetUrl(assetCache, sourceAssetKey, player.photo_url);
    } catch (error) {
      failedAssets.push(`Player ${player.name}: ${error?.message || String(error)}`);
    }
  }

  saveManualAssetCache(assetCache);

  return { failedAssets, auctionPhoto };
}

function getManualAuctionPlan(teamCount) {
  const count = Number(teamCount || 0);
  if (count <= 3) {
    return { amount: 0, label: 'Free plan', tierTeams: 3, requiresPayment: false };
  }

  const tier = MANUAL_PAYMENT_TIERS.find((item) => count <= item.maxTeams) || MANUAL_PAYMENT_TIERS[MANUAL_PAYMENT_TIERS.length - 1];
  return {
    amount: tier.amount,
    label: tier.amount === 0 ? 'Free plan' : tier.label,
    tierTeams: tier.maxTeams,
    requiresPayment: tier.amount > 0
  };
}

function getManualPaymentRequestId() {
  return String(localStorage.getItem('ipl_manual_payment_request_id') || '').trim();
}

function setManualPaymentRequestId(requestId) {
  const value = String(requestId || '').trim();
  if (value) localStorage.setItem('ipl_manual_payment_request_id', value);
  else localStorage.removeItem('ipl_manual_payment_request_id');
}

function getManualPaymentCacheKey(requestId = '') {
  const value = String(requestId || getManualPaymentRequestId() || '').trim();
  return value ? `ipl_manual_payment_cache_${value}` : '';
}

function setManualPaymentCachedRequest(requestId, requestData) {
  const key = getManualPaymentCacheKey(requestId);
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(requestData || {}));
  } catch (_) {}
}

function getManualPaymentCachedRequest(requestId = '') {
  const key = getManualPaymentCacheKey(requestId);
  if (!key) return null;
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch (_) {
    return null;
  }
}

function escapeManualHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderManualPaymentStatus(request) {
  const statusEl = document.getElementById('paymentRequestStatus');
  const createBtn = document.getElementById('createManualRoomBtn');
  if (!statusEl || !request) return;

  const status = String(request.status || 'pending').toLowerCase();
  if (status === 'approved') {
    statusEl.textContent = `Approved. ${request.amount ? `Paid ${formatPrice(request.amount)}` : 'No payment required'}. You can create the room now.`;
  } else if (status === 'rejected') {
    const reason = String(request.rejectionReason || '').trim();
    const rejectedBy = String(request.rejectedBy || '').trim();
    statusEl.innerHTML = reason
      ? `Rejected by admin${rejectedBy ? ` (${escapeManualHtml(rejectedBy)})` : ''}.<br><span style="display:block;margin-top:0.35rem;color:var(--red);font-weight:600;">Reason: ${escapeManualHtml(reason)}</span><span style="display:block;margin-top:0.25rem;">Please submit a new request.</span>`
      : `Rejected by admin${rejectedBy ? ` (${escapeManualHtml(rejectedBy)})` : ''}. Please submit a new request.`;
  } else if (status === 'expired') {
    statusEl.textContent = 'Expired. Please submit a new request.';
  } else {
    statusEl.textContent = 'Pending admin approval. Check again after the dashboard review.';
  }

  if (createBtn) createBtn.disabled = status !== 'approved';
}

function getManualPaymentSummary() {
  const teams = collectTeams(false);
  const players = collectPlayers();
  const teamCount = teams.length;
  const plan = getManualAuctionPlan(teamCount);

  return {
    teams,
    players,
    teamCount,
    plan,
    auctionTitle: String(document.getElementById('auctionTitle')?.value || '').trim().slice(0, 40) || 'My Auction',
    passcode: String(document.getElementById('invitePasscode')?.value || '').trim(),
    budget: Number(document.getElementById('budgetLakh')?.value || 0),
    maxSquadSize: Number(document.getElementById('maxSquadSize')?.value || 0),
    minSquadSize: Number(document.getElementById('minSquadSize')?.value || 0),
    timerSeconds: Number(document.getElementById('timerSeconds')?.value || 0),
    timerUnlimited: !!document.getElementById('timerUnlimited')?.checked,
    bidOptions: parseBidOptions(),
    iconPlayerPrice: Number(document.getElementById('iconPlayerPrice')?.value || 0),
    maxIconPlayers: Number(document.getElementById('maxIconPlayers')?.value || 0),
    hostRoleMode: getSelectedHostRoleMode(),
    scheduledStartAt: parseDateTimeLocal(document.getElementById('manualStartTime')?.value || ''),
    auctionPhotoFile: document.getElementById('auctionPhotoFile')?.files?.[0] || null,
    paymentReceiptFile: document.getElementById('paymentReceiptFile')?.files?.[0] || null,
    paymentTxnId: String(document.getElementById('paymentTxnId')?.value || '').trim(),
    paymentPayerName: String(document.getElementById('paymentPayerName')?.value || '').trim()
  };
}

function updateManualPaymentUi() {
  const summary = getManualPaymentSummary();
  const planEl = document.getElementById('paymentPlanSummary');
  const statusEl = document.getElementById('paymentRequestStatus');
  const submitBtn = document.getElementById('submitPaymentRequestBtn');
  const amountText = summary.plan.amount === 0
    ? 'Free'
    : `₹${summary.plan.amount}${summary.plan.tierTeams ? ` / up to ${summary.plan.tierTeams} teams` : ''}`;

  if (planEl) {
    planEl.value = `${summary.teamCount} teams → ${summary.plan.label} (${amountText})`;
  }
  if (submitBtn) {
    submitBtn.disabled = !summary.teamCount;
    submitBtn.textContent = summary.plan.amount === 0 ? 'No payment needed' : 'Submit Payment Request';
  }
  if (statusEl && !getManualPaymentRequestId()) {
    statusEl.textContent = summary.plan.amount === 0
      ? 'This setup is free. You can create the auction room directly.'
      : 'No payment request submitted yet.';
  }
}

async function refreshManualPaymentStatus() {
  updateManualPaymentUi();
  const requestId = getManualPaymentRequestId();
  const statusEl = document.getElementById('paymentRequestStatus');
  const createBtn = document.getElementById('createManualRoomBtn');

  if (!requestId) {
    if (createBtn) createBtn.disabled = false;
    return;
  }

  try {
    const snap = await db.ref(`paymentRequests/${requestId}`).get();
    if (!snap.exists()) {
      if (statusEl) statusEl.textContent = 'Payment request not found. Submit a fresh request.';
      if (createBtn) createBtn.disabled = true;
      return;
    }

    const request = snap.val() || {};
    setManualPaymentCachedRequest(requestId, request);
    renderManualPaymentStatus(request);
  } catch (error) {
    console.error('Failed to refresh payment status:', error);
    const cachedRequest = getManualPaymentCachedRequest(requestId);
    if (cachedRequest) {
      renderManualPaymentStatus(cachedRequest);
      return;
    }
    if (statusEl) statusEl.textContent = 'Could not fetch payment status. Try again.';
  }
}

async function submitManualPaymentRequest() {
  const errEl = document.getElementById('manualSetupError');
  if (errEl) errEl.style.display = 'none';

  if (typeof waitForAuthReady === 'function') {
    await waitForAuthReady();
  }

  const currentUser = typeof getCurrentAuthUser === 'function' ? getCurrentAuthUser() : null;
  if (!currentUser?.uid) {
    return showManualSetupError('Please login again before submitting payment.');
  }

  const summary = getManualPaymentSummary();
  if (!summary.passcode) return showManualSetupError('Room passcode is required.');
  if (summary.teams.length < 2) return showManualSetupError('Add at least 2 teams before submitting payment.');
  if (summary.players.length < 1) return showManualSetupError('Add at least 1 player before submitting payment.');

  if (summary.plan.amount === 0) {
    setManualPaymentRequestId('');
    const statusEl = document.getElementById('paymentRequestStatus');
    if (statusEl) statusEl.textContent = 'This setup is free. You can create the auction room directly.';
    showToast('No payment is needed for this plan.', 'success');
    return;
  }

  const requestId = `pay_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const submitBtn = document.getElementById('submitPaymentRequestBtn');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';
  }

  try {
    let receiptUrl = '';
    if (summary.paymentReceiptFile) {
      receiptUrl = await uploadFileToCloudinary(summary.paymentReceiptFile, {
        roomCode: requestId,
        entityType: 'player',
        entityId: 'payment-receipt',
        fileName: summary.paymentReceiptFile.name || 'payment-receipt',
        sharedAssetKey: getFileAssetKey(summary.paymentReceiptFile, 'payment-receipt')
      });
    }

    await db.ref(`paymentRequests/${requestId}`).set({
      requestId,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      auctionTitle: summary.auctionTitle,
      passcode: summary.passcode,
      teamCount: summary.teamCount,
      amount: summary.plan.amount,
      pricingTierTeams: summary.plan.tierTeams || null,
      budget: summary.budget,
      maxSquadSize: summary.maxSquadSize,
      minSquadSize: summary.minSquadSize,
      timerSeconds: summary.timerUnlimited ? 0 : summary.timerSeconds,
      timerUnlimited: summary.timerUnlimited,
      bidOptions: summary.bidOptions,
      iconPlayerPrice: summary.iconPlayerPrice,
      maxIconPlayers: summary.maxIconPlayers,
      hostRoleMode: summary.hostRoleMode,
      scheduledStartAt: summary.scheduledStartAt || 0,
      paymentTxnId: summary.paymentTxnId,
      paymentPayerName: summary.paymentPayerName,
      receiptUrl,
      teamNames: summary.teams.map(t => t.name).filter(Boolean),
      playerNames: summary.players.map(p => p.name).filter(Boolean),
      submittedByUid: getAuthUid(),
      submittedByName: String(localStorage.getItem('ipl_auth_name') || '').trim()
    });

    setManualPaymentRequestId(requestId);
    setManualPaymentCachedRequest(requestId, {
      requestId,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      auctionTitle: summary.auctionTitle,
      passcode: summary.passcode,
      teamCount: summary.teamCount,
      amount: summary.plan.amount,
      pricingTierTeams: summary.plan.tierTeams || null,
      budget: summary.budget,
      maxSquadSize: summary.maxSquadSize,
      minSquadSize: summary.minSquadSize,
      timerSeconds: summary.timerUnlimited ? 0 : summary.timerSeconds,
      timerUnlimited: summary.timerUnlimited,
      bidOptions: summary.bidOptions,
      iconPlayerPrice: summary.iconPlayerPrice,
      maxIconPlayers: summary.maxIconPlayers,
      hostRoleMode: summary.hostRoleMode,
      scheduledStartAt: summary.scheduledStartAt || 0,
      paymentTxnId: summary.paymentTxnId,
      paymentPayerName: summary.paymentPayerName,
      receiptUrl,
      teamNames: summary.teams.map(t => t.name).filter(Boolean),
      playerNames: summary.players.map(p => p.name).filter(Boolean),
      submittedByUid: getAuthUid(),
      submittedByName: String(localStorage.getItem('ipl_auth_name') || '').trim()
    });
    const statusEl = document.getElementById('paymentRequestStatus');
    if (statusEl) {
      statusEl.textContent = `Submitted. Request ID: ${requestId}. Waiting for admin approval.`;
    }
    showToast('Payment request submitted.', 'success');
  } catch (error) {
    console.error('Payment request submission failed:', error);
    showManualSetupError(error?.message || 'Failed to submit payment request.');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit Payment Request';
    }
  }
}

function showManualSetupError(message) {
  const errEl = document.getElementById('manualSetupError');
  if (!errEl) return;
  errEl.textContent = message;
  errEl.style.display = 'block';
}

async function createManualRoom() {
  const errEl = document.getElementById('manualSetupError');
  errEl.style.display = 'none';

  if (typeof waitForAuthReady === 'function') {
    await waitForAuthReady();
  }

  const currentUser = typeof getCurrentAuthUser === 'function' ? getCurrentAuthUser() : null;
  if (!currentUser?.uid) {
    return showError('Please login again before creating the room.');
  }
  const authUid = typeof getAuthUid === 'function'
    ? getAuthUid()
    : String(localStorage.getItem('ipl_auth_uid') || '').trim();

  const hostLabel = 'Host';
  const passcode = document.getElementById('invitePasscode').value.trim();
  const auctionTitleInput = document.getElementById('auctionTitle');
  const auctionTitle = String(auctionTitleInput?.value || '').trim().slice(0, 40) || 'My Auction';
  const budget = Number(document.getElementById('budgetLakh').value || 0);
  const maxSquadSize = Number(document.getElementById('maxSquadSize').value || 0);
  const minSquadSize = Number(document.getElementById('minSquadSize').value || 0);
  const timerSeconds = Number(document.getElementById('timerSeconds').value || 0);
  const timerUnlimited = !!document.getElementById('timerUnlimited')?.checked;
  const bidOptions = parseBidOptions();
  const iconPlayerPrice = Number(document.getElementById('iconPlayerPrice').value || 0);
  const maxIconPlayers = Number(document.getElementById('maxIconPlayers').value || 0);
  const hostRoleMode = getSelectedHostRoleMode();
  const hostManagerOnly = hostRoleMode !== 'playing';
  const hostBidsForAllTeams = hostRoleMode === 'paddle';
  const scheduledStartAt = parseDateTimeLocal(document.getElementById('manualStartTime')?.value || '');
  const auctionPhotoFile = document.getElementById('auctionPhotoFile')?.files?.[0] || null;

  const teams = collectTeams(true);
  const players = collectPlayers();
  const hostTeamId = document.getElementById('hostTeamSelect').value;
  const paymentPlan = getManualAuctionPlan(teams.length);
  const paymentRequestId = getManualPaymentRequestId();

  if (!passcode) return showError('Room passcode is required.');
  if (teams.length < 2) return showError('Add at least 2 teams.');
  if (players.length < 1) return showError('Add at least 1 player.');
  if (budget <= 0) return showError('Purse must be positive.');
  if (maxSquadSize <= 0) return showError('Max players per team must be positive.');
  if (minSquadSize <= 0) return showError('Min players per team must be positive.');
  if (minSquadSize > maxSquadSize) return showError('Min players per team cannot be greater than max players per team.');
  if (iconPlayerPrice < 0) return showError('Icon player fixed price cannot be negative.');
  if (maxIconPlayers < 0) return showError('Max icon players cannot be negative.');
  if (maxIconPlayers > maxSquadSize) return showError('Max icon players cannot exceed max players per team.');
  if (!timerUnlimited && timerSeconds < 5) return showError('Timer must be at least 5 seconds, or enable Unlimited Timer.');
  if (!bidOptions.length) return showError('Add at least one bid option.');
  if (scheduledStartAt && scheduledStartAt < Date.now() - 60 * 1000) return showError('Start time must be in the future.');

  if (paymentPlan.amount > 0) {
    if (!paymentRequestId) return showError('Submit the payment request first and wait for admin approval.');
    const paymentSnap = await db.ref(`paymentRequests/${paymentRequestId}`).get();
    if (!paymentSnap.exists()) return showError('Payment request not found. Please submit it again.');

    const paymentRequest = paymentSnap.val() || {};
    const paymentStatus = String(paymentRequest.status || 'pending').toLowerCase();
    if (Number(paymentRequest.teamCount || 0) !== teams.length || Number(paymentRequest.amount || 0) !== paymentPlan.amount) {
      return showError('Payment request does not match the current team count. Please submit a new request.');
    }
    if (paymentStatus !== 'approved') {
      return showError('Payment is still pending approval. Please wait for the admin dashboard to approve it.');
    }
  }

  // Paddle mode: keep bid UI simple by forcing a single bid button.
  const effectiveBidOptions = hostBidsForAllTeams ? [bidOptions[0]] : bidOptions;

  const hostTeam = hostManagerOnly ? null : teams.find(t => t.id === hostTeamId);
  if (!hostManagerOnly && !hostTeam) return showError('Select host team.');

  const btn = document.getElementById('createManualRoomBtn');
  btn.disabled = true;
  btn.textContent = 'Uploading assets...';
  let failedAssets = [];
  let auctionPhoto = '';

  try {
    const code = await reserveAvailableRoomCode();

    const uploadResult = await uploadManualAssets(code, teams, players, { auctionPhotoFile });
    failedAssets = uploadResult.failedAssets || [];
    auctionPhoto = String(uploadResult.auctionPhoto || '').trim();

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
      player_number: Number(p.player_number || 0) > 0 ? Number(p.player_number) : null,
      name: p.name,
      age: p.age || null,
      category: p.category,
      role: p.role,
      base_price_lakh: p.base_price_lakh,
      country: p.country || 'Manual',
      extraFields: p.extraFields || {},
      photo_url: p.photo_url || null
    }));

    const baseQueue = finalPlayers.map(p => p.id);
    const playerQueue = typeof shuffleArray === 'function'
      ? shuffleArray(baseQueue)
      : [...baseQueue].sort(() => Math.random() - 0.5);

    btn.textContent = 'Creating room...';

    const initialTeams = {};
    if (hostBidsForAllTeams) {
      // Paddle mode: initialize all teams immediately so captains don't need to join.
      teams.forEach((t) => {
        initialTeams[t.id] = {
          name: t.name,
          short: t.short,
          primary: t.primary,
          logo: t.logo || '',
          ownerName: hostLabel,
          ownerUid: authUid || null,
          purse: budget,
          squad: [],
          isHost: false,
          joinedAt: Date.now()
        };
      });
    } else if (hostTeam) {
      initialTeams[hostTeam.id] = {
        name: hostTeam.name,
        short: hostTeam.short,
        primary: hostTeam.primary,
        logo: hostTeam.logo || '',
        ownerName: hostLabel,
        ownerUid: authUid || null,
        purse: budget,
        squad: [],
        isHost: true,
        joinedAt: Date.now()
      };
    }

    await db.ref(`rooms/${code}`).set({
      config: {
        auctionType: 'manual',
        auctionTitle,
        hostUid: authUid || null,
        currentHostUid: authUid || null,
        hostTeamId: hostTeam ? hostTeam.id : null,
        hostManagerOnly,
        hostBidsForAllTeams,
        bidOptionsAll: bidOptions,
        budget,
        maxSquadSize,
        minSquadSize,
        timerSeconds: timerUnlimited ? 0 : timerSeconds,
        timerMode: timerUnlimited ? 'unlimited' : 'countdown',
        unlimitedTimer: timerUnlimited,
        bidOptions: effectiveBidOptions,
        iconPlayerPrice,
        maxIconPlayers,
        manualPlayerFields: customPlayerFields,
        auctionMode: 'manual',
        auctionPhoto,
        invitePasscode: passcode,
        status: 'lobby',
        createdAt: Date.now(),
        scheduledStartAt: scheduledStartAt || 0
      },
      manualTeams,
      manualPlayers: finalPlayers,
      teams: initialTeams,
      playerQueue
    });

    if (authUid) {
      await db.ref(`users/${authUid}/auctionHistory/${code}`).update({
        roomCode: code,
        title: auctionTitle,
        status: 'lobby',
        auctionType: 'manual',
        hostTeamId: hostTeam ? hostTeam.id : null,
        hostName: hostLabel,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        scheduledStartAt: scheduledStartAt || 0
      });
    }

    saveSession({
      roomCode: code,
      teamId: hostTeam ? hostTeam.id : null,
      playerName: hostLabel,
      isHost: true,
      isSpectator: hostManagerOnly
    });

    if (paymentRequestId) {
      await db.ref(`paymentRequests/${paymentRequestId}`).update({
        status: 'used',
        usedAt: Date.now(),
        roomCode: code,
        updatedAt: Date.now()
      }).catch(() => {});
      setManualPaymentRequestId('');
    }

    window.location.href = 'lobby.html';
  } catch (err) {
    console.error(err);
    showError(err.message || 'Failed to create manual room.');
    btn.disabled = false;
    btn.textContent = 'Create Manual Auction Room';
  }

  if (failedAssets.length > 0) {
    console.warn('Some manual assets failed to upload:', failedAssets);
  }

  function showError(message) {
    errEl.textContent = message;
    errEl.style.display = 'block';
  }
}

window.toggleHostManagerOnly = toggleHostManagerOnly;
window.toggleHostBidsForAllTeams = toggleHostBidsForAllTeams;
window.toggleHostRoleMode = toggleHostRoleMode;
