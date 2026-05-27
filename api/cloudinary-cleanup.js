module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const roomCode = String(body.roomCode || '').trim();

    if (!roomCode) {
      res.status(400).json({ error: 'Missing roomCode' });
      return;
    }

    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;

    if (!cloudName || !apiKey || !apiSecret) {
      res.status(500).json({ error: 'Missing Cloudinary server environment variables' });
      return;
    }

    const prefix = `ipl-auction/${roomCode}/`;
    const query = new URLSearchParams({
      prefix,
      invalidate: 'true'
    });

    const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');

    const response = await fetch(
      `https://api.cloudinary.com/v1_1/${cloudName}/resources/image/upload?${query.toString()}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Basic ${auth}`
        }
      }
    );

    const json = await response.json();

    if (!response.ok) {
      res.status(response.status).json({ error: json?.error?.message || 'Cloudinary cleanup failed' });
      return;
    }

    res.status(200).json({ ok: true, result: json });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Cloudinary cleanup failed' });
  }
};
