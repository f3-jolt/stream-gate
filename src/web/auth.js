'use strict';

const express = require('express');
const { db } = require('../db/database');
const router = express.Router();

const DISCORD_API = 'https://discord.com/api/v10';
const SCOPES = 'identify guilds';

function getCallbackUrl() {
  return `${process.env.PUBLIC_URL}/auth/callback`;
}

router.get('/login', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: getCallbackUrl(),
    response_type: 'code',
    scope: SCOPES,
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

router.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/admin');

  try {
    // Exchange code for access token
    const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: getCallbackUrl(),
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('No access token returned');

    const headers = { Authorization: `Bearer ${tokenData.access_token}` };

    // Fetch user identity and guilds in parallel
    const [userRes, guildsRes] = await Promise.all([
      fetch(`${DISCORD_API}/users/@me`, { headers }),
      fetch(`${DISCORD_API}/users/@me/guilds`, { headers }),
    ]);
    const discordUser = await userRes.json();
    const discordGuilds = await guildsRes.json();

    if (!discordUser.id) throw new Error('Could not fetch Discord user');

    // Find guilds in our DB where the user has admin access
    // Check both guild_settings and leagues tables so guilds without /admin setup still appear
    const guildSettingsRows = db.prepare('SELECT guild_id, admin_role_id FROM guild_settings').all();
    const leagueGuildRows = db.prepare('SELECT DISTINCT guild_id FROM leagues').all();
    const settingsMap = new Map(guildSettingsRows.map(r => [r.guild_id, r]));
    const ourGuildIds = new Set([
      ...guildSettingsRows.map(r => r.guild_id),
      ...leagueGuildRows.map(r => r.guild_id),
    ]);

    console.log(`[auth] User ${discordUser.username} in ${discordGuilds.length} Discord guilds; our known guilds: [${[...ourGuildIds].join(', ')}]`);

    const MANAGE_GUILD = 0x20n;
    const ADMINISTRATOR = 0x8n;

    const authorizedGuilds = [];
    for (const g of discordGuilds) {
      if (!ourGuildIds.has(g.id)) continue;

      const perms = BigInt(g.permissions);
      const hasAdminPerms = g.owner || (perms & ADMINISTRATOR) !== 0n || (perms & MANAGE_GUILD) !== 0n;

      console.log(`[auth] Checking guild ${g.name} (${g.id}): owner=${g.owner} perms=${g.permissions} hasAdminPerms=${hasAdminPerms}`);

      if (hasAdminPerms) {
        authorizedGuilds.push({ id: g.id, name: g.name, icon: g.icon });
        continue;
      }

      // Fallback: check configured admin_role_id via bot client
      const settings = settingsMap.get(g.id);
      if (settings?.admin_role_id) {
        try {
          const client = require('../bot/client');
          const guild = client.guilds.cache.get(g.id);
          if (guild) {
            const member = await guild.members.fetch(discordUser.id).catch(() => null);
            if (member?.roles.cache.has(settings.admin_role_id)) {
              console.log(`[auth] Authorized via admin_role_id for guild ${g.name}`);
              authorizedGuilds.push({ id: g.id, name: g.name, icon: g.icon });
            }
          }
        } catch (roleErr) {
          console.error(`[auth] Role check failed for guild ${g.id}:`, roleErr.message);
        }
      }
    }

    console.log(`[auth] authorizedGuilds for ${discordUser.username}: [${authorizedGuilds.map(g => g.name).join(', ')}]`);

    req.session.user = {
      id: discordUser.id,
      username: discordUser.username,
      avatar: discordUser.avatar,
      authorizedGuilds,
    };

    // Explicitly save session before redirect to ensure cookie is set
    req.session.save(err => {
      if (err) console.error('[auth] Session save error:', err.message);
      res.redirect('/admin');
    });
  } catch (err) {
    console.error('[auth] OAuth callback error:', err.message, err.stack);
    res.redirect('/admin?error=auth_failed');
  }
});

router.get('/me', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
  const { id, username, avatar } = req.session.user;
  res.json({ id, username, avatar });
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin'));
});

module.exports = router;
