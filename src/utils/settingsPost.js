'use strict';

// Publishing a league's gameplay settings to its Discord settings channel.
//
// Model: ONE canonical embed per league, edited in place on every update, so it
// keeps its permalink/pin and never spams. Each update that actually changes a
// value also sends a separate changelog message to the same channel. The last
// published snapshot is stored (league_settings_post.posted_settings) and is the
// sole source for the diff — we never try to reconstruct history from Discord.

const { EmbedBuilder } = require('discord.js');
const { SECTIONS, resolveSettings } = require('./leagueSettings');
const {
  getSettingsPost,
  upsertSettingsPost,
  getLeagueSettings,
} = require('../db/queries');
const logger = require('./logger');

const ACCENT = 0x6798ff;   // StreamGate blue (matches the admin portal)
const CHANGE = 0x5bd98f;   // green for the changelog

// Discord lays inline fields out 3-up and sizes each row to its tallest field,
// so a 14-line section beside a 3-line one leaves a wall of dead space. Cap the
// lines per field and spill the remainder into a "(cont.)" field instead.
const MAX_FIELD_LINES = 8;

// Human-facing value: toggles read On/Off, ranges carry their unit, enums as-is.
function displayValue(setting, value) {
  if (setting.type === 'toggle') return value === 'ON' ? 'On' : 'Off';
  if (setting.unit === '%') return `${value}%`;   // no space before a percent sign
  if (setting.unit) return `${value} ${setting.unit}`;
  return String(value);
}

// Embed columns are narrow (~1/3 width), so a long label wraps and strands its
// value on the next line. Settings/sections can carry a compact `short` label
// used only here; the admin UI keeps the full name.
function displayLabel(setting) {
  return setting.short || setting.label;
}

// The canonical embed titled by LEAGUE name (not the season).
function buildSettingsEmbed(league, values) {
  const resolved = resolveSettings(values);
  const embed = new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle(`League Settings — ${league.name}`)
    .setFooter({ text: 'StreamGate · Read-only — always current' })
    .setTimestamp();

  for (const section of SECTIONS) {
    const lines = section.settings
      .map(s => `${displayLabel(s)}: **${displayValue(s, resolved[s.key])}**`);
    const title = section.short || section.title;
    for (let i = 0; i < lines.length; i += MAX_FIELD_LINES) {
      const chunk = lines.slice(i, i + MAX_FIELD_LINES);
      embed.addFields({
        name: i === 0 ? title : `${title} (cont.)`,
        value: chunk.join('\n').slice(0, 1024),   // field values cap at 1024
        inline: true,
      });
    }
  }
  return embed;
}

// Compare two snapshots (resolved on both sides so every key is present) and
// return [{ label, from, to }] for each setting whose displayed value changed.
function diffSettings(oldSnapshot, newSnapshot) {
  const before = resolveSettings(oldSnapshot);
  const after = resolveSettings(newSnapshot);
  const changes = [];
  for (const section of SECTIONS) {
    for (const s of section.settings) {
      const from = displayValue(s, before[s.key]);
      const to = displayValue(s, after[s.key]);
      if (from !== to) changes.push({ label: s.label, from, to });
    }
  }
  return changes;
}

function buildChangelogEmbed(league, changes, actorName) {
  const lines = changes.map(c => `• ${c.label}: ${c.from} → **${c.to}**`);
  let description = lines.join('\n');
  if (description.length > 4000) {
    // Keep under the 4096 description cap if a league rewrites almost everything.
    const kept = [];
    let len = 0;
    for (const line of lines) {
      if (len + line.length + 1 > 3900) break;
      kept.push(line); len += line.length + 1;
    }
    description = kept.join('\n') + `\n…and ${changes.length - kept.length} more`;
  }
  const count = changes.length;
  return new EmbedBuilder()
    .setColor(CHANGE)
    .setTitle(`Settings updated — ${league.name}`)
    .setDescription(description)
    .setFooter({ text: `${count} ${count === 1 ? 'change' : 'changes'} · by ${actorName}` })
    .setTimestamp();
}

async function pinQuietly(message) {
  // A missing Manage Messages permission shouldn't fail the whole publish.
  try { await message.pin(); } catch (err) {
    logger.warn('Could not pin settings post', { error: err.message });
  }
}

async function sendFreshPost(channel, league, resolved) {
  const msg = await channel.send({ embeds: [buildSettingsEmbed(league, resolved)] });
  await pinQuietly(msg);
  upsertSettingsPost(league.id, channel.id, msg.id, resolved);
  return msg;
}

// Publish (first time) or update (edit-in-place + changelog) the settings post.
// Reads the league's SAVED settings from the DB — publishing is deliberately a
// separate action from saving, so callers save first, then publish.
//
// Returns { action: 'published' | 'updated' | 'republished' | 'unchanged', changed: [...] }.
async function publishOrUpdateSettingsPost(league, actorName) {
  if (!league.settings_channel_id) {
    throw new Error('No settings channel configured for this league.');
  }

  const resolved = resolveSettings(getLeagueSettings(league.id));
  const client = require('../bot/client');
  const channel = await client.channels.fetch(league.settings_channel_id);
  if (!channel) throw new Error('Configured settings channel could not be found.');

  const existing = getSettingsPost(league.id);

  // First publish, or the channel was reconfigured since last time → fresh post.
  if (!existing || existing.channel_id !== league.settings_channel_id) {
    await sendFreshPost(channel, league, resolved);
    logger.info('Published settings post', { leagueId: league.id, channel: channel.id });
    return { action: 'published', changed: [] };
  }

  // Edit the canonical message in place.
  let message;
  try {
    message = await channel.messages.fetch(existing.message_id);
  } catch {
    // Someone deleted it — self-heal by reposting, but announce nothing.
    await sendFreshPost(channel, league, resolved);
    logger.info('Settings post was missing; republished', { leagueId: league.id });
    return { action: 'republished', changed: [] };
  }

  const changes = diffSettings(existing.posted_settings, resolved);
  await message.edit({ embeds: [buildSettingsEmbed(league, resolved)] });
  upsertSettingsPost(league.id, channel.id, message.id, resolved);

  if (changes.length) {
    await channel.send({ embeds: [buildChangelogEmbed(league, changes, actorName)] });
    logger.info('Updated settings post + changelog', { leagueId: league.id, changes: changes.length });
    return { action: 'updated', changed: changes };
  }
  logger.info('Settings post refreshed with no value changes', { leagueId: league.id });
  return { action: 'unchanged', changed: [] };
}

module.exports = {
  buildSettingsEmbed,
  diffSettings,
  buildChangelogEmbed,
  displayValue,
  publishOrUpdateSettingsPost,
};
