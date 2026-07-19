'use strict';

// Publishing a season's coach assignments to its league's roster channel.
//
// Model mirrors settingsPost.js with one deliberate difference: the canonical
// message is keyed by SEASON, not league. A new season has no season_roster_post
// row, so publishing it sends a brand-new message and leaves last season's post
// intact as a permanent record. Within a season we edit that message in place
// and send a separate changelog for every coach added, dropped, or moved.
//
// season_roster_post.posted_roster is the last-published snapshot and the sole
// diff source — we never reconstruct history from Discord. That also covers the
// fact that coach assignment changes aren't audited anywhere else in the app.

const { EmbedBuilder } = require('discord.js');
const { getSeasonTeams, getRosterPost, upsertRosterPost } = require('../db/queries');
const { getTeamByAbbrev } = require('./teams');
const logger = require('./logger');

const ACCENT = 0x6798ff;   // StreamGate blue (matches the admin portal)
const CHANGE = 0x5bd98f;   // green for the changelog

const OPEN = '*open*';     // shown as the coach for an unclaimed team

// Field values cap at 1024 chars and the whole embed at 6000. Conferences run
// long in a full-catalog league, so chunk fields the way the settings post does
// and stop adding fields before the embed total would be rejected.
const MAX_FIELD_CHARS = 1024;
const MAX_EMBED_CHARS = 5600;   // headroom under 6000 for title/footer
const MAX_EMBED_FIELDS = 25;    // Discord's hard per-embed field cap

function seasonLabel(season) {
  return season.label || String(season.year);
}

// A coach reads as a live Discord mention when we know their account (renders as
// a name chip, and mentions inside an embed don't ping), else their plain name.
function coachDisplay(entry) {
  if (!entry.coach) return OPEN;
  return entry.discordId ? `<@${entry.discordId}>` : entry.coach;
}

// Build the snapshot we both render and diff: { ABBREV: { conference, coach,
// discordId, teamName } }. Every team on the season roster appears, including
// ones with no coach, so a drop shows up as a value change rather than a
// deletion.
function buildRosterSnapshot(seasonId) {
  const snapshot = {};
  for (const t of getSeasonTeams(seasonId)) {
    const team = getTeamByAbbrev(t.team_abbrev);
    snapshot[t.team_abbrev] = {
      conference: t.conference_name || 'Unassigned',
      coach: t.coach_name || null,
      discordId: t.coach_discord_id || null,
      teamName: team?.name || t.team_abbrev,
    };
  }
  return snapshot;
}

function groupByConference(snapshot) {
  const groups = new Map();
  for (const [abbrev, entry] of Object.entries(snapshot)) {
    if (!groups.has(entry.conference)) groups.set(entry.conference, []);
    groups.get(entry.conference).push({ abbrev, ...entry });
  }
  // Conferences alphabetical, teams alphabetical within each — stable ordering
  // means an edit-in-place never reshuffles rows the reader was looking at.
  for (const rows of groups.values()) rows.sort((a, b) => a.teamName.localeCompare(b.teamName));
  return new Map([...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

function rowLine(row) {
  return `**${row.teamName}** — ${coachDisplay(row)}`;
}

// Flatten the roster into ready-to-add fields: one per conference, split into
// "(cont.)" fields wherever a conference exceeds Discord's 1024-char field cap.
function buildFields(snapshot) {
  const fields = [];
  for (const [conference, rows] of groupByConference(snapshot)) {
    const lines = rows.map(r => rowLine(r));
    const chunks = [];
    let current = [];
    let len = 0;
    for (const line of lines) {
      if (len + line.length + 1 > MAX_FIELD_CHARS) { chunks.push(current); current = []; len = 0; }
      current.push(line); len += line.length + 1;
    }
    if (current.length) chunks.push(current);

    chunks.forEach((chunk, i) => fields.push({
      name: i === 0 ? conference : `${conference} (cont.)`,
      value: chunk.join('\n'),
      inline: true,
    }));
  }
  return fields;
}

// The canonical roster, as one embed per message. A ~32-team league is a single
// page; a full 143-team catalog overflows Discord's 6000-char embed cap, so we
// page rather than drop rows. Returns an array of embeds, one per message.
function buildRosterEmbeds(league, season, snapshot) {
  const coached = Object.values(snapshot).filter(e => e.coach).length;
  const total = Object.keys(snapshot).length;
  const title = `Coach Assignments — ${league.name} ${seasonLabel(season)}`;

  // Pack fields into pages bounded by BOTH of Discord's embed limits: 6000
  // total chars and 25 fields. The field cap binds first for a league with many
  // small conferences (they're user-defined, so a league can have 30 divisions).
  const pages = [];
  let current = [];
  let used = 0;
  for (const field of buildFields(snapshot)) {
    const cost = field.name.length + field.value.length;
    // A page also carries the title (+ description on page 1); reserve for both.
    const overChars = used + cost > MAX_EMBED_CHARS - title.length - 120;
    const overFields = current.length >= MAX_EMBED_FIELDS;
    if (current.length && (overChars || overFields)) {
      pages.push(current); current = []; used = 0;
    }
    current.push(field); used += cost;
  }
  if (current.length) pages.push(current);
  if (!pages.length) pages.push([]);

  return pages.map((fields, i) => {
    const embed = new EmbedBuilder()
      .setColor(ACCENT)
      .setTitle(pages.length > 1 ? `${title} (${i + 1}/${pages.length})` : title)
      .setFooter({ text: 'StreamGate · Read-only — always current' })
      .setTimestamp()
      .addFields(fields);
    // Only the first page carries the summary line, so it reads as the header.
    if (i === 0) embed.setDescription(`${coached} of ${total} teams have a coach.`);
    return embed;
  });
}

// Compare two snapshots and classify what changed for each team. Coach moves
// are the point of the changelog, but roster and conference edits are reported
// too — otherwise a staffer who only moved a team between conferences would be
// told "no changes" while the post visibly changed under them.
// A coach moving between teams is then collapsed into a single 'switched'
// entry — see mergeSwitches.
// Returns [{ type: 'added'|'dropped'|'changed'|'switched'|'joined'|'left'|'moved', ... }].
function diffRoster(oldSnapshot, newSnapshot) {
  const changes = [];
  const abbrevs = new Set([...Object.keys(oldSnapshot || {}), ...Object.keys(newSnapshot || {})]);
  for (const abbrev of abbrevs) {
    const before = oldSnapshot?.[abbrev] || null;
    const after = newSnapshot?.[abbrev] || null;
    const team = after?.teamName || before?.teamName || abbrev;
    const from = before?.coach || null;
    const to = after?.coach || null;

    if (from !== to) {
      if (!from) changes.push({ type: 'added', team, from: null, to, entry: after });
      else if (!to) changes.push({ type: 'dropped', team, from, to: null, entry: before });
      else changes.push({ type: 'changed', team, from, to, entry: after });
      continue;   // a coach change is the headline; don't also log the rest
    }
    // Coach unchanged — report roster/conference edits so the action isn't
    // misreported as "unchanged".
    if (!before) changes.push({ type: 'joined', team, from: null, to: after.conference, entry: after });
    else if (!after) changes.push({ type: 'left', team, from: before.conference, to: null, entry: before });
    else if (before.conference !== after.conference) {
      changes.push({ type: 'moved', team, from: before.conference, to: after.conference, entry: after });
    }
  }
  return mergeSwitches(changes, newSnapshot).sort((a, b) => a.team.localeCompare(b.team));
}

// Identity for pairing a departure with an arrival. The Discord id is the
// reliable key; fall back to the display name for coaches with no linked
// account (the name is unique per league by getOrCreateCoach).
function coachKey(entry, fallbackName) {
  return entry?.discordId ? `id:${entry.discordId}` : `name:${entry?.coach || fallbackName}`;
}

// A coach changing teams shows up as two independent per-team changes: dropped
// from the old, added to the new. Reported raw that reads as a contradiction
// ("X left" / "X joined"), so collapse each matching pair into one switch.
function mergeSwitches(changes, newSnapshot) {
  const droppedByCoach = new Map();
  for (const c of changes) {
    if (c.type === 'dropped') droppedByCoach.set(coachKey(c.entry, c.from), c);
  }

  const consumed = new Set();
  const merged = [];
  for (const c of changes) {
    if (c.type !== 'added') continue;
    const key = coachKey(c.entry, c.to);
    const drop = droppedByCoach.get(key);
    if (!drop || consumed.has(drop)) continue;

    consumed.add(drop);
    consumed.add(c);
    // The vacated team is only "open" if nobody else took it in this same
    // update — if they did, that team has its own 'changed'/'added' entry.
    const vacatedAbbrev = Object.keys(newSnapshot || {}).find(a => newSnapshot[a].teamName === drop.team);
    const vacatedOpen = vacatedAbbrev ? !newSnapshot[vacatedAbbrev].coach : true;
    merged.push({
      type: 'switched',
      team: c.team,              // sorts under the new team
      fromTeam: drop.team,
      toTeam: c.team,
      vacatedOpen,
      entry: c.entry,
    });
  }
  return [...changes.filter(c => !consumed.has(c)), ...merged];
}

function changeLine(c) {
  const who = c.entry && c.type !== 'dropped' ? coachDisplay(c.entry) : c.from;
  switch (c.type) {
    case 'switched': return `🔀 ${who} switched teams — ${c.fromTeam} → **${c.toTeam}**`
      + (c.vacatedOpen ? ` · ${c.fromTeam} now open` : '');
    case 'added':   return `➕ **${c.team}** — ${who} joined`;
    case 'dropped': return `➖ **${c.team}** — ${c.from} left (now open)`;
    case 'changed': return `🔄 **${c.team}** — ${c.from} → ${who}`;
    case 'joined':  return `🆕 **${c.team}** added to ${c.to}`;
    case 'left':    return `🚫 **${c.team}** removed from the roster`;
    default:        return `↔️ **${c.team}** moved ${c.from} → ${c.to}`;
  }
}

function buildChangelogEmbed(league, season, changes, actorName) {
  const lines = changes.map(changeLine);
  let description = lines.join('\n');
  if (description.length > 4000) {
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
    .setTitle(`Roster updated — ${league.name} ${seasonLabel(season)}`)
    .setDescription(description)
    .setFooter({ text: `${count} ${count === 1 ? 'change' : 'changes'} · by ${actorName}` })
    .setTimestamp();
}

async function pinQuietly(message) {
  try { await message.pin(); } catch (err) {
    logger.warn('Could not pin roster post', { error: err.message });
  }
}

// Send every page as its own message and remember the ids in order. Only the
// first page is pinned — pinning all of them would bury the channel's pin list.
// Remove messages we previously owned. Used before a repost so a partially
// deleted multi-page roster doesn't leave stale pages beside the new ones.
async function deletePages(channel, ids) {
  for (const id of ids) {
    try {
      const msg = await channel.messages.fetch(id);
      await msg.delete();
    } catch {
      // Already gone, or we can't delete it — nothing useful to do either way.
    }
  }
}

async function sendFreshPost(channel, league, season, snapshot) {
  const embeds = buildRosterEmbeds(league, season, snapshot);
  const ids = [];
  for (const [i, embed] of embeds.entries()) {
    const msg = await channel.send({ embeds: [embed] });
    if (i === 0) await pinQuietly(msg);
    ids.push(msg.id);
  }
  upsertRosterPost(season.id, channel.id, ids, snapshot);
  return ids;
}

// Edit the existing pages in place, adding or removing trailing messages when
// the page count changes (a league that grows past a page boundary mid-season).
// Returns the new id list, or null if a page we expected to edit is gone — the
// caller treats that as "repost from scratch" rather than leaving a half-edited
// roster split across stale messages.
async function editExistingPost(channel, league, season, snapshot, existingIds) {
  const embeds = buildRosterEmbeds(league, season, snapshot);
  const ids = [];

  for (let i = 0; i < embeds.length; i++) {
    if (i < existingIds.length) {
      let message;
      try {
        message = await channel.messages.fetch(existingIds[i]);
      } catch {
        return null;   // a page was deleted — rebuild the whole post
      }
      await message.edit({ embeds: [embeds[i]] });
      ids.push(message.id);
    } else {
      const msg = await channel.send({ embeds: [embeds[i]] });   // roster grew a page
      ids.push(msg.id);
    }
  }

  // Roster shrank a page — delete the now-orphaned trailing messages.
  for (const staleId of existingIds.slice(embeds.length)) {
    try {
      const msg = await channel.messages.fetch(staleId);
      await msg.delete();
    } catch (err) {
      logger.warn('Could not delete orphaned roster page', { id: staleId, error: err.message });
    }
  }

  upsertRosterPost(season.id, channel.id, ids, snapshot);
  return ids;
}

// Publish (first time this season) or update (edit-in-place + changelog).
// Returns { action: 'published'|'updated'|'republished'|'unchanged', changed }.
async function publishOrUpdateRosterPost(league, season, actorName) {
  if (!league.roster_channel_id) {
    throw new Error('No roster channel configured for this league.');
  }

  const snapshot = buildRosterSnapshot(season.id);
  if (!Object.keys(snapshot).length) {
    throw new Error('This season has no teams yet — assign a coach first.');
  }

  const client = require('../bot/client');
  const channel = await client.channels.fetch(league.roster_channel_id);
  if (!channel) throw new Error('Configured roster channel could not be found.');

  const existing = getRosterPost(season.id);

  // First publish for this season, or the channel was reconfigured → fresh post.
  if (!existing || existing.channel_id !== league.roster_channel_id || !existing.message_ids.length) {
    await sendFreshPost(channel, league, season, snapshot);
    logger.info('Published roster post', { seasonId: season.id, channel: channel.id });
    return { action: 'published', changed: [] };
  }

  const changes = diffRoster(existing.posted_roster, snapshot);
  const edited = await editExistingPost(channel, league, season, snapshot, existing.message_ids);
  if (!edited) {
    // Someone deleted a page — self-heal by reposting, but announce nothing.
    // Clear whatever pages survived first, or they'd linger beside the new set
    // showing stale assignments with no record tying them back to us.
    await deletePages(channel, existing.message_ids);
    await sendFreshPost(channel, league, season, snapshot);
    logger.info('Roster post was missing; republished', { seasonId: season.id });
    return { action: 'republished', changed: [] };
  }

  if (changes.length) {
    await channel.send({ embeds: [buildChangelogEmbed(league, season, changes, actorName)] });
    logger.info('Updated roster post + changelog', { seasonId: season.id, changes: changes.length });
    return { action: 'updated', changed: changes };
  }
  logger.info('Roster post refreshed with no assignment changes', { seasonId: season.id });
  return { action: 'unchanged', changed: [] };
}

module.exports = {
  buildRosterSnapshot,
  buildRosterEmbeds,
  diffRoster,
  buildChangelogEmbed,
  publishOrUpdateRosterPost,
};
