const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PLAYERS_FILE = path.join(ROOT, 'players.json');
const SEARCH_API = 'https://site.api.espn.com/apis/search/v2?query=';
const ESPN_DEFAULT_HEADSHOT = 'https://a.espncdn.com/i/headshots/cricket/players/default-player-logo-500.png';

const FORCED_HEADSHOT_OVERRIDES = {
  'David Miller': 'https://a.espncdn.com/i/headshots/cricket/players/full/321777.png',
  'Matthew Wade': 'https://a.espncdn.com/i/headshots/cricket/players/full/230193.png',
  'Mark Wood': 'https://a.espncdn.com/i/headshots/cricket/players/full/351588.png',
  'Chris Jordan': 'https://a.espncdn.com/i/headshots/cricket/players/full/288992.png',
  'Sean Williams': 'https://a.espncdn.com/i/headshots/cricket/players/full/55870.png',
  'Brandon King': 'https://a.espncdn.com/i/headshots/cricket/players/full/670035.png'
};

const FORCE_DEFAULT_FOR = new Set([
  'Will Jacks',
  "Will O'Rourke",
  'Jamie Smith',
  'Harpreet Bhatia'
]);

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

    if (FORCE_DEFAULT_FOR.has(player.name)) {
      if (player.photo_url !== ESPN_DEFAULT_HEADSHOT) {
        player.photo_url = ESPN_DEFAULT_HEADSHOT;
        updated += 1;
        console.log('Default headshot fallback:', player.name);
      } else {
        unchanged += 1;
      }
      await delay(20);
      continue;
    }

    const headshot = await resolveHeadshot(player.name);
    if (!headshot) {
      missing.push(player.name);
      await delay(70);
      continue;
    }

    if (player.photo_url === headshot) {
      unchanged += 1;
    } else {
      player.photo_url = headshot;
      updated += 1;
      console.log('Headshot mapped:', player.name);
    }

    await delay(70);
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
