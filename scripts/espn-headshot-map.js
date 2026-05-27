const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PLAYERS_FILE = path.join(ROOT, 'players.json');
const SEARCH_API = 'https://site.api.espn.com/apis/search/v2?query=';
const ESPN_DEFAULT_HEADSHOT = 'https://a.espncdn.com/i/headshots/cricket/players/default-player-logo-500.png';
const CRICBUZZ_SEARCH_API = 'https://www.cricbuzz.com/api/player-search/';
const ESPN_HEADSHOT_REGEX = /https:\/\/a\.espncdn\.com\/i\/headshots\/cricket\/players\/full\/\d+\.png$/i;

const FORCED_HEADSHOT_OVERRIDES = {
  'David Miller': 'https://a.espncdn.com/i/headshots/cricket/players/full/321777.png',
  'Matthew Wade': 'https://a.espncdn.com/i/headshots/cricket/players/full/230193.png',
  'Mark Wood': 'https://a.espncdn.com/i/headshots/cricket/players/full/351588.png',
  'Chris Jordan': 'https://a.espncdn.com/i/headshots/cricket/players/full/288992.png',
  'Sean Williams': 'https://a.espncdn.com/i/headshots/cricket/players/full/55870.png',
  'Brandon King': 'https://a.espncdn.com/i/headshots/cricket/players/full/670035.png'
};

const CRICBUZZ_MANUAL_OVERRIDES = {
  'Will Jacks': 'https://static.cricbuzz.com/a/img/v1/192x192/i1/c848529/will-jacks.jpg',
  "Will O'Rourke": 'https://static.cricbuzz.com/a/img/v1/192x192/i1/c616423/william-orourke.jpg',
  'Jamie Smith': 'https://static.cricbuzz.com/a/img/v1/192x192/i1/c717789/jamie-smith.jpg',
  'Harpreet Bhatia': 'https://static.cricbuzz.com/a/img/v1/192x192/i1/c153367/harpreet-singh-bhatia.jpg'
};

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
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

function isDefaultHeadshot(url) {
  return String(url || '').includes('default-player-logo-500.png');
}

function isValidEspnHeadshot(url) {
  return ESPN_HEADSHOT_REGEX.test(String(url || '').trim());
}

function slugify(value) {
  return normalizeName(value).replace(/\s+/g, '-');
}

function buildQueryVariants(playerName) {
  const tokens = getNameTokens(playerName);
  if (!tokens.length) return [playerName];

  const variants = [tokens.join(' ')];
  if (tokens.length >= 2) {
    variants.push(tokens.slice(-2).join(' '));
    variants.push(tokens[0] + ' ' + tokens[tokens.length - 1]);
  }

  const nonInitial = tokens.filter((t) => t.length > 1);
  if (nonInitial.length && nonInitial.length !== tokens.length) {
    variants.push(nonInitial.join(' '));
  }

  const aliases = {
    't natarajan': ['natarajan', 'thangarasu natarajan'],
    'ks bharat': ['bharat', 'srikar bharat'],
    'ravisrinivasan sai kishore': ['sai kishore', 'r sai kishore'],
    'narayan jagadeesan': ['jagadeesan', 'n jagadeesan'],
    'arjun tendulkar': ['tendulkar'],
    'ben duckett': ['ben matthew duckett']
  };

  const n = tokens.join(' ');
  if (aliases[n]) variants.push(...aliases[n]);
  variants.push(tokens[tokens.length - 1]);

  return uniqueArray(variants);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchSearch(query) {
  const url = SEARCH_API + encodeURIComponent(query);
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'ipl-auction-espn-headshot-map/1.0',
      'Accept': 'application/json'
    }
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for query ${query}`);
  }
  return response.json();
}

async function fetchCricbuzzSearch(query) {
  const url = CRICBUZZ_SEARCH_API + encodeURIComponent(query);
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'ipl-auction-espn-headshot-map/1.0',
      'Accept': 'application/json'
    }
  });

  if (!response.ok) return [];

  const payload = await response.json();
  return Array.isArray(payload?.player) ? payload.player : [];
}

function rankCricbuzzCandidates(candidates, playerName) {
  const target = normalizeName(playerName);
  const targetTokens = getNameTokens(playerName);
  const targetLast = targetTokens[targetTokens.length - 1] || '';

  return [...candidates].sort((a, b) => {
    const an = normalizeName(a?.name || '');
    const bn = normalizeName(b?.name || '');

    const aExact = an === target ? 1 : 0;
    const bExact = bn === target ? 1 : 0;
    if (aExact !== bExact) return bExact - aExact;

    const aContains = an.includes(target) ? 1 : 0;
    const bContains = bn.includes(target) ? 1 : 0;
    if (aContains !== bContains) return bContains - aContains;

    const aLast = targetLast && an.includes(targetLast) ? 1 : 0;
    const bLast = targetLast && bn.includes(targetLast) ? 1 : 0;
    if (aLast !== bLast) return bLast - aLast;

    const aDelta = Math.abs(an.length - target.length);
    const bDelta = Math.abs(bn.length - target.length);
    return aDelta - bDelta;
  });
}

async function fetchCricbuzzFaceImageId(profileId) {
  try {
    const url = `https://www.cricbuzz.com/profiles/${profileId}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'ipl-auction-espn-headshot-map/1.0',
        'Accept': 'text/html'
      }
    });
    if (!response.ok) return null;

    const html = await response.text();
    const match = html.match(/faceImageId[^0-9]*(\d+)/i);
    return match ? match[1] : null;
  } catch (_) {
    return null;
  }
}

async function resolveCricbuzzPhoto(playerName) {
  if (CRICBUZZ_MANUAL_OVERRIDES[playerName]) {
    return CRICBUZZ_MANUAL_OVERRIDES[playerName];
  }

  const variants = uniqueArray([
    ...buildQueryVariants(playerName),
    normalizeName(playerName),
    getNameTokens(playerName).slice(-1)[0]
  ]);

  for (const q of variants) {
    if (!q || q.length < 2) continue;

    let candidates = [];
    try {
      candidates = await fetchCricbuzzSearch(q);
    } catch (_) {
      candidates = [];
    }
    if (!candidates.length) continue;

    const ranked = rankCricbuzzCandidates(candidates, playerName).slice(0, 4);
    for (const candidate of ranked) {
      const id = candidate?.id;
      if (!id) continue;

      const faceImageId = await fetchCricbuzzFaceImageId(id);
      if (!faceImageId) continue;

      const slug = slugify(candidate?.name || playerName) || slugify(playerName) || 'player';
      const imageUrl = `https://static.cricbuzz.com/a/img/v1/192x192/i1/c${faceImageId}/${slug}.jpg`;

      const ok = await isUrlReachable(imageUrl);
      if (ok) return imageUrl;
    }
  }

  return null;
}

function getPlayerIdFromProfileUrl(url) {
  const match = String(url || '').match(/\/player\/(\d+)\.html$/);
  return match ? match[1] : '';
}

async function isUrlReachable(url) {
  if (!url) return false;
  try {
    const head = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': 'ipl-auction-espn-headshot-map/1.0' }
    });
    if (head.ok) return true;
  } catch (_) {
    // Try GET fallback
  }

  try {
    const getResp = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'ipl-auction-espn-headshot-map/1.0' }
    });
    return getResp.ok;
  } catch (_) {
    return false;
  }
}

function getHeadshotFromPayload(payload, playerName) {
  const playerBlock = (payload?.results || []).find((r) => r?.type === 'player');
  const candidates = playerBlock?.contents || [];
  if (!candidates.length) return null;

  const target = normalizeName(playerName);
  const exact = candidates.find((c) => normalizeName(c?.displayName || '') === target);

  const ranked = [
    ...(exact ? [exact] : []),
    ...candidates.filter((c) => c !== exact && String(c?.description || '').toLowerCase().includes('cricket')),
    ...candidates.filter((c) => c !== exact && !String(c?.description || '').toLowerCase().includes('cricket'))
  ];

  for (const c of ranked) {
    let image = c?.image?.default || c?.image?.defaultDark || '';
    const web = String(c?.link?.web || '');
    if (!image) continue;
    if (!image.includes('/headshots/cricket/players/')) continue;
    if (web && !web.includes('espncricinfo.com')) continue;

    if (image.includes('default-player-logo-500.png')) {
      const id = getPlayerIdFromProfileUrl(web);
      if (id) {
        image = `https://a.espncdn.com/i/headshots/cricket/players/full/${id}.png`;
      }
    }

    return image;
  }

  return null;
}

async function resolveHeadshot(playerName) {
  const variants = buildQueryVariants(playerName);
  for (const q of variants) {
    try {
      const payload = await fetchSearch(q);
      const image = getHeadshotFromPayload(payload, playerName);
      if (image) return image;
    } catch (_) {
      // Continue trying other variants.
    }
  }
  return null;
}

async function main() {
  const players = readJson(PLAYERS_FILE);
  let updated = 0;
  let unchanged = 0;
  const missing = [];

  for (const player of players) {
    if (FORCED_HEADSHOT_OVERRIDES[player.name]) {
      const forced = FORCED_HEADSHOT_OVERRIDES[player.name];
      if (player.photo_url !== forced) {
        player.photo_url = forced;
        updated += 1;
        console.log('Forced headshot:', player.name);
      } else {
        unchanged += 1;
      }
      await delay(20);
      continue;
    }

    if (isValidEspnHeadshot(player.photo_url) && !isDefaultHeadshot(player.photo_url)) {
      unchanged += 1;
      await delay(20);
      continue;
    }

    const headshot = await resolveHeadshot(player.name);
    if (headshot && !isDefaultHeadshot(headshot)) {
      if (player.photo_url === headshot) {
        unchanged += 1;
      } else {
        player.photo_url = headshot;
        updated += 1;
        console.log('Headshot mapped:', player.name);
      }

      await delay(70);
      continue;
    }

    const cricbuzzPhoto = await resolveCricbuzzPhoto(player.name);
    if (cricbuzzPhoto) {
      if (player.photo_url === cricbuzzPhoto) {
        unchanged += 1;
      } else {
        player.photo_url = cricbuzzPhoto;
        updated += 1;
        console.log('Cricbuzz fallback mapped:', player.name);
      }
      await delay(90);
      continue;
    }

    if (isValidEspnHeadshot(player.photo_url) && !isDefaultHeadshot(player.photo_url)) {
      unchanged += 1;
    } else {
      missing.push(player.name);
    }

    await delay(90);
  }

  writeJson(PLAYERS_FILE, players);

  console.log('\nESPN headshot mapping complete');
  console.log('Total players  :', players.length);
  console.log('Updated        :', updated);
  console.log('Unchanged      :', unchanged);
  console.log('Missing        :', missing.length);
  if (missing.length) {
    console.log('\nMissing players:');
    missing.forEach((name) => console.log('-', name));
  }
}

main().catch((err) => {
  console.error('Headshot mapping failed:', err.message || err);
  process.exitCode = 1;
});
