module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server is missing OPENROUTER_API_KEY' });
    return;
  }

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
      if (response.status === 401 || response.status === 429) {
        res.status(response.status).json({ error: lastErrorMessage });
        return;
      }
    }

    if (!text || !selectedModel) {
      res.status(502).json({
        error: `${lastErrorMessage}. Tried models: ${modelCandidates.join(', ')}`
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
