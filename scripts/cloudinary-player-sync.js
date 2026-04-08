const fs = require('fs');
const path = require('path');
const cloudinary = require('cloudinary').v2;

const ROOT = path.resolve(__dirname, '..');
const PLAYERS_FILE = path.join(ROOT, 'players.json');
const LOCAL_ENV_FILE = path.join(ROOT, '.env.local');
const LOCAL_ENV_FALLBACK_FILE = path.join(ROOT, '.env.local.example');
const DEFAULT_IMAGES_DIR = path.join(ROOT, 'assets', 'player-images');
const SUPPORTED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.avif'];
const ESPN_DEFAULT_PLAYER_IMAGE = 'https://a.espncdn.com/i/headshots/cricket/players/default-player-logo-500.png';

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

function getNameTokens(value) {
  return normalizeName(value).split(' ').filter(Boolean);
}

function uniqueArray(values) {
  return [...new Set(values.filter(Boolean))];
}

function buildQueryVariants(playerName) {
  const tokens = getNameTokens(playerName);
  if (!tokens.length) return [playerName];

  const variants = [tokens.join(' ')];

  const nonInitialTokens = tokens.filter((t) => t.length > 1);
  if (nonInitialTokens.length && nonInitialTokens.length !== tokens.length) {
    variants.push(nonInitialTokens.join(' '));
  }

  if (tokens.length >= 2) {
    variants.push(tokens.slice(-2).join(' '));
    variants.push(tokens[0] + ' ' + tokens[tokens.length - 1]);
  }

  // Common cricket data variations for initial-based names.
  const aliases = {
    't natarajan': ['natarajan', 'thangarasu natarajan'],
    'ks bharat': ['bharat', 'srikar bharat'],
    'ravisrinivasan sai kishore': ['sai kishore', 'r sai kishore'],
    'narayan jagadeesan': ['jagadeesan', 'n jagadeesan'],
    'arjun tendulkar': ['tendulkar'],
    'ben duckett': ['ben matthew duckett']
  };
  const normalized = tokens.join(' ');
  if (aliases[normalized]) {
    variants.push(...aliases[normalized]);
  }

  // Last-name query often finds player/article data when full name misses.
  variants.push(tokens[tokens.length - 1]);
  return uniqueArray(variants);
}

function isLikelyPlayerImageForName(imageObj, playerName) {
  if (!imageObj || !imageObj.url) return false;
  const text = [imageObj.caption, imageObj.name, imageObj.alt]
    .map((v) => normalizeName(v || ''))
    .join(' ')
    .trim();
  if (!text) return false;

  const tokens = getNameTokens(playerName);
  if (!tokens.length) return false;

  const surname = tokens[tokens.length - 1];
  const full = tokens.join(' ');
  if (text.includes(full)) return true;
  if (surname && surname.length >= 4 && text.includes(surname)) return true;

  // Fallback: if at least one strong token appears, still accept.
  const strongTokens = tokens.filter((t) => t.length >= 5);
  if (strongTokens.some((t) => text.includes(t))) return true;

  return false;
}

function chooseBestArticleImage(article, playerName) {
  const images = Array.isArray(article?.images) ? article.images : [];
  const candidates = [];

  for (const img of images) {
    if (!img || !img.url) continue;
    if (isLikelyPlayerImageForName(img, playerName)) candidates.push(img);
    const peers = Array.isArray(img.peers) ? img.peers : [];
    for (const p of peers) {
      if (p?.url && isLikelyPlayerImageForName(p, playerName)) candidates.push(p);
    }
  }

  if (!candidates.length) return null;

  // Prefer square/portrait-ish variants for avatar quality.
  candidates.sort((a, b) => {
    const arA = (a.width && a.height) ? Math.abs((a.width / a.height) - 1) : 10;
    const arB = (b.width && b.height) ? Math.abs((b.width / b.height) - 1) : 10;
    const pxA = Number(a.width || 0) * Number(a.height || 0);
    const pxB = Number(b.width || 0) * Number(b.height || 0);
    if (arA !== arB) return arA - arB;
    return pxB - pxA;
  });

  return candidates[0].url || null;
}

async function resolveEspnImage(playerName) {
  const variants = buildQueryVariants(playerName);

  for (const queryValue of variants) {
    const query = encodeURIComponent(queryValue);
    const searchUrl = `https://site.api.espn.com/apis/search/v2?query=${query}`;
    const payload = await fetchJson(searchUrl);
    const playerBlock = (payload?.results || []).find((r) => r?.type === 'player');
    const candidates = playerBlock?.contents || [];

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

    let bestEffortPlayerImage = '';
    for (const candidate of ranked) {
      const image = candidate?.image?.default || candidate?.image?.defaultDark || '';
      if (!image) continue;
      if (!bestEffortPlayerImage) bestEffortPlayerImage = image;
      const ok = await isUrlReachable(image);
      if (ok) return image;
    }

    const articleBlock = (payload?.results || []).find((r) => r?.type === 'article');
    const articles = Array.isArray(articleBlock?.contents) ? articleBlock.contents : [];
    for (const article of articles) {
      const fallbackUrl = chooseBestArticleImage(article, playerName);
      if (!fallbackUrl) continue;
      const ok = await isUrlReachable(fallbackUrl);
      if (ok) return fallbackUrl;
    }

    // Some ESPN CDN player headshots fail precheck but still upload via Cloudinary fetch.
    if (bestEffortPlayerImage) return bestEffortPlayerImage;
  }

  return null;
}

function extractAthleteIdFromUid(uid) {
  const match = String(uid || '').match(/~a:(\d+)/);
  return match ? match[1] : '';
}

async function resolveEspnAthleteId(playerName) {
  const variants = buildQueryVariants(playerName);
  const target = normalizeName(playerName);

  for (const queryValue of variants) {
    const query = encodeURIComponent(queryValue);
    const searchUrl = `https://site.api.espn.com/apis/search/v2?query=${query}`;
    const payload = await fetchJson(searchUrl);
    const playerBlock = (payload?.results || []).find((r) => r?.type === 'player');
    const candidates = playerBlock?.contents || [];
    if (!candidates.length) continue;

    const exact = candidates.find((item) => normalizeName(item?.displayName || '') === target);
    const preferred = exact || candidates.find((item) => String(item?.description || '').toLowerCase().includes('cricket')) || candidates[0];
    const id = extractAthleteIdFromUid(preferred?.uid);
    if (id) return id;
  }

  return '';
}

async function resolveEspnAthleteFallbackImage(playerName) {
  const athleteId = await resolveEspnAthleteId(playerName);
  if (!athleteId) return null;

  const athleteUrl = `https://site.api.espn.com/apis/common/v3/sports/cricket/athletes/${athleteId}`;
  const payload = await fetchJson(athleteUrl);
  const serialized = JSON.stringify(payload);
    const imageUrlRegex = new RegExp('https:\\/\\/[^\"\\s]+\\.(jpg|jpeg|png|webp)', 'g');
    const matches = serialized.match(imageUrlRegex) || [];
  const urls = uniqueArray(matches.map((raw) => raw.replace(/\\\\\//g, '/')));

  const filtered = urls.filter((u) => {
    if (u.includes('/headshots/')) return false;
    if (u.includes('/teamlogos/')) return false;
    if (u.includes('default-player-logo')) return false;
    return true;
  });

  filtered.sort((a, b) => {
    const score = (url) => {
      let s = 0;
      if (url.includes('/i/cricket/cricinfo/')) s += 40;
      if (url.includes('media.video-cdn.espn.com/images/')) s += 25;
      if (url.includes('/media/motion/')) s += 20;
      if (url.includes('_1x1')) s += 15;
      if (url.includes('_900x') || url.includes('_1296x')) s += 8;
      return s;
    };
    return score(b) - score(a);
  });

  for (const url of filtered) {
    const ok = await isUrlReachable(url);
    if (ok) return url;
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
  let defaultFallbackCount = 0;
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
        try {
          photoUrl = await uploadRemotePlayerImage(remoteUrl, folderArg, slug);
        } catch (uploadError) {
          let fallbackUrl = await resolveEspnAthleteFallbackImage(player.name);
          if (!fallbackUrl) fallbackUrl = ESPN_DEFAULT_PLAYER_IMAGE;
          photoUrl = await uploadRemotePlayerImage(fallbackUrl, folderArg, slug);
          if (fallbackUrl === ESPN_DEFAULT_PLAYER_IMAGE) {
            defaultFallbackCount += 1;
          }
        }
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
  console.log('Default fallback :', defaultFallbackCount);
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
