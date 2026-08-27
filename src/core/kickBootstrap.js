const KICK_API = 'https://api.kick.com';
const KICK_OAUTH = 'https://id.kick.com/oauth/token';

async function resolveBroadcasterUserId() {
  if (process.env.KICK_BROADCASTER_USER_ID?.trim()) return;

  const clientId = process.env.KICK_CLIENT_ID?.trim();
  const clientSecret = process.env.KICK_CLIENT_SECRET?.trim();
  const slug = process.env.KICK_CHANNEL_SLUG?.trim() || 'MiojoPlays';
  if (!clientId || !clientSecret || !slug) return;

  try {
    const tokenResponse = await fetch(KICK_OAUTH, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
      signal: AbortSignal.timeout(12_000),
    });

    if (!tokenResponse.ok) {
      console.warn(`Kick bootstrap: OAuth HTTP ${tokenResponse.status}; broadcaster ID não resolvido.`);
      return;
    }

    const tokenData = await tokenResponse.json();
    if (!tokenData?.access_token) {
      console.warn('Kick bootstrap: access token ausente; broadcaster ID não resolvido.');
      return;
    }

    const params = new URLSearchParams({ slug });
    const channelResponse = await fetch(`${KICK_API}/public/v1/channels?${params.toString()}`, {
      headers: { authorization: `Bearer ${tokenData.access_token}` },
      signal: AbortSignal.timeout(12_000),
    });

    if (!channelResponse.ok) {
      console.warn(`Kick bootstrap: channels HTTP ${channelResponse.status}; broadcaster ID não resolvido.`);
      return;
    }

    const json = await channelResponse.json();
    const channel = Array.isArray(json?.data) ? json.data[0] : json?.data;
    const broadcasterId = channel?.broadcaster_user_id;
    if (!broadcasterId) {
      console.warn(`Kick bootstrap: canal ${slug} encontrado sem broadcaster_user_id.`);
      return;
    }

    process.env.KICK_BROADCASTER_USER_ID = String(broadcasterId);
    console.log(`Kick bootstrap: broadcaster ID resolvido automaticamente para ${slug}.`);
  } catch (error) {
    console.warn(`Kick bootstrap: ${error.message}`);
  }
}

await resolveBroadcasterUserId();
