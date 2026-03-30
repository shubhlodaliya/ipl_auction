module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.OPENROUTER_API_KEY;

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const roomCode = body.roomCode || 'UNKNOWN';
    const teams = Array.isArray(body.teams) ? body.teams : [];

    if (!teams.length) {
      res.status(400).json({ error: 'Missing team data for AI review' });
      return;
    }

    const teamsSummary = teams.map((team) => {
      const squad = Array.isArray(team.squad) ? team.squad : [];
      const totalSpent = squad.reduce((sum, p) => sum + (Number(p.priceLakh) || 0), 0);
      const roleCount = squad.reduce((acc, p) => {
        const role = p.role || 'Unknown';
        acc[role] = (acc[role] || 0) + 1;
        return acc;
      }, {});

      const playersLine = squad
        .map((p) => `${p.name} (${p.role}, ${formatPriceLakh(p.priceLakh)})`)
        .join(', ');

      return [
        `Team: ${team.name} (${team.short})`,
        `Owner: ${team.ownerName}`,
        `Purse Left: ${formatPriceLakh(team.purseLakh)}`,
        `Squad Count: ${team.squadCount}/${team.maxSquadSize || 'NA'}`,
        `Total Spent: ${formatPriceLakh(totalSpent)}`,
        `Role Counts: ${JSON.stringify(roleCount)}`,
        `Players: ${playersLine || 'None'}`
      ].join('\n');
    }).join('\n\n');

    const prompt = [
      'You are a cricket auction analyst.',
      'Create a user-friendly ranking for ALL teams from strongest to weakest.',
      'Keep language simple and practical.',
      'Output must include these sections exactly:',
      '1) Team Rankings (best to worst)',
      '   - For each rank: Team Name, Overall Score out of 10, and 2 short reasons for that position.',
      '2) Final Verdict',
      '   - Mention which is the most stable team and why in 2 points.',
      '3) Improvement Suggestions For Bottom Teams',
      '   - For last 2 ranked teams, give 2 actionable player-type suggestions each.',
      '',
      `Room: ${roomCode}`,
      'Auction Team Data:',
      teamsSummary
    ].join('\n');

    // If API key is not configured, return a deterministic backend fallback analysis.
    if (!apiKey) {
      const fallbackText = buildRuleBasedReview(teams);
      res.status(200).json({ text: fallbackText, model: 'rule-based-fallback' });
      return;
    }

    const preferredModel = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-chat-v3-0324:free';
    const fallbackModels = (process.env.OPENROUTER_MODEL_FALLBACKS || '')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);

    const defaultFallbacks = [
      'meta-llama/llama-3.1-8b-instruct:free',
      'mistralai/mistral-7b-instruct:free',
      'google/gemma-2-9b-it:free'
    ];

    const modelCandidates = Array.from(new Set([preferredModel, ...fallbackModels, ...defaultFallbacks]));

    let selectedModel = null;
    let text = null;
    let lastErrorMessage = 'AI provider failed to return response';

    for (const model of modelCandidates) {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: 'Be concise and practical.' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.2
        })
      });

      const json = await response.json();
      const candidateText = json?.choices?.[0]?.message?.content;

      if (response.ok && candidateText) {
        selectedModel = model;
        text = candidateText;
        break;
      }

      lastErrorMessage = json?.error?.message || lastErrorMessage;

      // If rate-limited or unauthorized, fail fast instead of trying more models.
      if (response.status === 401 || response.status === 429) break;
    }

    if (!text || !selectedModel) {
      const fallbackText = buildRuleBasedReview(teams);
      res.status(200).json({
        text: fallbackText,
        model: 'rule-based-fallback',
        warning: `${lastErrorMessage}. Tried models: ${modelCandidates.join(', ')}`
      });
      return;
    }

    res.status(200).json({ text, model: selectedModel });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unknown backend error' });
  }
};

function formatPriceLakh(value) {
  const lakh = Number(value) || 0;
  if (lakh >= 100) {
    const cr = lakh / 100;
    return `Rs ${cr % 1 === 0 ? cr : cr.toFixed(2)}Cr`;
  }
  return `Rs ${lakh}L`;
}

function clamp10(x) {
  return Math.max(0, Math.min(10, Number(x.toFixed(1))));
}

function getRoleBuckets(squad) {
  const buckets = { bats: 0, bowl: 0, ar: 0, wk: 0, spin: 0, fast: 0 };
  (squad || []).forEach((p) => {
    const role = String(p.role || '').toLowerCase();
    if (role.includes('wicket')) buckets.wk += 1;
    if (role.includes('all-rounder')) buckets.ar += 1;
    if (role.includes('batsman')) buckets.bats += 1;
    if (role.includes('spinner')) {
      buckets.spin += 1;
      buckets.bowl += 1;
    }
    if (role.includes('fast') || role === 'bowler') {
      buckets.fast += 1;
      buckets.bowl += 1;
    }
    if (role === 'bowler') buckets.bowl += 1;
  });
  return buckets;
}

function scoreTeam(team) {
  const squad = Array.isArray(team.squad) ? team.squad : [];
  const n = Math.max(1, squad.length);
  const maxSquad = Math.max(1, Number(team.maxSquadSize) || n);
  const b = getRoleBuckets(squad);

  const hasWK = b.wk > 0 ? 1 : 0;
  const hasAR = b.ar > 0 ? 1 : 0;
  const hasPaceAndSpin = (b.fast > 0 && b.spin > 0) ? 1 : 0;
  const bowlingUnits = b.bowl + b.ar * 0.5;
  const battingUnits = b.bats + b.wk + b.ar * 0.5;

  const balance = clamp10((hasWK * 2.5) + (hasAR * 2.5) + (hasPaceAndSpin * 2.5) + Math.min(2.5, (n / Math.max(1, team.maxSquadSize || n)) * 2.5));
  const bowlingDepth = clamp10((bowlingUnits / n) * 12);
  const battingDepth = clamp10((battingUnits / n) * 12);
  const squadFill = clamp10((n / maxSquad) * 10);

  const overall = clamp10(balance * 0.4 + bowlingDepth * 0.25 + battingDepth * 0.25 + squadFill * 0.1);
  return { overall, balance, bowlingDepth, battingDepth, squadFill, buckets: b };
}

function detectNeeds(score) {
  const needs = [];
  if (score.buckets.wk === 0) needs.push('Wicket-keeper batsman');
  if (score.buckets.ar === 0) needs.push('Quality all-rounder');
  if (score.buckets.spin === 0) needs.push('Frontline spinner');
  if (score.buckets.fast === 0) needs.push('Death-overs fast bowler');
  if (!needs.length) needs.push('Finisher batter');
  if (needs.length < 2) needs.push('Powerplay wicket-taking bowler');
  return needs.slice(0, 2);
}

function metricLeaders(scored) {
  return {
    balance: Math.max(...scored.map(x => x.score.balance)),
    bowlingDepth: Math.max(...scored.map(x => x.score.bowlingDepth)),
    battingDepth: Math.max(...scored.map(x => x.score.battingDepth)),
    squadFill: Math.max(...scored.map(x => x.score.squadFill))
  };
}

function buildPositionReason(score, idx, scored) {
  if (idx === 0) return `Leads the table with the strongest overall combination (Overall ${score.overall}/10).`;

  const gapFromAbove = (scored[idx - 1].score.overall - score.overall).toFixed(1);
  return `At #${idx + 1}, it is ${gapFromAbove}/10 behind the team above in overall score.`;
}

function buildCompositionReason(team, score, leaders) {
  const strengths = [];
  if (score.balance === leaders.balance) strengths.push(`joint-best balance (${score.balance}/10)`);
  if (score.bowlingDepth === leaders.bowlingDepth) strengths.push(`top bowling depth (${score.bowlingDepth}/10)`);
  if (score.battingDepth === leaders.battingDepth) strengths.push(`top batting depth (${score.battingDepth}/10)`);
  if (score.squadFill === leaders.squadFill) strengths.push(`best squad fill (${score.squadFill}/10)`);

  if (strengths.length) {
    return `Key edge: ${strengths[0]}.`;
  }

  if (score.buckets.wk === 0) return 'Weak point: no wicket-keeper option in current squad structure.';
  if (score.buckets.ar === 0) return 'Weak point: no all-rounder, reducing batting-bowling flexibility.';
  if (score.buckets.spin === 0) return 'Weak point: no frontline spinner for middle-overs control.';
  if (score.buckets.fast === 0) return 'Weak point: no specialist pace option for powerplay/death phases.';

  return `Squad mix is decent with ${score.buckets.bats} batters, ${score.buckets.bowl} bowlers and ${score.buckets.ar} all-rounders.`;
}

function buildRuleBasedReview(teams) {
  const scored = (teams || []).map((t) => ({
    team: t,
    score: scoreTeam(t)
  })).sort((a, b) => b.score.overall - a.score.overall);

  if (!scored.length) {
    return [
      '1) Team Rankings (best to worst)',
      'No team data available.',
      '',
      '2) Final Verdict',
      'Could not compute ranking because no squads are available.',
      '',
      '3) Improvement Suggestions For Bottom Teams',
      '- Add quality all-rounders.',
      '- Add death-overs bowlers.'
    ].join('\n');
  }

  const best = scored[0];
  const leaders = metricLeaders(scored);

  const rankingLines = scored.map(({ team, score }, idx) => {
    const reasons = [
      buildPositionReason(score, idx, scored),
      `${buildCompositionReason(team, score, leaders)} (Balance ${score.balance}/10, Bowling ${score.bowlingDepth}/10, Batting ${score.battingDepth}/10)`
    ];

    return [
      `${idx + 1}. ${team.name} - Overall ${score.overall}/10`,
      `   - ${reasons[0]}`,
      `   - ${reasons[1]}`
    ].join('\n');
  }).join('\n');

  const weaker = scored.slice(-2);
  const suggestions = weaker.map(({ team, score }) => {
    const needs = detectNeeds(score);
    return [
      `- ${team.name}:`,
      `  1. Target ${needs[0]}.`,
      `  2. Target ${needs[1]}.`
    ].join('\n');
  }).join('\n');

  return [
    '1) Team Rankings (best to worst)',
    rankingLines,
    '',
    '2) Final Verdict',
    `Most stable team: ${best.team.name}.`,
    `- They lead with Overall ${best.score.overall}/10 and balance ${best.score.balance}/10.`,
    `- Their squad provides strong phase coverage (Bowling ${best.score.bowlingDepth}/10, Batting ${best.score.battingDepth}/10).`,
    '',
    '3) Improvement Suggestions For Bottom Teams',
    suggestions
  ].join('\n');
}
