'use strict';

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function average(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const total = values.reduce((sum, v) => sum + toNumber(v), 0);
  return total / values.length;
}

function round1(value) {
  return Number(toNumber(value).toFixed(1));
}

function normalizeRole(role) {
  return String(role || '').trim().toLowerCase();
}

function getImpactRating(player) {
  // Keep compatibility with either impactRating or t20ImpactRating payloads.
  return toNumber(player?.impactRating ?? player?.t20ImpactRating ?? 0);
}

function getPlayerOverallForBench(player) {
  const role = normalizeRole(player?.role);
  const batting = toNumber(player?.battingRating);
  const bowling = toNumber(player?.bowlingRating);
  const experience = toNumber(player?.experienceRating);
  const impact = getImpactRating(player);

  if (role === 'allrounder' || role === 'all-rounder') {
    return (batting * 0.3) + (bowling * 0.3) + (experience * 0.2) + (impact * 0.2);
  }
  if (role === 'bowler') {
    return (batting * 0.15) + (bowling * 0.45) + (experience * 0.2) + (impact * 0.2);
  }
  if (role === 'wicketkeeper' || role === 'wicket keeper') {
    return (batting * 0.4) + (bowling * 0.1) + (experience * 0.2) + (impact * 0.3);
  }

  // Default batsman profile.
  return (batting * 0.5) + (bowling * 0.1) + (experience * 0.2) + (impact * 0.2);
}

function calculateTopOrderScore(playingXI) {
  const topThree = (Array.isArray(playingXI) ? playingXI : []).slice(0, 3);
  return round1(average(topThree.map((p) => toNumber(p?.battingRating))));
}

function calculateMiddleOrderScore(playingXI) {
  const middleThree = (Array.isArray(playingXI) ? playingXI : []).slice(3, 6);
  return round1(average(middleThree.map((p) => toNumber(p?.battingRating))));
}

function calculateFinisherScore(playingXI) {
  const finishers = (Array.isArray(playingXI) ? playingXI : []).slice(5, 8);
  return round1(average(finishers.map((p) => getImpactRating(p))));
}

function isBowlingAllRounder(player) {
  const role = normalizeRole(player?.role);
  if (role !== 'allrounder' && role !== 'all-rounder') return false;
  return toNumber(player?.bowlingRating) >= 55;
}

function calculateBowlingScore(playingXI) {
  const attack = (Array.isArray(playingXI) ? playingXI : []).filter((p) => {
    const role = normalizeRole(p?.role);
    return role === 'bowler' || isBowlingAllRounder(p);
  });

  return round1(average(attack.map((p) => toNumber(p?.bowlingRating))));
}

function calculateAllRounderScore(playingXI) {
  const allRounders = (Array.isArray(playingXI) ? playingXI : []).filter((p) => {
    const role = normalizeRole(p?.role);
    return role === 'allrounder' || role === 'all-rounder';
  });

  return round1(average(allRounders.map((p) => getImpactRating(p))));
}

function calculateTeamBalanceScore(playingXI) {
  const players = Array.isArray(playingXI) ? playingXI : [];

  const counts = players.reduce((acc, p) => {
    const role = normalizeRole(p?.role);
    if (role === 'batsman') acc.batsmen += 1;
    else if (role === 'wicketkeeper' || role === 'wicket keeper') acc.wicketkeepers += 1;
    else if (role === 'allrounder' || role === 'all-rounder') acc.allrounders += 1;
    else if (role === 'bowler') acc.bowlers += 1;
    return acc;
  }, { batsmen: 0, wicketkeepers: 0, allrounders: 0, bowlers: 0 });

  const ideal = {
    batsmen: [4, 5],
    wicketkeepers: [1, 2],
    allrounders: [2, 3],
    bowlers: [3, 4]
  };

  function penaltyForRange(value, min, max) {
    if (value < min) return min - value;
    if (value > max) return value - max;
    return 0;
  }

  const totalPenalty =
    penaltyForRange(counts.batsmen, ideal.batsmen[0], ideal.batsmen[1]) +
    penaltyForRange(counts.wicketkeepers, ideal.wicketkeepers[0], ideal.wicketkeepers[1]) +
    penaltyForRange(counts.allrounders, ideal.allrounders[0], ideal.allrounders[1]) +
    penaltyForRange(counts.bowlers, ideal.bowlers[0], ideal.bowlers[1]);

  // 0 penalty => 10/10. Each deviation point reduces score by 1.5.
  const balanceOutOf10 = clamp(10 - (totalPenalty * 1.5), 0, 10);
  return round1(balanceOutOf10);
}

function calculateMatchWinnerScore(playingXI) {
  const players = Array.isArray(playingXI) ? playingXI : [];
  const winners = players.filter((p) => getImpactRating(p) > 85).length;

  // 4+ elite impact players is considered top-tier.
  const scoreOutOf100 = clamp((winners / 4) * 100, 0, 100);
  return round1(scoreOutOf100);
}

function calculateBenchStrength(benchPlayers) {
  const bench = Array.isArray(benchPlayers) ? benchPlayers : [];
  if (!bench.length) return 0;

  const benchRatings = bench.map((p) => getPlayerOverallForBench(p));
  return round1(average(benchRatings));
}

function calculateTeamPowerScore(team) {
  const playingXI = Array.isArray(team?.playingXI) ? team.playingXI : [];
  const benchPlayers = Array.isArray(team?.benchPlayers) ? team.benchPlayers : [];

  const TOP_ORDER_SCORE = calculateTopOrderScore(playingXI);
  const MIDDLE_ORDER_SCORE = calculateMiddleOrderScore(playingXI);
  const FINISHER_SCORE = calculateFinisherScore(playingXI);
  const BOWLING_SCORE = calculateBowlingScore(playingXI);
  const ALL_ROUNDER_SCORE = calculateAllRounderScore(playingXI);
  const TEAM_BALANCE_SCORE = calculateTeamBalanceScore(playingXI);
  const MATCH_WINNER_SCORE = calculateMatchWinnerScore(playingXI);
  const BENCH_STRENGTH_SCORE = calculateBenchStrength(benchPlayers);

  const battingScore = ((TOP_ORDER_SCORE + MIDDLE_ORDER_SCORE) / 2) * 0.20;
  const finishingScore = FINISHER_SCORE * 0.10;
  const bowlingScore = BOWLING_SCORE * 0.25;
  const allRounderScore = ALL_ROUNDER_SCORE * 0.15;
  const balanceScore = (TEAM_BALANCE_SCORE * 10) * 0.10;
  const matchWinnerScore = MATCH_WINNER_SCORE * 0.10;
  const benchScore = BENCH_STRENGTH_SCORE * 0.10;

  const rawTotal =
    battingScore +
    finishingScore +
    bowlingScore +
    allRounderScore +
    balanceScore +
    matchWinnerScore +
    benchScore;

  const TEAM_POWER_SCORE = round1(clamp(rawTotal, 0, 100));

  return {
    teamName: team?.teamName || 'Unknown Team',
    score: TEAM_POWER_SCORE,
    metrics: {
      TOP_ORDER_SCORE,
      MIDDLE_ORDER_SCORE,
      FINISHER_SCORE,
      BOWLING_SCORE,
      ALL_ROUNDER_SCORE,
      TEAM_BALANCE_SCORE,
      MATCH_WINNER_SCORE,
      BENCH_STRENGTH_SCORE
    },
    weighted: {
      battingScore: round1(battingScore),
      finishingScore: round1(finishingScore),
      bowlingScore: round1(bowlingScore),
      allRounderScore: round1(allRounderScore),
      balanceScore: round1(balanceScore),
      matchWinnerScore: round1(matchWinnerScore),
      benchScore: round1(benchScore)
    }
  };
}

function rankTeams(teams) {
  const inputTeams = Array.isArray(teams) ? teams : [];
  const scored = inputTeams.map((team) => calculateTeamPowerScore(team));

  scored.sort((a, b) => b.score - a.score);

  const rankings = scored.map((entry, idx) => ({
    rank: idx + 1,
    team: entry.teamName,
    score: entry.score
  }));

  const bestBattingTeam = scored
    .slice()
    .sort((a, b) => ((b.metrics.TOP_ORDER_SCORE + b.metrics.MIDDLE_ORDER_SCORE + b.metrics.FINISHER_SCORE) - (a.metrics.TOP_ORDER_SCORE + a.metrics.MIDDLE_ORDER_SCORE + a.metrics.FINISHER_SCORE)))[0]?.teamName || null;

  const bestBowlingTeam = scored
    .slice()
    .sort((a, b) => b.metrics.BOWLING_SCORE - a.metrics.BOWLING_SCORE)[0]?.teamName || null;

  const bestBenchStrength = scored
    .slice()
    .sort((a, b) => b.metrics.BENCH_STRENGTH_SCORE - a.metrics.BENCH_STRENGTH_SCORE)[0]?.teamName || null;

  const darkHorsePool = scored.filter((_, idx) => idx >= 2);
  const darkHorseSource = darkHorsePool.length ? darkHorsePool : scored;
  const darkHorseTeam = darkHorseSource
    .slice()
    .sort((a, b) => {
      const aDark = (a.metrics.BENCH_STRENGTH_SCORE * 0.35) + (a.metrics.ALL_ROUNDER_SCORE * 0.25) + ((a.metrics.TEAM_BALANCE_SCORE * 10) * 0.20) + (a.metrics.MATCH_WINNER_SCORE * 0.20);
      const bDark = (b.metrics.BENCH_STRENGTH_SCORE * 0.35) + (b.metrics.ALL_ROUNDER_SCORE * 0.25) + ((b.metrics.TEAM_BALANCE_SCORE * 10) * 0.20) + (b.metrics.MATCH_WINNER_SCORE * 0.20);
      return bDark - aDark;
    })[0]?.teamName || null;

  return {
    rankings,
    bestBattingTeam,
    bestBowlingTeam,
    bestBenchStrength,
    darkHorseTeam,
    teamBreakdowns: scored
  };
}

const exampleTeams = [
  {
    teamName: 'Chennai Super Kings',
    playingXI: [
      { name: 'Ruturaj Gaikwad', role: 'batsman', battingRating: 88, bowlingRating: 8, experienceRating: 82, t20ImpactRating: 86 },
      { name: 'Devon Conway', role: 'batsman', battingRating: 86, bowlingRating: 6, experienceRating: 78, t20ImpactRating: 84 },
      { name: 'Ajinkya Rahane', role: 'batsman', battingRating: 80, bowlingRating: 10, experienceRating: 90, t20ImpactRating: 78 },
      { name: 'Daryl Mitchell', role: 'allrounder', battingRating: 79, bowlingRating: 70, experienceRating: 80, t20ImpactRating: 82 },
      { name: 'Shivam Dube', role: 'allrounder', battingRating: 83, bowlingRating: 48, experienceRating: 75, t20ImpactRating: 87 },
      { name: 'Ravindra Jadeja', role: 'allrounder', battingRating: 81, bowlingRating: 89, experienceRating: 95, t20ImpactRating: 91 },
      { name: 'MS Dhoni', role: 'wicketkeeper', battingRating: 74, bowlingRating: 4, experienceRating: 99, t20ImpactRating: 88 },
      { name: 'Deepak Chahar', role: 'bowler', battingRating: 36, bowlingRating: 84, experienceRating: 82, t20ImpactRating: 79 },
      { name: 'Matheesha Pathirana', role: 'bowler', battingRating: 24, bowlingRating: 90, experienceRating: 72, t20ImpactRating: 89 },
      { name: 'Maheesh Theekshana', role: 'bowler', battingRating: 26, bowlingRating: 83, experienceRating: 76, t20ImpactRating: 80 },
      { name: 'Tushar Deshpande', role: 'bowler', battingRating: 22, bowlingRating: 76, experienceRating: 68, t20ImpactRating: 73 }
    ],
    benchPlayers: [
      { name: 'Moeen Ali', role: 'allrounder', battingRating: 80, bowlingRating: 78, experienceRating: 90, t20ImpactRating: 85 },
      { name: 'Shardul Thakur', role: 'bowler', battingRating: 45, bowlingRating: 77, experienceRating: 84, t20ImpactRating: 79 },
      { name: 'Rachin Ravindra', role: 'allrounder', battingRating: 78, bowlingRating: 66, experienceRating: 72, t20ImpactRating: 82 }
    ]
  },
  {
    teamName: 'Mumbai Indians',
    playingXI: [
      { name: 'Rohit Sharma', role: 'batsman', battingRating: 89, bowlingRating: 7, experienceRating: 97, t20ImpactRating: 90 },
      { name: 'Ishan Kishan', role: 'wicketkeeper', battingRating: 85, bowlingRating: 5, experienceRating: 80, t20ImpactRating: 87 },
      { name: 'Suryakumar Yadav', role: 'batsman', battingRating: 93, bowlingRating: 9, experienceRating: 84, t20ImpactRating: 94 },
      { name: 'Tilak Varma', role: 'batsman', battingRating: 82, bowlingRating: 8, experienceRating: 74, t20ImpactRating: 83 },
      { name: 'Hardik Pandya', role: 'allrounder', battingRating: 84, bowlingRating: 79, experienceRating: 88, t20ImpactRating: 89 },
      { name: 'Tim David', role: 'batsman', battingRating: 79, bowlingRating: 2, experienceRating: 68, t20ImpactRating: 86 },
      { name: 'Romario Shepherd', role: 'allrounder', battingRating: 73, bowlingRating: 72, experienceRating: 70, t20ImpactRating: 82 },
      { name: 'Jasprit Bumrah', role: 'bowler', battingRating: 28, bowlingRating: 96, experienceRating: 94, t20ImpactRating: 96 },
      { name: 'Gerald Coetzee', role: 'bowler', battingRating: 30, bowlingRating: 84, experienceRating: 72, t20ImpactRating: 82 },
      { name: 'Piyush Chawla', role: 'bowler', battingRating: 25, bowlingRating: 80, experienceRating: 88, t20ImpactRating: 78 },
      { name: 'Akash Madhwal', role: 'bowler', battingRating: 24, bowlingRating: 77, experienceRating: 69, t20ImpactRating: 76 }
    ],
    benchPlayers: [
      { name: 'Naman Dhir', role: 'allrounder', battingRating: 70, bowlingRating: 58, experienceRating: 56, t20ImpactRating: 67 },
      { name: 'Nehal Wadhera', role: 'batsman', battingRating: 74, bowlingRating: 10, experienceRating: 62, t20ImpactRating: 71 },
      { name: 'Luke Wood', role: 'bowler', battingRating: 29, bowlingRating: 79, experienceRating: 74, t20ImpactRating: 75 }
    ]
  },
  {
    teamName: 'Rajasthan Royals',
    playingXI: [
      { name: 'Yashasvi Jaiswal', role: 'batsman', battingRating: 90, bowlingRating: 6, experienceRating: 75, t20ImpactRating: 91 },
      { name: 'Jos Buttler', role: 'wicketkeeper', battingRating: 92, bowlingRating: 5, experienceRating: 93, t20ImpactRating: 94 },
      { name: 'Sanju Samson', role: 'wicketkeeper', battingRating: 86, bowlingRating: 10, experienceRating: 88, t20ImpactRating: 88 },
      { name: 'Riyan Parag', role: 'allrounder', battingRating: 80, bowlingRating: 62, experienceRating: 72, t20ImpactRating: 83 },
      { name: 'Shimron Hetmyer', role: 'batsman', battingRating: 82, bowlingRating: 4, experienceRating: 76, t20ImpactRating: 86 },
      { name: 'Dhruv Jurel', role: 'batsman', battingRating: 76, bowlingRating: 6, experienceRating: 66, t20ImpactRating: 80 },
      { name: 'Ravichandran Ashwin', role: 'allrounder', battingRating: 70, bowlingRating: 84, experienceRating: 97, t20ImpactRating: 82 },
      { name: 'Trent Boult', role: 'bowler', battingRating: 32, bowlingRating: 90, experienceRating: 94, t20ImpactRating: 90 },
      { name: 'Avesh Khan', role: 'bowler', battingRating: 28, bowlingRating: 80, experienceRating: 74, t20ImpactRating: 77 },
      { name: 'Yuzvendra Chahal', role: 'bowler', battingRating: 24, bowlingRating: 91, experienceRating: 95, t20ImpactRating: 92 },
      { name: 'Sandeep Sharma', role: 'bowler', battingRating: 26, bowlingRating: 82, experienceRating: 86, t20ImpactRating: 81 }
    ],
    benchPlayers: [
      { name: 'Tom Kohler-Cadmore', role: 'batsman', battingRating: 74, bowlingRating: 12, experienceRating: 66, t20ImpactRating: 72 },
      { name: 'Nandre Burger', role: 'bowler', battingRating: 27, bowlingRating: 78, experienceRating: 64, t20ImpactRating: 74 },
      { name: 'Keshav Maharaj', role: 'bowler', battingRating: 33, bowlingRating: 82, experienceRating: 92, t20ImpactRating: 79 }
    ]
  }
];

module.exports = {
  calculateTopOrderScore,
  calculateMiddleOrderScore,
  calculateBowlingScore,
  calculateBenchStrength,
  calculateTeamPowerScore,
  rankTeams,
  // Exported for optional deeper API responses.
  calculateFinisherScore,
  calculateAllRounderScore,
  calculateTeamBalanceScore,
  calculateMatchWinnerScore,
  exampleTeams
};

if (require.main === module) {
  const response = rankTeams(exampleTeams);
  const output = {
    rankings: response.rankings,
    bestBattingTeam: response.bestBattingTeam,
    bestBowlingTeam: response.bestBowlingTeam,
    bestBenchStrength: response.bestBenchStrength,
    darkHorseTeam: response.darkHorseTeam
  };

  console.log(JSON.stringify(output, null, 2));
}
