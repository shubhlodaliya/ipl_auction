const fs = require('fs');
const path = require('path');
const cloudinary = require('cloudinary').v2;

const ROOT = path.resolve(__dirname, '..');
const PLAYERS_FILE = path.join(ROOT, 'players.json');
const LOCAL_ENV_FILE = path.join(ROOT, '.env.local');
const LOCAL_ENV_FALLBACK_FILE = path.join(ROOT, '.env.local.example');
const DEFAULT_IMAGES_DIR = path.join(ROOT, 'assets', 'player-images');
const SUPPORTED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.avif'];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function loadLocalEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, 'utf8');
  raw.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) return;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim().replace(/^['\"]|['\"]$/g, '');
    if (!process.env[key]) process.env[key] = value;
  });
}

function getArgValue(flag, fallback = '') {
  const hit = process.argv.find((arg) => arg.startsWith(flag + '='));
  if (!hit) return fallback;
  return hit.slice(flag.length + 1).trim();
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function slugifyName(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function findLocalImage(imagesDir, slug) {
  for (const ext of SUPPORTED_EXTENSIONS) {
    const full = path.join(imagesDir, slug + ext);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function ensureEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    throw new Error('Missing environment variable: ' + name);
  }
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'ipl-auction-player-image-sync/1.0',
      'Accept': 'application/json'
    }
  });
  if (!response.ok) {
    throw new Error('HTTP ' + response.status + ' for ' + url);
  }
  return response.json();
}

async function isUrlReachable(url) {
  if (!url) return false;
  try {
    const head = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': 'ipl-auction-player-image-sync/1.0' }
    });
    if (head.ok) return true;
  } catch (_) {
    // Ignore and try GET fallback.
  }

  try {
    const getResp = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'ipl-auction-player-image-sync/1.0' }
    });
    return getResp.ok;
  } catch (_) {
    return false;
  }
}

function normalizeName(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function resolveEspnImage(playerName) {
  const query = encodeURIComponent(playerName);
  const searchUrl = `https://site.api.espn.com/apis/search/v2?query=${query}`;
  const payload = await fetchJson(searchUrl);
  const playerBlock = (payload?.results || []).find((r) => r?.type === 'player');
  const candidates = playerBlock?.contents || [];
  if (!candidates.length) return null;

  const target = normalizeName(playerName);
  const exact = candidates.find((item) => {
    const n = normalizeName(item?.displayName || '');
    return n === target;
  });

  const ranked = [
    ...(exact ? [exact] : []),
    ...candidates.filter((item) => item !== exact && String(item?.description || '').toLowerCase().includes('cricket')),
    ...candidates.filter((item) => item !== exact && !String(item?.description || '').toLowerCase().includes('cricket'))
  ];

  for (const candidate of ranked) {
    const image = candidate?.image?.default || candidate?.image?.defaultDark || '';
    if (!image) continue;
    const ok = await isUrlReachable(image);
    if (ok) return image;
  }

  return null;
}

function makeTransformedUrl(publicId) {
  return cloudinary.url(publicId, {
    secure: true,
    transformation: [
      {
        fetch_format: 'auto',
        quality: 'auto',
        width: 520,
        height: 620,
        crop: 'fill',
        gravity: 'face'
      }
    ]
  });
}

async function uploadPlayerImage(localFilePath, folder, slug) {
  const publicId = folder + '/' + slug;
  await cloudinary.uploader.upload(localFilePath, {
    public_id: publicId,
    overwrite: true,
    resource_type: 'image'
  });
  return makeTransformedUrl(publicId);
}

async function uploadRemotePlayerImage(remoteUrl, folder, slug) {
  const publicId = folder + '/' + slug;
  await cloudinary.uploader.upload(remoteUrl, {
    public_id: publicId,
    overwrite: true,
    resource_type: 'image'
  });
  return makeTransformedUrl(publicId);
}

async function main() {
  loadLocalEnv(LOCAL_ENV_FILE);
  loadLocalEnv(LOCAL_ENV_FALLBACK_FILE);

  const cloudName = ensureEnv('CLOUDINARY_CLOUD_NAME');
  const mapOnly = hasFlag('--map-only');
  const sourceMode = String(getArgValue('--source', 'local')).trim().toLowerCase();
  if (!['local', 'web'].includes(sourceMode)) {
    throw new Error('Invalid --source value. Use local or web.');
  }
  const apiKey = mapOnly ? String(process.env.CLOUDINARY_API_KEY || '').trim() : ensureEnv('CLOUDINARY_API_KEY');
  const apiSecret = mapOnly ? String(process.env.CLOUDINARY_API_SECRET || '').trim() : ensureEnv('CLOUDINARY_API_SECRET');

  const folderArg = getArgValue('--folder', process.env.CLOUDINARY_PLAYER_FOLDER || 'ipl-auction/players');
  const imagesDirArg = getArgValue('--imagesDir', process.env.PLAYER_IMAGES_DIR || DEFAULT_IMAGES_DIR);
  const preserveExisting = !hasFlag('--refresh-existing');
  const delayMs = Number(getArgValue('--delayMs', '180'));

  const imagesDir = path.isAbsolute(imagesDirArg) ? imagesDirArg : path.join(ROOT, imagesDirArg);
  if (!mapOnly && sourceMode === 'local' && !fs.existsSync(imagesDir)) {
    throw new Error('Images directory not found: ' + imagesDir);
  }

  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey || undefined,
    api_secret: apiSecret || undefined,
    secure: true
  });

  const players = readJson(PLAYERS_FILE);
  let uploadedCount = 0;
  let updatedCount = 0;
  let keptExistingCount = 0;
  const missingLocal = [];
  const missingWeb = [];
  const failedUploads = [];

  for (const player of players) {
    const slug = slugifyName(player.name);
    const existing = String(player.photo_url || '').trim();

    if (existing && preserveExisting) {
      keptExistingCount += 1;
      continue;
    }

    if (mapOnly) {
      player.photo_url = makeTransformedUrl(folderArg + '/' + slug);
      updatedCount += 1;
      continue;
    }

    try {
      let photoUrl = '';

      if (sourceMode === 'web') {
        const remoteUrl = await resolveEspnImage(player.name);
        if (!remoteUrl) {
          missingWeb.push(player.name + ' => no ESPN Cricinfo image match');
          continue;
        }
        photoUrl = await uploadRemotePlayerImage(remoteUrl, folderArg, slug);
      } else {
        const localFilePath = findLocalImage(imagesDir, slug);
        if (!localFilePath) {
          missingLocal.push(player.name + ' => ' + slug + '.[jpg|jpeg|png|webp|avif]');
          continue;
        }
        photoUrl = await uploadPlayerImage(localFilePath, folderArg, slug);
      }

      player.photo_url = photoUrl;
      uploadedCount += 1;
      updatedCount += 1;
      console.log('Uploaded:', player.name, '->', slug);
    } catch (error) {
      failedUploads.push(player.name + ' => ' + (error?.message || String(error)));
    }

    if (!mapOnly && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  if (updatedCount > 0) {
    writeJson(PLAYERS_FILE, players);
  }

  console.log('\nPlayer image sync complete');
  console.log('Images directory :', imagesDir);
  console.log('Cloud folder     :', folderArg);
  console.log('Mode             :', mapOnly ? 'map-only' : 'upload-and-map');
  console.log('Source           :', sourceMode);
  console.log('Uploaded         :', uploadedCount);
  console.log('Updated players  :', updatedCount);
  console.log('Kept existing    :', keptExistingCount);
  console.log('Missing local    :', missingLocal.length);
  console.log('Missing web      :', missingWeb.length);
  console.log('Failed uploads   :', failedUploads.length);

  if (missingLocal.length > 0) {
    console.log('\nMissing files list:');
    missingLocal.slice(0, 40).forEach((line) => console.log('-', line));
    if (missingLocal.length > 40) {
      console.log('- ... and', missingLocal.length - 40, 'more');
    }
  }

  if (missingWeb.length > 0) {
    console.log('\nWeb lookup misses:');
    missingWeb.slice(0, 40).forEach((line) => console.log('-', line));
    if (missingWeb.length > 40) {
      console.log('- ... and', missingWeb.length - 40, 'more');
    }
  }

  if (failedUploads.length > 0) {
    console.log('\nUpload failures:');
    failedUploads.slice(0, 40).forEach((line) => console.log('-', line));
    if (failedUploads.length > 40) {
      console.log('- ... and', failedUploads.length - 40, 'more');
    }
  }
}

main().catch((err) => {
  console.error('Sync failed:', err.message || err);
  process.exitCode = 1;
});
