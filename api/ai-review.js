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
      'From the teams below, decide the best stable team after the auction.',
      'Give output in this exact format:',
      '1) Best Stable Team: <team name>',
      '2) Why it is best (3 bullet points)',
      '3) Team-wise quick ratings (out of 10 for balance, bowling depth, batting depth)',
      '4) Suggested 2 unsold-player target types for weaker teams',
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
  const b = getRoleBuckets(squad);

  const hasWK = b.wk > 0 ? 1 : 0;
  const hasAR = b.ar > 0 ? 1 : 0;
  const hasPaceAndSpin = (b.fast > 0 && b.spin > 0) ? 1 : 0;
  const bowlingUnits = b.bowl + b.ar * 0.5;
  const battingUnits = b.bats + b.wk + b.ar * 0.5;

  const balance = clamp10((hasWK * 2.5) + (hasAR * 2.5) + (hasPaceAndSpin * 2.5) + Math.min(2.5, (n / Math.max(1, team.maxSquadSize || n)) * 2.5));
  const bowlingDepth = clamp10((bowlingUnits / n) * 12);
  const battingDepth = clamp10((battingUnits / n) * 12);

  const overall = clamp10(balance * 0.45 + bowlingDepth * 0.275 + battingDepth * 0.275);
  return { overall, balance, bowlingDepth, battingDepth, buckets: b };
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

function buildRuleBasedReview(teams) {
  const scored = (teams || []).map((t) => ({
    team: t,
    score: scoreTeam(t)
  })).sort((a, b) => b.score.overall - a.score.overall);

  if (!scored.length) {
    return [
      '1) Best Stable Team: Not enough data',
      '2) Why it is best (3 bullet points)',
      '- No team data was available.',
      '- Could not compute role balance.',
      '- Please retry after auction data is loaded.',
      '3) Team-wise quick ratings (out of 10 for balance, bowling depth, batting depth)',
      '- NA',
      '4) Suggested 2 unsold-player target types for weaker teams',
      '- Quality all-rounder',
      '- Death-overs fast bowler'
    ].join('\n');
  }

  const best = scored[0];
  const topReasons = [
    `Strong role balance score (${best.score.balance}/10) with key role coverage.`,
    `Reliable bowling depth (${best.score.bowlingDepth}/10) for multiple match phases.`,
    `Competitive batting depth (${best.score.battingDepth}/10) with stable core options.`
  ];

  const ratings = scored.map(({ team, score }) => (
    `- ${team.name}: balance ${score.balance}/10, bowling depth ${score.bowlingDepth}/10, batting depth ${score.battingDepth}/10`
  )).join('\n');

  const weaker = scored.slice(-2).reverse();
  const suggestions = weaker.map(({ team, score }) => {
    const needs = detectNeeds(score);
    return `- ${team.name}: ${needs[0]}, ${needs[1]}`;
  }).join('\n');

  return [
    `1) Best Stable Team: ${best.team.name}`,
    '2) Why it is best (3 bullet points)',
    `- ${topReasons[0]}`,
    `- ${topReasons[1]}`,
    `- ${topReasons[2]}`,
    '3) Team-wise quick ratings (out of 10 for balance, bowling depth, batting depth)',
    ratings,
    '4) Suggested 2 unsold-player target types for weaker teams',
    suggestions
  ].join('\n');
}
