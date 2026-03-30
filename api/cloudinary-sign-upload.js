const crypto = require('crypto');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const roomCode = String(body.roomCode || '').trim();
    const entityType = String(body.entityType || '').trim();
    const entityId = String(body.entityId || '').trim();

    if (!roomCode || !entityType || !entityId) {
      res.status(400).json({ error: 'Missing roomCode/entityType/entityId' });
      return;
    }

    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;

    if (!cloudName || !apiKey || !apiSecret) {
      res.status(500).json({ error: 'Missing Cloudinary server environment variables' });
      return;
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const safeType = entityType === 'team' ? 'teams' : 'players';
    const folder = `ipl-auction/${roomCode}/${safeType}`;
    const publicId = `${entityId}-${timestamp}`;
    const tags = `ipl-auction,auction-${roomCode}`;

    const toSign = `folder=${folder}&public_id=${publicId}&tags=${tags}&timestamp=${timestamp}${apiSecret}`;
    const signature = crypto.createHash('sha1').update(toSign).digest('hex');

    res.status(200).json({
      cloudName,
      apiKey,
      timestamp,
      folder,
      publicId,
      tags,
      signature
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to sign upload' });
  }
};
