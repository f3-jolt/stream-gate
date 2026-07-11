'use strict';

let currentUser = null;
let currentGuildId = null;
let allUsers = [];
let allLeagues = [];            // active only — everything outside the Leagues tab
let allLeaguesWithInactive = []; // Leagues tab, so deactivated ones can be restored
let editingLeagueId = null;
let discordMeta = null;         // { channels, categories, roles } for the current guild
let allStreams = [];
let userSort = { col: 'discord_username', dir: 1 };
let streamSort = { col: 'posted_at', dir: -1 };

// ── Dynasty state ──
let allSeasons = [];
let currentSeasonId = null;
let currentDynLeagueId = null;
let allTeams = [];
let allCoaches = [];
let allConferences = [];
let summaryData = [];
let coachData = [];
let summarySort = { col: 'wins', dir: -1 };
let coachSort = { col: 'wins', dir: -1 };

const DYNASTY_TABS = new Set(['season', 'schedule', 'results', 'summary', 'coaches']);
const WEEK_LABELS = {
  0:'Week 0',1:'Week 1',2:'Week 2',3:'Week 3',4:'Week 4',5:'Week 5',6:'Week 6',7:'Week 7',
  8:'Week 8',9:'Week 9',10:'Week 10',11:'Week 11',12:'Week 12',13:'Week 13',14:'Week 14',
  15:'CCW',16:'Bowl Week 1',17:'Bowl Week 2',18:'CFP Semi Finals',19:'National Championship',
};

// ── Bootstrap ──────────────────────────────────────────────────────────────────

async function init() {
  const params = new URLSearchParams(location.search);
  if (params.get('error') === 'auth_failed') {
    showLoginPage('Authentication failed. Please try again.');
    return;
  }

  try {
    const res = await fetch('/api/guilds');
    if (res.status === 401) { showLoginPage(); return; }
    const guilds = await res.json();
    currentUser = await (await fetch('/auth/me')).json();
    showPortal(guilds);
  } catch {
    showLoginPage();
  }
}

function showLoginPage(errorMsg) {
  document.getElementById('login-page').style.display = 'flex';
  document.getElementById('portal').style.display = 'none';
  if (errorMsg) {
    const el = document.getElementById('login-error');
    el.textContent = errorMsg;
    el.style.display = 'block';
  }
}

function showPortal(guilds) {
  document.getElementById('login-page').style.display = 'none';
  document.getElementById('portal').style.display = 'flex';

  fetchMe();

  const sel = document.getElementById('guild-select');
  for (const g of guilds) {
    const opt = document.createElement('option');
    opt.value = g.id;
    opt.textContent = g.name;
    sel.appendChild(opt);
  }

  if (guilds.length === 1) {
    sel.value = guilds[0].id;
    onGuildChange();
  }
}

async function fetchMe() {
  const res = await fetch('/auth/me');
  if (!res.ok) return;
  const user = await res.json();
  document.getElementById('user-name').textContent = user.username;
  if (user.avatar) {
    document.getElementById('user-avatar').src = `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=32`;
  } else {
    document.getElementById('user-avatar').style.display = 'none';
  }
}

async function onGuildChange() {
  const sel = document.getElementById('guild-select');
  currentGuildId = sel.value;
  discordMeta = null; // channels and roles are per-guild
  if (!currentGuildId) { document.getElementById('main-content').style.display = 'none'; return; }
  document.getElementById('main-content').style.display = 'block';
  await Promise.all([loadUsers(), loadLeagues(), loadStreams(), loadHealth()]);
}

function logout() { location.href = '/auth/logout'; }

// ── Tabs ───────────────────────────────────────────────────────────────────────

function switchTab(name, btn) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`tab-${name}`).classList.add('active');
  btn.classList.add('active');
  document.getElementById('dynasty-bar').style.display = DYNASTY_TABS.has(name) ? 'flex' : 'none';
  if (DYNASTY_TABS.has(name)) onDynastyTabShown(name);
}

// ── Flash ──────────────────────────────────────────────────────────────────────

function flash(msg, type = 'success', targetId = 'flash') {
  const el = document.getElementById(targetId);
  el.textContent = msg;
  el.className = `flash ${type} show`;
  setTimeout(() => { el.className = 'flash'; }, 4000);
}

// ── Users ──────────────────────────────────────────────────────────────────────

async function loadUsers() {
  const res = await fetch(`/api/guilds/${currentGuildId}/users`);
  allUsers = await res.json();
  applyUserFilters();
}

function applyUserFilters() {
  const q = (document.getElementById('user-search').value || '').toLowerCase();
  const leagueFilter = document.getElementById('user-league-filter').value;

  let filtered = allUsers.filter(u => {
    const matchesText = !q ||
      u.discord_username.toLowerCase().includes(q) ||
      u.discord_id.includes(q) ||
      (u.league_name || '').toLowerCase().includes(q) ||
      (u.team_name || '').toLowerCase().includes(q);
    const matchesLeague = !leagueFilter || String(u.league_id) === leagueFilter;
    return matchesText && matchesLeague;
  });

  filtered = sortData(filtered, userSort.col, userSort.dir);
  renderUsers(filtered);
  updateSortHeaders('users-table', userSort);
}

// Keep filterUsers as alias so existing callers (if any) still work
function filterUsers() { applyUserFilters(); }

function sortUsers(col) {
  if (userSort.col === col) {
    userSort.dir *= -1;
  } else {
    userSort.col = col;
    userSort.dir = 1;
  }
  applyUserFilters();
}

function renderUsers(users) {
  const tbody = document.getElementById('users-tbody');
  tbody.innerHTML = '';
  if (!users.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-muted" style="text-align:center;padding:24px;">No users registered</td></tr>';
    return;
  }
  for (const u of users) {
    const platforms = u.platforms.map(p =>
      `<span class="badge badge-${p.platform === 'twitch' ? 'blue' : 'red'}">${p.platform}: ${p.platform_username}${p.subscription_id ? ' ✓' : ''}</span>`
    ).join(' ');
    const leagueCell = u.league_id
      ? `<span class="badge badge-blue">${esc(u.league_abbr)}</span> ${esc(u.league_name)}`
      : '<span class="badge">Unassigned</span>';
    const removeBtn = u.league_id
      ? `<button class="btn btn-danger btn-sm"
          onclick="removeFromLeague('${esc(u.discord_id)}', ${u.league_id}, '${esc(u.discord_username)}', '${esc(u.league_name)}')">
          Remove
        </button>`
      : '';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <div style="font-weight:600;">${esc(u.discord_username)}</div>
        <div class="text-muted" style="font-size:11px;">${esc(u.discord_id)}</div>
      </td>
      <td>${leagueCell}</td>
      <td>${u.team_name ? esc(u.team_name) : '<span class="text-muted">—</span>'}</td>
      <td>${platforms || '<span class="text-muted">None</span>'}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-ghost btn-sm" onclick="openStreamModal('${esc(u.discord_id)}')">Edit</button>
        ${removeBtn}
      </td>
    `;
    tbody.appendChild(tr);
  }
}

async function removeFromLeague(discordId, leagueId, username, leagueName) {
  if (!confirm(`Remove ${username} from ${leagueName}?`)) return;
  const res = await fetch(`/api/guilds/${currentGuildId}/users/${discordId}/league/${leagueId}`, { method: 'DELETE' });
  const data = await res.json();
  if (data.ok) { flash(`Removed ${username} from ${leagueName}`); await loadUsers(); }
  else flash(data.error || 'Remove failed', 'error');
}

// ── Edit stream details modal ───────────────────────────────────────────────────

let editingStreamDiscordId = null;

function openStreamModal(discordId) {
  const user = allUsers.find(u => u.discord_id === discordId);
  if (!user) return;
  editingStreamDiscordId = discordId;

  const byPlatform = {};
  for (const p of user.platforms) byPlatform[p.platform] = p.platform_username;

  document.getElementById('stream-modal-user').textContent =
    `${user.discord_username} (${user.discord_id})`;
  document.getElementById('stream-twitch').value = byPlatform.twitch || '';
  document.getElementById('stream-youtube').value = byPlatform.youtube || '';
  document.getElementById('stream-modal').classList.add('open');
}

function closeStreamModal() {
  editingStreamDiscordId = null;
  document.getElementById('stream-modal').classList.remove('open');
}

async function submitStreamEdit() {
  if (!editingStreamDiscordId) return;
  const twitch = document.getElementById('stream-twitch').value.trim();
  const youtube = document.getElementById('stream-youtube').value.trim();

  const res = await fetch(
    `/api/guilds/${currentGuildId}/users/${editingStreamDiscordId}/platforms`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ twitch, youtube }),
    }
  );
  const data = await res.json();
  if (data.ok) {
    flash('Stream details updated');
    closeStreamModal();
    await loadUsers();
  } else {
    flash(data.error || 'Update failed', 'error');
  }
}

// ── Register modal ─────────────────────────────────────────────────────────────

function openRegisterModal() {
  const sel = document.getElementById('reg-league');
  sel.innerHTML = allLeagues.map(l => `<option value="${l.id}">${l.name} (${l.abbr})</option>`).join('');
  document.getElementById('register-modal').classList.add('open');
}

function closeRegisterModal() {
  document.getElementById('register-modal').classList.remove('open');
}

async function submitRegister() {
  const discordId = document.getElementById('reg-discord-id').value.trim();
  const discordUsername = document.getElementById('reg-discord-username').value.trim();
  const platform = document.getElementById('reg-platform').value;
  const platformUsername = document.getElementById('reg-platform-username').value.trim();
  const leagueId = document.getElementById('reg-league').value;
  const teamName = document.getElementById('reg-team-name').value.trim();
  const teamAbbrev = document.getElementById('reg-team-abbrev').value.trim();

  if (!discordId || !platformUsername) {
    alert('Discord ID and Platform Username are required.');
    return;
  }

  const res = await fetch(`/api/guilds/${currentGuildId}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ discordId, discordUsername, platform, platformUsername, leagueId, teamName, teamAbbrev }),
  });
  const data = await res.json();
  if (data.ok) {
    flash('User registered successfully');
    closeRegisterModal();
    await loadUsers();
  } else {
    flash(data.error || 'Registration failed', 'error');
  }
}

// ── Leagues ────────────────────────────────────────────────────────────────────

async function loadLeagues() {
  // The Leagues tab shows deactivated leagues so they can be reactivated;
  // everything else in the portal only ever sees the active ones.
  const res = await fetch(`/api/guilds/${currentGuildId}/leagues?includeInactive=1`);
  allLeaguesWithInactive = await res.json();
  allLeagues = allLeaguesWithInactive.filter(l => l.active);
  // Best-effort: lets the cards show channel/role names instead of raw ids.
  await loadDiscordMeta().catch(() => {});
  renderLeagues(allLeaguesWithInactive);
  populateAdvanceLeagues(allLeagues);
  populateLeagueFilters(allLeagues);
  populateDynLeagues(allLeagues);
}

// Resolve a snowflake to its Discord name, falling back to the raw id when the
// bot can't see it (deleted channel, missing permissions, bot offline).
function discordLabel(id, kind) {
  if (!id) return '<span class="text-muted">—</span>';
  const lists = {
    channel: [discordMeta?.channels, '#'],
    category: [discordMeta?.categories, ''],
    role: [discordMeta?.roles, '@'],
  };
  const [list, prefix] = lists[kind];
  const match = list?.find(x => x.id === id);
  return match
    ? `<code>${prefix}${esc(match.name)}</code>`
    : `<code title="Not visible to the bot">${esc(id)}</code>`;
}

function renderLeagues(leagues) {
  const el = document.getElementById('leagues-list');
  if (!leagues.length) { el.innerHTML = '<p class="text-muted">No leagues configured.</p>'; return; }
  el.innerHTML = leagues.map(l => `
    <div class="card" ${l.active ? '' : 'style="opacity:.6;"'}>
      <div class="card-title">
        ${esc(l.name)} <span class="badge badge-blue">${esc(l.abbr)}</span>
        ${l.active ? '' : '<span class="badge badge-red">Deactivated</span>'}
        <span style="float:right; display:flex; gap:8px;">
          ${l.active ? `
            <button class="btn btn-ghost btn-sm" onclick="openLeagueModal(${l.id})">Edit</button>
            <button class="btn btn-danger btn-sm" onclick="deactivateLeague(${l.id})">Deactivate</button>
          ` : `
            <button class="btn btn-primary btn-sm" onclick="restoreLeague(${l.id})">Reactivate</button>
          `}
        </span>
      </div>
      <div style="display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:8px; font-size:13px;">
        <div><span class="text-muted">PPV Channel:</span> ${discordLabel(l.ppv_channel_id, 'channel')}</div>
        <div><span class="text-muted">Advance Channel:</span> ${discordLabel(l.advance_channel_id, 'channel')}</div>
        <div><span class="text-muted">User Channel:</span> ${discordLabel(l.user_channel_id, 'channel')}</div>
        <div><span class="text-muted">Category:</span> ${discordLabel(l.category_id, 'category')}</div>
        <div><span class="text-muted">Ping Role:</span> ${discordLabel(l.ping_role_id, 'role')}</div>
        <div><span class="text-muted">Staff Role:</span> ${discordLabel(l.staff_role_id, 'role')}</div>
        <div><span class="text-muted">Schedule URL:</span> ${l.schedule_url ? '<span class="badge badge-green">✓ Set</span>' : '<span class="text-muted">—</span>'}</div>
      </div>
    </div>
  `).join('');
}

// ── League modal ───────────────────────────────────────────────────────────────

async function loadDiscordMeta() {
  if (discordMeta) return discordMeta;
  const res = await fetch(`/api/guilds/${currentGuildId}/discord/channels-roles`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  discordMeta = data;
  return discordMeta;
}

// Channels arrive sorted by Discord position; group them under their category
// heading the way Discord's own sidebar does.
function channelOptions(channels) {
  const groups = new Map();
  for (const c of channels) {
    const key = c.category ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  return [...groups.entries()].map(([category, items]) => {
    const opts = items.map(c => `<option value="${esc(c.id)}"># ${esc(c.name)}</option>`).join('');
    return category ? `<optgroup label="${esc(category)}">${opts}</optgroup>` : opts;
  }).join('');
}

// A saved channel/role can be deleted in Discord, or invisible to the bot. Keep
// the raw id as an option so editing an unrelated field never silently drops it.
function fillPicker(elementId, optionsHtml, knownIds, currentId, placeholder) {
  const el = document.getElementById(elementId);
  const orphan = currentId && !knownIds.has(currentId)
    ? `<option value="${esc(currentId)}">Unknown — ${esc(currentId)}</option>`
    : '';
  el.innerHTML = `<option value="">${esc(placeholder)}</option>${orphan}${optionsHtml}`;
  el.value = currentId ?? '';
}

// leagueId omitted => create mode; the keyword is the stream-routing key and is
// immutable once streams have been posted against it.
async function openLeagueModal(leagueId = null) {
  const league = leagueId ? allLeaguesWithInactive.find(l => l.id === leagueId) : null;
  editingLeagueId = league ? league.id : null;

  document.getElementById('league-modal-title').textContent = league ? `Edit ${league.name}` : 'New League';
  document.getElementById('league-save-btn').textContent = league ? 'Save Changes' : 'Create League';

  const abbrInput = document.getElementById('league-abbr');
  abbrInput.value = league ? league.abbr : '';
  abbrInput.disabled = Boolean(league);
  document.getElementById('league-abbr-hint').style.display = league ? 'none' : '';

  document.getElementById('league-name').value = league?.name ?? '';
  document.getElementById('league-schedule-url').value = league?.schedule_url ?? '';

  const warning = document.getElementById('league-discord-warning');
  warning.style.display = 'none';

  let meta = { channels: [], categories: [], roles: [] };
  try {
    meta = await loadDiscordMeta();
  } catch (err) {
    warning.textContent = `Couldn't load channels and roles from Discord (${err.message}). `
      + 'Existing selections are preserved, but new ones cannot be picked until the bot is back online.';
    warning.style.display = '';
  }

  const chanIds = new Set(meta.channels.map(c => c.id));
  const catIds = new Set(meta.categories.map(c => c.id));
  const roleIds = new Set(meta.roles.map(r => r.id));
  const chanOpts = channelOptions(meta.channels);
  const catOpts = meta.categories.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  const roleOpts = meta.roles.map(r => `<option value="${esc(r.id)}">@${esc(r.name)}</option>`).join('');

  fillPicker('league-ppv-channel', chanOpts, chanIds, league?.ppv_channel_id, 'Select a channel…');
  fillPicker('league-advance-channel', chanOpts, chanIds, league?.advance_channel_id, '— None —');
  fillPicker('league-user-channel', chanOpts, chanIds, league?.user_channel_id, '— None —');
  fillPicker('league-category', catOpts, catIds, league?.category_id, '— None —');
  fillPicker('league-ping-role', roleOpts, roleIds, league?.ping_role_id, '— None —');
  fillPicker('league-staff-role', roleOpts, roleIds, league?.staff_role_id, '— None —');

  document.getElementById('league-modal').classList.add('open');
}

function closeLeagueModal() {
  document.getElementById('league-modal').classList.remove('open');
  editingLeagueId = null;
}

async function submitLeague() {
  const body = {
    name: document.getElementById('league-name').value.trim(),
    abbr: document.getElementById('league-abbr').value.trim().toUpperCase(),
    ppvChannelId: document.getElementById('league-ppv-channel').value.trim(),
    categoryId: document.getElementById('league-category').value.trim(),
    pingRoleId: document.getElementById('league-ping-role').value.trim(),
    advanceChannelId: document.getElementById('league-advance-channel').value.trim(),
    userChannelId: document.getElementById('league-user-channel').value.trim(),
    staffRoleId: document.getElementById('league-staff-role').value.trim(),
    scheduleUrl: document.getElementById('league-schedule-url').value.trim(),
  };

  if (!body.name || !body.abbr || !body.ppvChannelId) {
    alert('Name, Keyword, and PPV Channel are required.');
    return;
  }

  const editing = editingLeagueId !== null;
  const url = editing
    ? `/api/guilds/${currentGuildId}/leagues/${editingLeagueId}`
    : `/api/guilds/${currentGuildId}/leagues`;

  const res = await fetch(url, {
    method: editing ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();

  if (data.ok) {
    flash(editing ? `Updated ${body.name}` : `Created ${body.name}`);
    closeLeagueModal();
    await loadLeagues();
  } else {
    flash(data.error || 'Save failed', 'error');
  }
}

async function deactivateLeague(leagueId) {
  const league = allLeaguesWithInactive.find(l => l.id === leagueId);
  if (!league) return;
  if (!confirm(
    `Deactivate ${league.name}?\n\n`
    + 'It will be hidden from registration, stream routing, and every dropdown. '
    + 'Members, seasons, and stream history are preserved and it can be reactivated later.'
  )) return;

  const res = await fetch(`/api/guilds/${currentGuildId}/leagues/${leagueId}`, { method: 'DELETE' });
  const data = await res.json();
  if (data.ok) {
    flash(`Deactivated ${league.name}`);
    await Promise.all([loadLeagues(), loadUsers()]);
  } else {
    flash(data.error || 'Deactivate failed', 'error');
  }
}

async function restoreLeague(leagueId) {
  const league = allLeaguesWithInactive.find(l => l.id === leagueId);
  if (!league) return;

  const res = await fetch(`/api/guilds/${currentGuildId}/leagues/${leagueId}/restore`, { method: 'POST' });
  const data = await res.json();
  if (data.ok) {
    flash(`Reactivated ${league.name}`);
    await Promise.all([loadLeagues(), loadUsers()]);
  } else {
    flash(data.error || 'Reactivate failed', 'error');
  }
}

function populateAdvanceLeagues(leagues) {
  const sel = document.getElementById('advance-league');
  sel.innerHTML = leagues.map(l => `<option value="${esc(l.abbr)}">${esc(l.name)} (${esc(l.abbr)})</option>`).join('');
}

function populateLeagueFilters(leagues) {
  const opts = leagues.map(l => `<option value="${l.id}">${esc(l.name)} (${esc(l.abbr)})</option>`).join('');
  document.getElementById('user-league-filter').innerHTML = `<option value="">All Leagues</option>${opts}`;
  document.getElementById('stream-league-filter').innerHTML = `<option value="">All Leagues</option>${opts}`;
}

// ── Streams ────────────────────────────────────────────────────────────────────

async function loadStreams() {
  const res = await fetch(`/api/guilds/${currentGuildId}/streams`);
  allStreams = await res.json();
  applyStreamFilters();
}

function applyStreamFilters() {
  const q = (document.getElementById('stream-search').value || '').toLowerCase();
  const leagueFilter = document.getElementById('stream-league-filter').value;

  let filtered = allStreams.filter(s => {
    const matchesText = !q ||
      (s.discord_username || s.discord_user_id).toLowerCase().includes(q) ||
      (s.stream_title || '').toLowerCase().includes(q) ||
      s.platform.toLowerCase().includes(q);
    const matchesLeague = !leagueFilter || String(s.league_id) === leagueFilter;
    return matchesText && matchesLeague;
  });

  filtered = sortData(filtered, streamSort.col, streamSort.dir);
  renderStreams(filtered);
  updateSortHeaders('streams-tbody', streamSort, true);
}

function sortStreams(col) {
  if (streamSort.col === col) {
    streamSort.dir *= -1;
  } else {
    streamSort.col = col;
    streamSort.dir = col === 'posted_at' ? -1 : 1;
  }
  applyStreamFilters();
}

function renderStreams(streams) {
  const tbody = document.getElementById('streams-tbody');
  if (!streams.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-muted" style="text-align:center;padding:24px;">No streams recorded</td></tr>';
    return;
  }
  tbody.innerHTML = streams.map(s => `
    <tr>
      <td class="text-muted" style="white-space:nowrap;">${fmtDate(s.posted_at)}</td>
      <td>${esc(s.discord_username || s.discord_user_id)}</td>
      <td><span class="badge badge-blue">${esc(s.league_abbr)}</span></td>
      <td><span class="badge badge-${s.platform === 'twitch' ? 'blue' : 'red'}">${esc(s.platform)}</span></td>
      <td>${s.stream_title ? esc(s.stream_title) : '<span class="text-muted">—</span>'}</td>
    </tr>
  `).join('');
}

// ── Health ─────────────────────────────────────────────────────────────────────

async function loadHealth() {
  const res = await fetch(`/api/guilds/${currentGuildId}/health`);
  const h = await res.json();
  document.getElementById('health-stats').innerHTML = `
    <div class="stat-card">
      <div class="label">Registered Users</div>
      <div class="value">${h.totalUsers}</div>
    </div>
    <div class="stat-card">
      <div class="label">Twitch Subs</div>
      <div class="value" style="color:${h.twitchSubs === h.twitchTotal ? 'var(--success)' : 'var(--danger)'};">${h.twitchSubs}/${h.twitchTotal}</div>
    </div>
    <div class="stat-card">
      <div class="label">YouTube Subs</div>
      <div class="value" style="color:${h.youtubeSubs === h.youtubeTotal ? 'var(--success)' : 'var(--danger)'};">${h.youtubeSubs}/${h.youtubeTotal}</div>
    </div>
    <div class="stat-card">
      <div class="label">Stuck Routes</div>
      <div class="value" style="color:${h.stuckRoutes === 0 ? 'var(--success)' : 'var(--danger)'};">${h.stuckRoutes}</div>
    </div>
  `;
}

// ── Advance ────────────────────────────────────────────────────────────────────

function formatDateOverride() {
  const val = document.getElementById('advance-date-override').value;
  const tz  = document.getElementById('advance-tz').value;
  if (!val) return '';

  const [datePart, timePart] = val.split('T');
  const [year, month, day]   = datePart.split('-').map(Number);
  const [hour, minute]       = timePart.split(':').map(Number);

  const date     = new Date(year, month - 1, day, hour, minute);
  const weekday  = date.toLocaleDateString('en-US', { weekday: 'long' });
  const monthStr = date.toLocaleDateString('en-US', { month: 'long' });
  const ones = day % 10, teens = day % 100;
  const suffix = (teens >= 11 && teens <= 13) ? 'th' : (ones === 1 ? 'st' : ones === 2 ? 'nd' : ones === 3 ? 'rd' : 'th');
  const h        = hour % 12 || 12;
  const m        = minute.toString().padStart(2, '0');
  const ampm     = hour < 12 ? 'AM' : 'PM';

  return `${weekday}, ${monthStr} ${day}${suffix} at ${h}:${m} ${ampm} ${tz}`;
}

async function previewAdvance() {
  const leagueAbbr   = document.getElementById('advance-league').value;
  const week         = document.getElementById('advance-week').value;
  const dateOverride = formatDateOverride();
  if (!leagueAbbr) return;

  const params = new URLSearchParams({ leagueAbbr, week });
  if (dateOverride) params.set('dateOverride', dateOverride);
  const res = await fetch(`/api/guilds/${currentGuildId}/advance/preview?${params}`);
  const data = await res.json();

  const box = document.getElementById('advance-preview-box');
  const content = document.getElementById('advance-preview-content');

  if (data.ok) {
    content.textContent = data.message;
    box.style.display = 'block';
    document.getElementById('advance-result').classList.remove('show');
  } else {
    box.style.display = 'none';
    flash(data.error || 'Failed to load preview', 'error', 'advance-result');
  }
}

async function postAdvance() {
  const leagueAbbr   = document.getElementById('advance-league').value;
  const week         = document.getElementById('advance-week').value;
  const dateOverride = formatDateOverride();
  if (!leagueAbbr) return;

  const body = { leagueAbbr, week: Number(week) };
  if (dateOverride) body.dateOverride = dateOverride;

  const res = await fetch(`/api/guilds/${currentGuildId}/advance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.ok) {
    const threadMsg = data.threadCount > 0 ? ` ${data.threadCount} scheduling thread(s) created.` : '';
    flash(`Advancement posted.${threadMsg}`, 'success', 'advance-result');
  } else {
    flash(data.error || 'Failed', 'error', 'advance-result');
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Dynasty: seasons, teams, coaches, schedule, results, summaries
// ════════════════════════════════════════════════════════════════════════════

function buildWeekOptions(selectId) {
  const sel = document.getElementById(selectId);
  if (sel.options.length) return;
  sel.innerHTML = Object.entries(WEEK_LABELS).map(([v, n]) => `<option value="${v}">${n}</option>`).join('');
}
function weekLabelFor(v) { return WEEK_LABELS[Number(v)] ?? `Week ${v}`; }

function populateDynLeagues(leagues) {
  const sel = document.getElementById('dyn-league-select');
  sel.innerHTML = leagues.map(l => `<option value="${l.id}">${esc(l.name)} (${esc(l.abbr)})</option>`).join('');
  const tsel = document.getElementById('tmpl-league');
  tsel.innerHTML = leagues.map(l => `<option value="${l.id}">${esc(l.name)} (${esc(l.abbr)})</option>`).join('');
  if (leagues.length) {
    currentDynLeagueId = Number(leagues[0].id);
    loadSeasons();
    loadAdvanceTemplate();
  } else {
    currentDynLeagueId = null; allSeasons = []; currentSeasonId = null;
  }
}

function onDynLeagueChange() {
  currentDynLeagueId = Number(document.getElementById('dyn-league-select').value);
  loadSeasons();
}

function onDynSeasonChange() {
  currentSeasonId = Number(document.getElementById('dyn-season-select').value) || null;
  allTeams = [];
  updateCurrentBadge();
  refreshActiveDynastyTab();
}

async function loadSeasons() {
  if (!currentDynLeagueId) return;
  const res = await fetch(`/api/guilds/${currentGuildId}/leagues/${currentDynLeagueId}/seasons`);
  allSeasons = await res.json();
  const sel = document.getElementById('dyn-season-select');
  sel.innerHTML = allSeasons.map(s =>
    `<option value="${s.id}">${s.year}${s.label ? ' — ' + esc(s.label) : ''}${s.is_current ? ' (current)' : ''}</option>`
  ).join('');
  const current = allSeasons.find(s => s.is_current) || allSeasons[0];
  currentSeasonId = current ? current.id : null;
  if (current) sel.value = current.id;
  allTeams = [];
  updateCurrentBadge();
  refreshActiveDynastyTab();
}

function updateCurrentBadge() {
  const s = allSeasons.find(x => x.id === currentSeasonId);
  const el = document.getElementById('dyn-current-badge');
  el.innerHTML = !s ? '' : s.is_current
    ? '<span class="badge badge-green">current</span>'
    : '<span class="badge badge-yellow">not current</span>';
}

function refreshActiveDynastyTab() {
  for (const name of DYNASTY_TABS) {
    if (document.getElementById(`tab-${name}`).classList.contains('active')) { onDynastyTabShown(name); return; }
  }
}

function onDynastyTabShown(name) {
  if (name === 'season') { loadSeasonTeams(); loadCoaches(); }
  else if (name === 'schedule') loadScheduleTab();
  else if (name === 'results') loadResults();
  else if (name === 'summary') loadSummary();
  else if (name === 'coaches') loadCoachHistory();
}

// ── Season modal ──
function openSeasonModal() {
  if (!currentDynLeagueId) { alert('Select a league first.'); return; }
  document.getElementById('season-modal').classList.add('open');
}
function closeSeasonModal() { document.getElementById('season-modal').classList.remove('open'); }
async function submitSeason() {
  const year = document.getElementById('season-year').value.trim();
  const label = document.getElementById('season-label').value.trim();
  if (!year) { alert('Year is required.'); return; }
  const res = await fetch(`/api/guilds/${currentGuildId}/leagues/${currentDynLeagueId}/seasons`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ year: Number(year), label }),
  });
  const data = await res.json();
  if (data.id) {
    flash('Season created');
    closeSeasonModal();
    document.getElementById('season-year').value = '';
    document.getElementById('season-label').value = '';
    await loadSeasons();
  } else {
    flash(data.error || 'Failed to create season', 'error');
  }
}
async function setCurrentSeasonBtn() {
  if (!currentSeasonId) return;
  const res = await fetch(`/api/guilds/${currentGuildId}/leagues/${currentDynLeagueId}/current-season`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seasonId: currentSeasonId }),
  });
  const data = await res.json();
  if (data.ok) { flash('Marked as current season'); await loadSeasons(); }
  else flash(data.error || 'Failed', 'error');
}

// ── Conferences + team search ──
async function loadConferences() {
  const res = await fetch(`/api/guilds/${currentGuildId}/seasons/${currentSeasonId}/conferences`);
  allConferences = await res.json();
  document.getElementById('season-team-conf').innerHTML =
    '<option value="">— conference —</option>' +
    allConferences.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
}
async function addConferencePrompt() {
  if (!currentSeasonId) return;
  const name = prompt('Conference name:');
  if (!name) return;
  await fetch(`/api/guilds/${currentGuildId}/seasons/${currentSeasonId}/conferences`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  });
  await loadConferences();
  flash('Conference added');
}
let teamSearchTimer = null;
function teamSearch(q) {
  clearTimeout(teamSearchTimer);
  teamSearchTimer = setTimeout(async () => {
    const res = await fetch(`/api/guilds/${currentGuildId}/team-search?q=${encodeURIComponent(q)}`);
    const teams = await res.json();
    document.getElementById('team-options').innerHTML =
      teams.map(t => `<option value="${esc(t.value)}">${esc(t.name)}</option>`).join('');
  }, 150);
}

// ── Season teams ──
async function loadSeasonTeams() {
  document.getElementById('season-empty').style.display = currentSeasonId ? 'none' : 'block';
  document.getElementById('season-content').style.display = currentSeasonId ? 'block' : 'none';
  if (!currentSeasonId) return;
  await loadConferences();
  const res = await fetch(`/api/guilds/${currentGuildId}/seasons/${currentSeasonId}/teams`);
  allTeams = await res.json();
  renderSeasonTeams();
}
function renderSeasonTeams() {
  const tb = document.getElementById('teams-tbody');
  if (!allTeams.length) { tb.innerHTML = '<tr><td colspan="4" class="text-muted" style="text-align:center;padding:16px;">No teams added</td></tr>'; return; }
  tb.innerHTML = allTeams.map(t => `
    <tr>
      <td>${teamChip(t.team_abbrev, t.team_name, t.colors)} ${t.is_user_team ? '<span class="badge badge-yellow">user</span>' : ''}</td>
      <td>${t.conference_name ? esc(t.conference_name) : '<span class="text-muted">—</span>'}</td>
      <td>${t.coach_name ? esc(t.coach_name) : '<span class="text-muted">CPU</span>'}</td>
      <td><button class="btn btn-danger btn-sm" onclick="removeSeasonTeam('${esc(t.team_abbrev)}')">Remove</button></td>
    </tr>`).join('');
}
async function addSeasonTeam() {
  const teamAbbrev = document.getElementById('season-team-input').value.trim().toUpperCase();
  const conferenceId = document.getElementById('season-team-conf').value || null;
  if (!teamAbbrev) return;
  const res = await fetch(`/api/guilds/${currentGuildId}/seasons/${currentSeasonId}/teams`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamAbbrev, conferenceId }),
  });
  const data = await res.json();
  if (data.ok) { document.getElementById('season-team-input').value = ''; await loadSeasonTeams(); }
  else flash(data.error || 'Failed', 'error');
}
async function removeSeasonTeam(abbrev) {
  if (!confirm(`Remove ${abbrev} from this season?`)) return;
  await fetch(`/api/guilds/${currentGuildId}/seasons/${currentSeasonId}/teams/${encodeURIComponent(abbrev)}`, { method: 'DELETE' });
  await loadSeasonTeams();
}

// ── Coaches + assignments ──
async function loadCoaches() {
  if (!currentSeasonId || !currentDynLeagueId) return;
  const coachesRes = await fetch(`/api/guilds/${currentGuildId}/leagues/${currentDynLeagueId}/coaches`);
  allCoaches = await coachesRes.json();
  if (!allTeams.length) {
    const r = await fetch(`/api/guilds/${currentGuildId}/seasons/${currentSeasonId}/teams`);
    allTeams = await r.json();
  }
  const aRes = await fetch(`/api/guilds/${currentGuildId}/seasons/${currentSeasonId}/assignments`);
  const assignments = await aRes.json();
  const assignMap = new Map(assignments.map(a => [a.coach_id, a.team_abbrev]));
  renderCoaches(assignMap);
  populateCoachTeamSelect();
}
function populateCoachTeamSelect() {
  const sel = document.getElementById('coach-team');
  if (!sel) return;
  sel.innerHTML = '<option value="">— assign team —</option>' +
    allTeams.map(t => `<option value="${esc(t.team_abbrev)}">${esc(t.team_abbrev)} — ${esc(t.team_name)}</option>`).join('');
}
function renderCoaches(assignMap) {
  const tb = document.getElementById('coaches-tbody');
  if (!allCoaches.length) { tb.innerHTML = '<tr><td colspan="3" class="text-muted" style="text-align:center;padding:16px;">No coaches added</td></tr>'; return; }
  const teamOpts = allTeams.map(t => `<option value="${esc(t.team_abbrev)}">${esc(t.team_abbrev)} — ${esc(t.team_name)}</option>`).join('');
  tb.innerHTML = allCoaches.map(c => {
    const assigned = assignMap.get(c.id);
    const chip = assigned
      ? `<div style="margin-bottom:6px;">${teamChip(assigned, teamNameFor(assigned), colorsForTeam(assigned))}</div>`
      : '';
    return `
    <tr>
      <td><strong>${esc(c.display_name)}</strong></td>
      <td>${c.discord_id ? esc(c.discord_username || c.discord_id) : '<span class="text-muted">—</span>'}</td>
      <td>
        ${chip}
        <select id="assign-${c.id}"><option value="">— none —</option>${teamOpts}</select>
        <button class="btn btn-primary btn-sm" onclick="assignCoach(${c.id})">Assign</button>
      </td>
    </tr>`;
  }).join('');
  for (const c of allCoaches) {
    const sel = document.getElementById(`assign-${c.id}`);
    if (sel) sel.value = assignMap.get(c.id) || '';
  }
}
// ── Add coach via Discord user lookup (+ optional team in one step) ──
let selectedCoachUser = null;
let coachSearchResults = [];
let coachSearchTimer = null;

function onCoachSearchInput(q) {
  selectedCoachUser = null; // typing invalidates any prior selection
  clearTimeout(coachSearchTimer);
  if (!q || q.trim().length < 2) { hideCoachResults(); return; }
  coachSearchTimer = setTimeout(async () => {
    const res = await fetch(`/api/guilds/${currentGuildId}/discord-members?q=${encodeURIComponent(q.trim())}`);
    if (!res.ok) { hideCoachResults(); return; }
    coachSearchResults = await res.json();
    renderCoachResults();
  }, 250);
}
function renderCoachResults() {
  const box = document.getElementById('coach-search-results');
  if (!coachSearchResults.length) {
    box.innerHTML = '<div class="typeahead-empty">No matching members</div>';
  } else {
    box.innerHTML = coachSearchResults.map((u, i) =>
      `<div class="typeahead-item" onclick="pickCoachUser(${i})">${esc(u.display)} <span class="text-muted">@${esc(u.username)}</span></div>`
    ).join('');
  }
  box.style.display = 'block';
}
function pickCoachUser(i) {
  selectedCoachUser = coachSearchResults[i];
  document.getElementById('coach-search').value = `${selectedCoachUser.display} (@${selectedCoachUser.username})`;
  hideCoachResults();
}
function hideCoachResults() {
  const box = document.getElementById('coach-search-results');
  if (box) box.style.display = 'none';
}

async function addCoach() {
  if (!selectedCoachUser) { alert('Search for and select a Discord user first.'); return; }
  const teamAbbrev = document.getElementById('coach-team').value;

  const res = await fetch(`/api/guilds/${currentGuildId}/leagues/${currentDynLeagueId}/coaches`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      discordId: selectedCoachUser.id,
      discordUsername: selectedCoachUser.username,
      displayName: selectedCoachUser.display,
    }),
  });
  if (!res.ok) { const d = await res.json(); flash(d.error || 'Failed to add coach', 'error'); return; }
  const coach = await res.json();

  if (teamAbbrev) {
    const ar = await fetch(`/api/guilds/${currentGuildId}/seasons/${currentSeasonId}/assignments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coachId: coach.id, teamAbbrev }),
    });
    const ad = await ar.json();
    if (!ad.ok) { flash(ad.error || 'Coach added, but team assignment failed', 'error'); }
    else flash(`Added ${selectedCoachUser.display} → ${teamAbbrev}`);
  } else {
    flash(`Added ${selectedCoachUser.display}`);
  }

  selectedCoachUser = null;
  document.getElementById('coach-search').value = '';
  document.getElementById('coach-team').value = '';
  await loadSeasonTeams();
  await loadCoaches();
}
async function assignCoach(coachId) {
  const teamAbbrev = document.getElementById(`assign-${coachId}`).value;
  if (!teamAbbrev) return;
  const res = await fetch(`/api/guilds/${currentGuildId}/seasons/${currentSeasonId}/assignments`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ coachId, teamAbbrev }),
  });
  const data = await res.json();
  if (data.ok) { flash('Coach assigned'); await loadSeasonTeams(); await loadCoaches(); }
  else flash(data.error || 'Failed', 'error');
}

// ── Schedule (all-teams card board) ──
let oppMetaTimers = {};
let seasonGames = [];       // all games in the season (for scheduling-rule checks)
let scheduleFilter = '';

// Reusable team chip (logo + shaded colors); also used by the Season tab.
function teamChip(abbrev, name, colors) {
  return `<span class="team-chip" style="background:${shadeFor(colors || [])}">`
    + `<img class="team-chip-logo" src="${logoUrl(abbrev)}" alt="" onerror="this.style.display='none'">`
    + `<strong>${esc(abbrev)}</strong>${name ? ' ' + esc(name) : ''}</span>`;
}
function colorsForTeam(abbrev) { const t = allTeams.find(x => x.team_abbrev === abbrev); return t ? t.colors : []; }
function teamNameFor(abbrev) { const t = allTeams.find(x => x.team_abbrev === abbrev); return t ? t.team_name : abbrev; }

function logoUrl(abbrev) { return `/api/guilds/${currentGuildId}/team-logo/${encodeURIComponent(abbrev)}`; }

function hexToRgba(hex, a) {
  if (!hex || typeof hex !== 'string') return `rgba(88,101,242,${a})`;
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (h.length !== 6 || /[^0-9a-f]/i.test(h)) return `rgba(88,101,242,${a})`;
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
function shadeFor(colors) {
  if (!colors || !colors.length) return 'transparent';
  const c1 = hexToRgba(colors[0], 0.34);
  const c2 = colors[1] ? hexToRgba(colors[1], 0.14) : hexToRgba(colors[0], 0.08);
  return `linear-gradient(90deg, ${c1}, ${c2})`;
}

async function loadScheduleTab() {
  const wrap = document.getElementById('schedule-cards');
  if (!currentSeasonId) { wrap.innerHTML = '<p class="text-muted" style="padding:16px;">Select a season to build schedules.</p>'; return; }
  const [teamsRes, gamesRes] = await Promise.all([
    fetch(`/api/guilds/${currentGuildId}/seasons/${currentSeasonId}/teams`),
    fetch(`/api/guilds/${currentGuildId}/seasons/${currentSeasonId}/games`),
  ]);
  allTeams = await teamsRes.json();
  seasonGames = await gamesRes.json();
  renderScheduleCards();
}

function filterScheduleCards(v) { scheduleFilter = (v || '').toLowerCase(); renderScheduleCards(); }

function renderScheduleCards() {
  const wrap = document.getElementById('schedule-cards');
  if (!allTeams.length) { wrap.innerHTML = '<p class="text-muted" style="padding:16px;">No teams on the roster yet — add them in the Season tab.</p>'; return; }
  const f = scheduleFilter;
  const teams = allTeams.filter(t => !f || t.team_abbrev.toLowerCase().includes(f) || (t.team_name || '').toLowerCase().includes(f));
  wrap.innerHTML = teams.length ? teams.map(scheduleCardHtml).join('') : '<p class="text-muted" style="padding:16px;">No teams match.</p>';
}

function scheduleCardHtml(t) {
  const abbr = t.team_abbrev;
  const byWeek = new Map();
  for (const g of seasonGames) {
    if (g.home_abbrev === abbr || g.away_abbrev === abbr) byWeek.set(g.week, g);
  }
  const headerBg = (t.colors && t.colors.length)
    ? `linear-gradient(90deg, ${hexToRgba(t.colors[0], 0.9)}, ${hexToRgba(t.colors[1] || t.colors[0], 0.55)})`
    : 'var(--surface2)';
  let rows = '';
  for (let w = 0; w <= 14; w++) {
    const g = byWeek.get(w);
    const isHome = g ? g.home_abbrev === abbr : true;
    const opp = g ? (isHome ? g.away_abbrev : g.home_abbrev) : '';
    const colors = g ? ((isHome ? g.away_colors : g.home_colors) || []) : [];
    const user = g ? g.is_user_game === 1 : false;
    const has = !!opp;
    rows += `<tr>
      <td class="wk">W${w}</td>
      <td>
        <div class="opp-cell" id="oppcell-${abbr}-${w}" style="background:${has ? shadeFor(colors) : 'transparent'};">
          <img class="opp-logo" id="opplogo-${abbr}-${w}" alt="" ${has ? `src="${logoUrl(opp)}"` : ''}
               onerror="this.style.visibility='hidden'" style="${has ? '' : 'visibility:hidden;'}">
          <input class="grid-input opp-input" list="team-options" id="opp-${abbr}-${w}" value="${esc(opp || '')}"
                 placeholder="BYE" oninput="onOppChange('${abbr}',${w})">
        </div>
      </td>
      <td>
        <div class="side-toggle" id="sidewrap-${abbr}-${w}" style="${has ? '' : 'display:none;'}">
          <span class="side-label ${isHome ? 'active' : ''}" id="sidehome-${abbr}-${w}">H</span>
          <label class="switch"><input type="checkbox" id="side-${abbr}-${w}" ${!isHome ? 'checked' : ''} onchange="onSideToggle('${abbr}',${w})"><span class="slider"></span></label>
          <span class="side-label ${!isHome ? 'active' : ''}" id="sideaway-${abbr}-${w}">A</span>
        </div>
      </td>
      <td style="text-align:center;">
        <input type="checkbox" id="user-${abbr}-${w}" ${user ? 'checked' : ''} onchange="this.dataset.touched='1'" style="${has ? '' : 'display:none;'}">
      </td>
    </tr>`;
  }
  return `<div class="sched-card">
    <div class="sched-card-head" style="background:${headerBg};">
      <img class="sched-card-logo" src="${logoUrl(abbr)}" alt="" onerror="this.style.display='none'">
      <span>${esc(t.team_name)} <small>(${esc(abbr)})</small></span>
      ${t.is_user_team ? '<span class="badge badge-yellow" style="margin-left:auto;">user</span>' : ''}
    </div>
    <table class="sched-card-table"><tbody>${rows}</tbody></table>
    <div class="sched-card-foot">
      <button class="btn btn-primary btn-sm" onclick="saveCard('${abbr}')">Save ${esc(abbr)}</button>
      <span id="cardflash-${abbr}" class="card-flash"></span>
    </div>
  </div>`;
}

const gid = (prefix, abbr, w) => document.getElementById(`${prefix}-${abbr}-${w}`);

// Teams playing another matchup in week w — not selectable as this team's opponent (rule 2).
function bookedThatWeek(abbr, w) {
  const set = new Set();
  for (const g of seasonGames) {
    if (g.week !== w) continue;
    if (g.home_abbrev === abbr || g.away_abbrev === abbr) continue;
    set.add(g.home_abbrev); set.add(g.away_abbrev);
  }
  return set;
}

// Abbrevs not selectable for (abbr, w): self (rule 1), busy that week (rule 2),
// already on this team's card (rule 3).
function excludedForRow(abbr, w) {
  const set = new Set([abbr]);
  bookedThatWeek(abbr, w).forEach(a => set.add(a));
  for (let i = 0; i <= 14; i++) {
    if (i === w) continue;
    const v = (gid('opp', abbr, i)?.value || '').trim().toUpperCase();
    if (v) set.add(v);
  }
  return set;
}

function teamSearchForRow(q, abbr, w) {
  clearTimeout(teamSearchTimer);
  teamSearchTimer = setTimeout(async () => {
    const res = await fetch(`/api/guilds/${currentGuildId}/team-search?q=${encodeURIComponent(q)}`);
    const excl = excludedForRow(abbr, w);
    const teams = (await res.json()).filter(t => !excl.has(t.value.toUpperCase()));
    document.getElementById('team-options').innerHTML =
      teams.map(t => `<option value="${esc(t.value)}">${esc(t.name)}</option>`).join('');
  }, 150);
}

// Opponent changed: refill the (filtered) catalog list, toggle the side+user
// controls (hidden for a BYE), refresh the logo and color shading.
function onOppChange(abbr, w) {
  const val = (gid('opp', abbr, w).value || '').trim();
  teamSearchForRow(val, abbr, w);
  markUserDefault(abbr, w);
  const has = !!val;
  gid('sidewrap', abbr, w).style.display = has ? '' : 'none';
  gid('user', abbr, w).style.display = has ? '' : 'none';
  const img = gid('opplogo', abbr, w);
  const cell = gid('oppcell', abbr, w);
  if (!has) { img.style.visibility = 'hidden'; cell.style.background = 'transparent'; return; }
  img.src = logoUrl(val.toUpperCase());
  img.style.visibility = 'visible';
  const key = `${abbr}-${w}`;
  clearTimeout(oppMetaTimers[key]);
  oppMetaTimers[key] = setTimeout(async () => {
    const r = await fetch(`/api/guilds/${currentGuildId}/team-meta/${encodeURIComponent(val.toUpperCase())}`);
    cell.style.background = r.ok ? shadeFor((await r.json()).colors) : 'transparent';
  }, 300);
}

function onSideToggle(abbr, w) {
  const away = gid('side', abbr, w).checked;
  gid('sidehome', abbr, w).classList.toggle('active', !away);
  gid('sideaway', abbr, w).classList.toggle('active', away);
}

// Default the user-game checkbox when an opponent is entered (unless manually set).
// User game = this team and the opponent are both coached.
function markUserDefault(abbr, w) {
  const cb = gid('user', abbr, w);
  if (cb.dataset.touched) return;
  const coached = new Set(allTeams.filter(t => t.is_user_team).map(t => t.team_abbrev));
  const opp = (gid('opp', abbr, w).value || '').trim().toUpperCase();
  cb.checked = coached.has(abbr) && coached.has(opp);
}

// Validate one card against the scheduling rules before sending (the server also
// enforces them, but catching here keeps the in-progress edits from being lost).
function validateCard(abbr) {
  const T = abbr.toUpperCase();
  const seen = new Map(); // opponent abbrev -> week already scheduled
  // Seed with this team's postseason opponents (not editable in the 0–14 grid).
  for (const g of seasonGames) {
    if (g.week > 14 && (g.home_abbrev === T || g.away_abbrev === T)) {
      seen.set(g.home_abbrev === T ? g.away_abbrev : g.home_abbrev, g.week);
    }
  }
  for (let w = 0; w <= 14; w++) {
    const opp = (gid('opp', abbr, w).value || '').trim().toUpperCase();
    if (!opp) continue;
    if (opp === T) return `W${w}: a team can't play itself.`;
    if (seen.has(opp)) return `${opp} scheduled twice (W${seen.get(opp)} & W${w}) — no rematches.`;
    if (bookedThatWeek(abbr, w).has(opp)) return `${opp} is already booked in W${w}.`;
    seen.set(opp, w);
  }
  return null;
}

async function saveCard(abbr) {
  const err = validateCard(abbr);
  if (err) { flashCard(abbr, err, 'error'); return; }
  const weeks = [];
  for (let w = 0; w <= 14; w++) {
    const opp = (gid('opp', abbr, w).value || '').trim().toUpperCase();
    weeks.push({
      week: w,
      opponent: opp || null,
      isHome: !gid('side', abbr, w).checked, // toggle checked = Away
      isUserGame: gid('user', abbr, w).checked,
    });
  }
  const res = await fetch(`/api/guilds/${currentGuildId}/seasons/${currentSeasonId}/team-schedule`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ team: abbr, weeks }),
  });
  const data = await res.json();
  if (data.ok) { flashCard(abbr, 'Saved', 'success'); await loadScheduleTab(); }
  else flashCard(abbr, data.error || 'Failed', 'error');
}

function flashCard(abbr, msg, type) {
  const el = document.getElementById(`cardflash-${abbr}`);
  if (!el) return;
  el.textContent = msg;
  el.className = `card-flash ${type}`;
  setTimeout(() => {
    const e = document.getElementById(`cardflash-${abbr}`);
    if (e) { e.textContent = ''; e.className = 'card-flash'; }
  }, 4000);
}

// ── Results ──
async function loadResults() {
  if (!currentSeasonId) return;
  buildWeekOptions('results-week');
  const week = document.getElementById('results-week').value;
  const res = await fetch(`/api/guilds/${currentGuildId}/seasons/${currentSeasonId}/games?week=${week}`);
  renderResults(await res.json());
}
// Team cell for the results grid: logo + abbrev on the team's color shade, with a
// 👤 icon when the team is user-controlled (has a coach this season).
function resultTeamCell(abbrev, colors, isUser) {
  return `<span class="team-chip" style="background:${shadeFor(colors || [])}">`
    + `<img class="team-chip-logo" src="${logoUrl(abbrev)}" alt="" onerror="this.style.display='none'">`
    + `<strong>${esc(abbrev)}</strong>`
    + (isUser ? '<span class="user-badge" title="User-controlled team">👤</span>' : '')
    + `</span>`;
}

function renderResults(games) {
  const tb = document.getElementById('results-tbody');
  if (!games.length) { tb.innerHTML = '<tr><td colspan="8" class="text-muted" style="text-align:center;padding:16px;">No games scheduled for this week</td></tr>'; return; }
  tb.innerHTML = games.map(g => {
    const rt = g.result_type || 'normal';
    const sim = rt === 'FR' || rt === 'FS'; // forfeit / fair sim → no attempts
    return `<tr data-game="${g.id}">
      <td>${resultTeamCell(g.home_abbrev, g.home_colors, g.home_coach_id != null)}</td>
      <td><input class="grid-input" type="number" id="hs-${g.id}" value="${g.home_score ?? ''}"></td>
      <td>${resultTeamCell(g.away_abbrev, g.away_colors, g.away_coach_id != null)}</td>
      <td><input class="grid-input" type="number" id="as-${g.id}" value="${g.away_score ?? ''}"></td>
      <td><input class="grid-input" type="number" id="at-${g.id}" value="${g.attempts_taken ?? ''}" ${sim ? 'disabled' : ''}></td>
      <td><select class="grid-input wide" id="rt-${g.id}" onchange="toggleWinner(${g.id})">
        <option value="normal" ${rt === 'normal' ? 'selected' : ''}>Normal</option>
        <option value="FR" ${rt === 'FR' ? 'selected' : ''}>FR</option>
        <option value="FS" ${rt === 'FS' ? 'selected' : ''}>FS</option>
      </select></td>
      <td><select class="grid-input wide" id="wn-${g.id}" ${rt === 'FR' ? '' : 'disabled'}>
        <option value="">—</option>
        <option value="home" ${g.winner_side === 'home' ? 'selected' : ''}>${esc(g.home_abbrev)}</option>
        <option value="away" ${g.winner_side === 'away' ? 'selected' : ''}>${esc(g.away_abbrev)}</option>
      </select></td>
      <td><button class="btn btn-primary btn-sm" onclick="saveResult(${g.id})">Save</button></td>
    </tr>`;
  }).join('');
}
function toggleWinner(id) {
  const rt = document.getElementById(`rt-${id}`).value;
  const wn = document.getElementById(`wn-${id}`);
  const at = document.getElementById(`at-${id}`);
  // Only a forfeit (FR) forces a winner; FS/normal derive it from the score.
  wn.disabled = rt !== 'FR';
  if (rt !== 'FR') wn.value = '';
  // Forfeits and fair sims have no play attempts.
  const sim = rt === 'FR' || rt === 'FS';
  at.disabled = sim;
  if (sim) at.value = 0;
}
function readResultRow(id) {
  return {
    gameId: id,
    homeScore: document.getElementById(`hs-${id}`).value,
    awayScore: document.getElementById(`as-${id}`).value,
    attempts: document.getElementById(`at-${id}`).value,
    resultType: document.getElementById(`rt-${id}`).value,
    winnerSide: document.getElementById(`wn-${id}`).value || null,
  };
}
async function saveResult(id) {
  const res = await fetch(`/api/guilds/${currentGuildId}/seasons/${currentSeasonId}/games/${id}/result`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(readResultRow(id)),
  });
  const data = await res.json();
  if (data.ok) { flash('Result saved', 'success', 'results-result'); await loadResults(); }
  else flash(data.error || 'Failed', 'error', 'results-result');
}
async function saveAllResults() {
  const rows = [...document.querySelectorAll('#results-tbody tr[data-game]')].map(tr => readResultRow(Number(tr.dataset.game)));
  const results = rows.filter(r => r.homeScore !== '' || r.awayScore !== '' || r.resultType !== 'normal');
  if (!results.length) { flash('Nothing to save', 'error', 'results-result'); return; }
  const res = await fetch(`/api/guilds/${currentGuildId}/seasons/${currentSeasonId}/results`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ results }),
  });
  const data = await res.json();
  if (data.ok) { flash(`Saved ${data.saved} result(s)`, 'success', 'results-result'); await loadResults(); }
  else flash(data.error || 'Failed', 'error', 'results-result');
}

// ── Summary ──
async function loadSummary() {
  if (!currentSeasonId) return;
  const res = await fetch(`/api/guilds/${currentGuildId}/seasons/${currentSeasonId}/summary`);
  summaryData = await res.json();
  applySummary();
}
function applySummary() {
  renderSummary(sortData(summaryData, summarySort.col, summarySort.dir));
  updateSortHeaders('summary-table', summarySort);
}
function sortSummary(col) {
  if (summarySort.col === col) summarySort.dir *= -1; else { summarySort.col = col; summarySort.dir = 1; }
  applySummary();
}
function renderSummary(rows) {
  const tb = document.getElementById('summary-tbody');
  if (!rows.length) { tb.innerHTML = '<tr><td colspan="8" class="text-muted" style="text-align:center;padding:16px;">No results yet</td></tr>'; return; }
  tb.innerHTML = rows.map(r => `<tr>
    <td><strong>${esc(r.team_abbrev)}</strong> ${esc(r.team_name)}</td>
    <td>${r.conference_name ? esc(r.conference_name) : '<span class="text-muted">—</span>'}</td>
    <td>${r.wins}</td><td>${r.losses}</td><td>${r.ties}</td>
    <td>${r.points_for}</td><td>${r.points_against}</td>
    <td>${r.point_diff > 0 ? '+' : ''}${r.point_diff}</td>
  </tr>`).join('');
}

// ── Coach history ──
async function loadCoachHistory() {
  if (!currentDynLeagueId) return;
  const res = await fetch(`/api/guilds/${currentGuildId}/leagues/${currentDynLeagueId}/coach-history`);
  const rows = await res.json();
  coachData = rows.map(c => ({
    ...c,
    win_pct: (c.wins + c.losses) > 0 ? Math.round(c.wins / (c.wins + c.losses) * 1000) / 10 : 0,
  }));
  applyCoaches();
}
function applyCoaches() {
  renderCoachHistory(sortData(coachData, coachSort.col, coachSort.dir));
  updateSortHeaders('coach-history-table', coachSort);
}
function sortCoaches(col) {
  if (coachSort.col === col) coachSort.dir *= -1; else { coachSort.col = col; coachSort.dir = 1; }
  applyCoaches();
}
function renderCoachHistory(rows) {
  const tb = document.getElementById('coach-history-tbody');
  if (!rows.length) { tb.innerHTML = '<tr><td colspan="8" class="text-muted" style="text-align:center;padding:16px;">No coach results yet</td></tr>'; return; }
  tb.innerHTML = rows.map(c => `<tr class="clickable" onclick="openCoachDetail(${c.coach_id}, '${esc(c.display_name).replace(/'/g, "\\'")}')">
    <td><strong>${esc(c.display_name)}</strong></td>
    <td>${c.seasons_count}</td><td>${c.wins}</td><td>${c.losses}</td>
    <td>${c.win_pct}%</td><td>${c.natl_titles}</td><td>${c.conf_titles}</td><td>${c.teams_count}</td>
  </tr>`).join('');
}
async function openCoachDetail(coachId, name) {
  const res = await fetch(`/api/guilds/${currentGuildId}/coaches/${coachId}/history`);
  const data = await res.json();
  document.getElementById('coach-detail-title').textContent = `${name} — Season History`;
  const tb = document.getElementById('coach-detail-tbody');
  const rows = (data.seasons || []).map(s => `<tr>
    <td>${s.year}${s.label ? ' — ' + esc(s.label) : ''}</td>
    <td>${esc(s.teams || '')}</td>
    <td>${s.wins}</td><td>${s.losses}</td><td>${s.ties}</td><td>${s.points_for}</td><td>${s.points_against}</td>
  </tr>`).join('');
  tb.innerHTML = rows || '<tr><td colspan="7" class="text-muted">No games</td></tr>';
  document.getElementById('coach-detail-modal').classList.add('open');
}
function closeCoachDetail() { document.getElementById('coach-detail-modal').classList.remove('open'); }

// ── Advancement template ──
async function loadAdvanceTemplate() {
  const leagueId = document.getElementById('tmpl-league').value;
  if (!leagueId) return;
  const res = await fetch(`/api/guilds/${currentGuildId}/leagues/${leagueId}/advance-template`);
  const data = await res.json();
  document.getElementById('advance-template').value = data.template || '';
  if (data.default) document.getElementById('advance-template').placeholder = data.default;
}
async function saveAdvanceTemplate() {
  const leagueId = document.getElementById('tmpl-league').value;
  const template = document.getElementById('advance-template').value;
  const res = await fetch(`/api/guilds/${currentGuildId}/leagues/${leagueId}/advance-template`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ template }),
  });
  const data = await res.json();
  if (data.ok) flash('Template saved', 'success', 'tmpl-result');
  else flash(data.error || 'Failed', 'error', 'tmpl-result');
}

// ── Sort / filter helpers ──────────────────────────────────────────────────────

function sortData(arr, col, dir) {
  if (!col) return arr;
  return [...arr].sort((a, b) => {
    const ar = a[col], br = b[col];
    if (typeof ar === 'number' && typeof br === 'number') {
      return ar < br ? -dir : ar > br ? dir : 0;
    }
    const av = (ar ?? '').toString().toLowerCase();
    const bv = (br ?? '').toString().toLowerCase();
    return av < bv ? -dir : av > bv ? dir : 0;
  });
}

function updateSortHeaders(tableOrTbodyId, sort, isTbody = false) {
  const root = isTbody
    ? document.getElementById(tableOrTbodyId)?.closest('table')
    : document.getElementById(tableOrTbodyId);
  if (!root) return;
  root.querySelectorAll('th.sortable').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.col === sort.col) {
      th.classList.add(sort.dir === 1 ? 'sort-asc' : 'sort-desc');
    }
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
}

// Close modal on backdrop click
document.getElementById('register-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeRegisterModal();
});
document.getElementById('season-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeSeasonModal();
});
document.getElementById('coach-detail-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeCoachDetail();
});
document.getElementById('league-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeLeagueModal();
});
document.getElementById('stream-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeStreamModal();
});
// Dismiss the Discord-user typeahead when clicking elsewhere
document.addEventListener('click', e => {
  if (e.target.id !== 'coach-search' && !e.target.closest('#coach-search-results')) hideCoachResults();
});

init();
