'use strict';

function requireAuth(req, res, next) {
  if (!req.session?.user) {
    // This middleware is only used inside the API router, so always return JSON
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function requireGuildAccess(req, res, next) {
  const { guildId } = req.params;
  const authorized = req.session?.user?.authorizedGuilds ?? [];
  if (!authorized.some(g => g.id === guildId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

module.exports = { requireAuth, requireGuildAccess };
