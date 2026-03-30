// ============================================================
// UTILS.JS — Shared constants & helper functions
// ============================================================

const IPL_TEAMS = [
  { id: "mi", name: "Mumbai Indians", short: "MI", primary: "#004BA0", secondary: "#D1AB3E", logo: "assets/team-logos/mi.webp" },
  { id: "csk", name: "Chennai Super Kings", short: "CSK", primary: "#FFCB05", secondary: "#0081E9", logo: "assets/team-logos/csk.png" },
  { id: "rcb", name: "Royal Challengers Bengaluru", short: "RCB", primary: "#EC1C24", secondary: "#1A1A1A", logo: "assets/team-logos/rcb.png" },
  { id: "kkr", name: "Kolkata Knight Riders", short: "KKR", primary: "#2D0080", secondary: "#B3A123", logo: "assets/team-logos/kkr.png" },
  { id: "dc", name: "Delhi Capitals", short: "DC", primary: "#004C93", secondary: "#EF1C25", logo: "assets/team-logos/dc.png" },
  { id: "rr", name: "Rajasthan Royals", short: "RR", primary: "#EA1A85", secondary: "#254AA5", logo: "assets/team-logos/rr.png" },
  { id: "pbks", name: "Punjab Kings", short: "PBKS", primary: "#ED1B24", secondary: "#A7A9AC", logo: "assets/team-logos/pbks.png" },
  { id: "srh", name: "Sunrisers Hyderabad", short: "SRH", primary: "#F7A721", secondary: "#1A1A1A", logo: "assets/team-logos/srh.webp" },
  { id: "lsg", name: "Lucknow Super Giants", short: "LSG", primary: "#A72056", secondary: "#FFCD00", logo: "assets/team-logos/lsg.png" },
  { id: "gt", name: "Gujarat Titans", short: "GT", primary: "#1DA462", secondary: "#1C1C1C", logo: "assets/team-logos/gt.png" }
];

function getTeam(teamId) {
  return IPL_TEAMS.find(t => t.id === teamId) || null;
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function getBidIncrement(currentBid) {
  if (currentBid < 50) return 5;
  if (currentBid < 100) return 10;
  if (currentBid < 200) return 25;
  return 50;
}

function getBidJumpOptions(basePriceLakh) {
  if ([150, 200].includes(basePriceLakh)) return [50, 100];
  if ([50, 75, 100].includes(basePriceLakh)) return [25, 50, 100];
  return [25, 50, 100];
}

function formatPrice(lakh) {
  if (!lakh && lakh !== 0) return '—';
  if (lakh >= 100) {
    const cr = lakh / 100;
    return `₹${cr % 1 === 0 ? cr : cr.toFixed(2)}Cr`;
  }
  return `₹${lakh}L`;
}

function getPlayerInitials(name) {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

function getRoleColor(role) {
  const map = {
    'Batsman': '#3B82F6',
    'Bowler': '#EF4444',
    'Fast Bowler': '#EF4444',
    'Spinner': '#14B8A6',
    'All-rounder': '#8B5CF6',
    'Wicket-keeper': '#F59E0B'
  };
  return map[role] || '#6B7280';
}

function getRoleIcon(role) {
  const map = {
    'Batsman': '🏏',
    'Bowler': '⚡',
    'Fast Bowler': '💨',
    'Spinner': '🌀',
    'All-rounder': '⭐',
    'Wicket-keeper': '🧤'
  };
  return map[role] || '🏏';
}

function getCountryFlag(country) {
  const map = {
    'India': '🇮🇳', 'Australia': '🇦🇺', 'England': '🏴󠁧󠁢󠁥󠁮󠁧󠁿',
    'South Africa': '🇿🇦', 'West Indies': '🏝️', 'New Zealand': '🇳🇿',
    'Sri Lanka': '🇱🇰', 'Pakistan': '🇵🇰', 'Afghanistan': '🇦🇫',
    'Bangladesh': '🇧🇩', 'Zimbabwe': '🇿🇼'
  };
  return map[country] || '🌍';
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function loadPlayers() {
  const res = await fetch('./players.json');
  return await res.json();
}

// LocalStorage helpers
function saveSession(data) {
  sessionStorage.setItem('ipl_session', JSON.stringify(data));
}

function getSession() {
  try {
    return JSON.parse(sessionStorage.getItem('ipl_session')) || null;
  } catch { return null; }
}

function clearSession() {
  sessionStorage.removeItem('ipl_session');
}

// Redirect guard — call on pages that need a session
function requireSession(redirectTo = 'index.html') {
  const s = getSession();
  if (!s || !s.roomCode) {
    window.location.href = redirectTo;
    return null;
  }
  return s;
}

function buildInviteUrl(roomCode, passcode = null, includePasscode = false) {
  const url = new URL(window.location.origin + window.location.pathname.replace(/[^/]+$/, 'index.html'));
  url.searchParams.set('room', roomCode);
  if (includePasscode && passcode) {
    url.searchParams.set('passcode', passcode);
  }
  return url.toString();
}
