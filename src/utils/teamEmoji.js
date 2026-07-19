'use strict';

// Team logos as Discord custom emoji.
//
// Discord embeds can't render an image per row, so the only way to show a crest
// beside each team in the roster post is a guild custom emoji. We upload each
// team's logo once per guild, remember the emoji id, and reuse it forever after.
//
// Two things make this best-effort rather than required: guilds have a hard
// emoji slot cap (50 on an unboosted server), and the bot needs Manage
// Expressions. Either failure degrades to a text-only row rather than aborting
// the publish — see ensureTeamEmojis' `fellBack` count, which the caller
// surfaces so staff know why crests are missing.

const fs = require('fs');
const path = require('path');
const { getTeamByAbbrev } = require('./teams');
const { getTeamEmoji, upsertTeamEmoji, deleteTeamEmoji } = require('../db/queries');
const logger = require('./logger');

// Discord rejects names outside [A-Za-z0-9_] and shorter than 2 chars. The
// prefix both namespaces our uploads and floors the length for 1-char abbrevs.
function emojiNameFor(abbrev) {
  const clean = String(abbrev).replace(/[^A-Za-z0-9_]/g, '');
  return `sg_${clean}`.slice(0, 32);
}

// Logo bytes come from the custom-team BLOB or the bundled PNG on disk.
// Discord caps emoji uploads at 256KB; every bundled logo is well under that,
// but a user-uploaded custom crest might not be, so we check.
const MAX_EMOJI_BYTES = 256 * 1024;

function logoBytes(team) {
  if (team.logoBuffer) return team.logoBuffer;
  if (!team.pic) return null;
  const p = path.resolve(process.cwd(), team.pic.replace(/^\.\//, ''));
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p);
}

// Discord reports "Maximum number of emojis reached" as 30008 and a missing
// Manage Expressions as 50013. Both mean every remaining upload will fail too,
// so we stop trying instead of grinding through a heavily rate-limited endpoint
// once per team, on every publish.
const GIVE_UP_CODES = new Set([30008, 50013]);

// Discord rate-limits emoji creation aggressively, so a first publish for a
// large league can spend minutes uploading. That has to stay well inside the
// hosting proxy's request timeout (~60s on Fly), or the HTTP request dies and
// the roster never posts. We upload within a time budget and leave the rest for
// the next publish — crests accumulate across runs instead of blocking one.
const UPLOAD_BUDGET_MS = 20_000;

// Resolve emoji markup for every abbrev, uploading what's missing.
// Returns { markup, uploaded, noLogo, uploadFailed, pending }.
// The failure counts are kept apart because they need different fixes: noLogo
// means "give this team a logo", uploadFailed means "check slots/perms", and
// pending just means "run it again to finish".
async function ensureTeamEmojis(guild, abbrevs, budgetMs = UPLOAD_BUDGET_MS) {
  const markup = new Map();
  let uploaded = 0;
  let noLogo = 0;
  let uploadFailed = 0;

  // One fetch up front so a manually-deleted emoji is detected without a
  // per-team round trip. If the fetch itself fails we can't tell live from
  // deleted, so we trust the stored pointers rather than treating every emoji
  // as stale — invalidating them would re-upload the whole set as duplicates.
  let live = null;
  try {
    const all = await guild.emojis.fetch();
    live = new Set(all.map(e => e.id));
  } catch (err) {
    logger.warn('Could not list guild emojis; trusting stored ids', { guild: guild.id, error: err.message });
  }

  let canUpload = true;
  let pending = 0;
  const deadline = Date.now() + budgetMs;
  for (const abbrev of abbrevs) {
    const known = getTeamEmoji(guild.id, abbrev);
    if (known && (live === null || live.has(known.emoji_id))) {
      markup.set(abbrev, `<:${known.emoji_name}:${known.emoji_id}>`);
      continue;
    }
    if (known) deleteTeamEmoji(guild.id, abbrev);   // confirmed gone — re-upload

    const team = getTeamByAbbrev(abbrev);
    const bytes = team ? logoBytes(team) : null;
    if (!bytes || bytes.length > MAX_EMOJI_BYTES) {
      markup.set(abbrev, null);
      noLogo++;
      continue;
    }
    if (!canUpload) { markup.set(abbrev, null); uploadFailed++; continue; }
    // Out of time — render this team as text and pick it up next publish.
    if (Date.now() > deadline) { markup.set(abbrev, null); pending++; continue; }

    try {
      const emoji = await guild.emojis.create({
        attachment: bytes,
        name: emojiNameFor(abbrev),
        reason: 'StreamGate team logo for the season roster post',
      });
      upsertTeamEmoji(guild.id, abbrev, emoji.id, emoji.name);
      markup.set(abbrev, `<:${emoji.name}:${emoji.id}>`);
      uploaded++;
    } catch (err) {
      logger.warn('Could not upload team emoji', { guild: guild.id, abbrev, error: err.message });
      if (GIVE_UP_CODES.has(err.code)) {
        canUpload = false;   // out of slots or permission — skip the rest
        logger.warn('Halting team emoji uploads for this publish', { guild: guild.id, code: err.code });
      }
      markup.set(abbrev, null);
      uploadFailed++;
    }
  }
  if (pending) {
    logger.info('Emoji upload budget reached; remaining crests deferred', { guild: guild.id, pending });
  }
  return { markup, uploaded, noLogo, uploadFailed, pending };
}

module.exports = { ensureTeamEmojis, emojiNameFor };
