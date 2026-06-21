'use strict';

let currentUser = null;
let currentGuildId = null;
let allUsers = [];
let allLeagues = [];
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
let pendingMatchups = [];
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
      u.league_name.toLowerCase().includes(q) ||
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
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <div style="font-weight:600;">${esc(u.discord_username)}</div>
        <div class="text-muted" style="font-size:11px;">${esc(u.discord_id)}</div>
      </td>
      <td><span class="badge badge-blue">${esc(u.league_abbr)}</span> ${esc(u.league_name)}</td>
      <td>${u.team_name ? esc(u.team_name) : '<span class="text-muted">—</span>'}</td>
      <td>${platforms || '<span class="text-muted">None</span>'}</td>
      <td>
        <button class="btn btn-danger btn-sm"
          onclick="removeFromLeague('${esc(u.discord_id)}', ${u.league_id}, '${esc(u.discord_username)}', '${esc(u.league_name)}')">
          Remove
        </button>
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
  const res = await fetch(`/api/guilds/${currentGuildId}/leagues`);
  allLeagues = await res.json();
  renderLeagues(allLeagues);
  populateAdvanceLeagues(allLeagues);
  populateLeagueFilters(allLeagues);
  populateDynLeagues(allLeagues);
}

function renderLeagues(leagues) {
  const el = document.getElementById('leagues-list');
  if (!leagues.length) { el.innerHTML = '<p class="text-muted">No leagues configured.</p>'; return; }
  el.innerHTML = leagues.map(l => `
    <div class="card">
      <div class="card-title">${esc(l.name)} <span class="badge badge-blue">${esc(l.abbr)}</span></div>
      <div style="display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:8px; font-size:13px;">
        <div><span class="text-muted">PPV Channel:</span> ${l.ppv_channel_id ? `<code>#${l.ppv_channel_id}</code>` : '<span class="text-muted">—</span>'}</div>
        <div><span class="text-muted">Advance Channel:</span> ${l.advance_channel_id ? `<code>#${l.advance_channel_id}</code>` : '<span class="text-muted">—</span>'}</div>
        <div><span class="text-muted">User Channel:</span> ${l.user_channel_id ? `<code>#${l.user_channel_id}</code>` : '<span class="text-muted">—</span>'}</div>
        <div><span class="text-muted">Ping Role:</span> ${l.ping_role_id ? `<code>${l.ping_role_id}</code>` : '<span class="text-muted">—</span>'}</div>
        <div><span class="text-muted">Staff Role:</span> ${l.staff_role_id ? `<code>${l.staff_role_id}</code>` : '<span class="text-muted">—</span>'}</div>
        <div><span class="text-muted">Schedule URL:</span> ${l.schedule_url ? '<span class="badge badge-green">✓ Set</span>' : '<span class="text-muted">—</span>'}</div>
      </div>
    </div>
  `).join('');
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
  else if (name === 'schedule') { populateScheduleSelects(); loadSchedule(); }
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
      <td><strong>${esc(t.team_abbrev)}</strong> ${esc(t.team_name)} ${t.is_user_team ? '<span class="badge badge-yellow">user</span>' : ''}</td>
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
}
function renderCoaches(assignMap) {
  const tb = document.getElementById('coaches-tbody');
  if (!allCoaches.length) { tb.innerHTML = '<tr><td colspan="3" class="text-muted" style="text-align:center;padding:16px;">No coaches added</td></tr>'; return; }
  const teamOpts = allTeams.map(t => `<option value="${esc(t.team_abbrev)}">${esc(t.team_abbrev)} — ${esc(t.team_name)}</option>`).join('');
  tb.innerHTML = allCoaches.map(c => `
    <tr>
      <td><strong>${esc(c.display_name)}</strong></td>
      <td>${c.discord_id ? esc(c.discord_username || c.discord_id) : '<span class="text-muted">—</span>'}</td>
      <td>
        <select id="assign-${c.id}"><option value="">— none —</option>${teamOpts}</select>
        <button class="btn btn-primary btn-sm" onclick="assignCoach(${c.id})">Assign</button>
      </td>
    </tr>`).join('');
  for (const c of allCoaches) {
    const sel = document.getElementById(`assign-${c.id}`);
    if (sel) sel.value = assignMap.get(c.id) || '';
  }
}
async function addCoach() {
  const displayName = document.getElementById('coach-name').value.trim();
  const discordId = document.getElementById('coach-discord-id').value.trim();
  const discordUsername = document.getElementById('coach-discord-username').value.trim();
  if (!displayName && !discordId) { alert('Provide a coach name or Discord ID.'); return; }
  const res = await fetch(`/api/guilds/${currentGuildId}/leagues/${currentDynLeagueId}/coaches`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName, discordId, discordUsername }),
  });
  if (res.ok) {
    document.getElementById('coach-name').value = '';
    document.getElementById('coach-discord-id').value = '';
    document.getElementById('coach-discord-username').value = '';
    await loadCoaches();
  } else {
    const d = await res.json();
    flash(d.error || 'Failed', 'error');
  }
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

// ── Schedule ──
function populateScheduleSelects() {
  buildWeekOptions('sched-week');
  const fill = () => {
    const opts = allTeams.map(t => `<option value="${esc(t.team_abbrev)}">${esc(t.team_abbrev)} — ${esc(t.team_name)}</option>`).join('');
    document.getElementById('sched-home').innerHTML = opts;
    document.getElementById('sched-away').innerHTML = opts;
  };
  if (!allTeams.length && currentSeasonId) {
    fetch(`/api/guilds/${currentGuildId}/seasons/${currentSeasonId}/teams`).then(r => r.json()).then(t => { allTeams = t; fill(); });
  } else fill();
}
async function loadSchedule() {
  if (!currentSeasonId) return;
  const week = document.getElementById('sched-week').value;
  document.getElementById('sched-week-label').textContent = weekLabelFor(week);
  const res = await fetch(`/api/guilds/${currentGuildId}/seasons/${currentSeasonId}/games?week=${week}`);
  renderScheduleTable(await res.json());
}
function renderScheduleTable(games) {
  const tb = document.getElementById('schedule-tbody');
  if (!games.length) { tb.innerHTML = '<tr><td colspan="5" class="text-muted" style="text-align:center;padding:16px;">No games scheduled</td></tr>'; return; }
  tb.innerHTML = games.map(g => {
    const played = g.result_type !== 'normal' || (g.home_score != null && g.away_score != null);
    return `<tr>
      <td>${esc(g.home_name)} <span class="text-muted">(${esc(g.home_abbrev)})</span></td>
      <td>${esc(g.away_name)} <span class="text-muted">(${esc(g.away_abbrev)})</span></td>
      <td>${g.is_user_game ? '<span class="badge badge-yellow">user</span>' : '<span class="text-muted">CPU</span>'}</td>
      <td>${played ? '<span class="badge badge-green">played</span>' : '<span class="text-muted">scheduled</span>'}</td>
      <td><button class="btn btn-danger btn-sm" onclick="deleteGame(${g.id})">Delete</button></td>
    </tr>`;
  }).join('');
}
function stageMatchup() {
  const home = document.getElementById('sched-home').value;
  const away = document.getElementById('sched-away').value;
  if (!home || !away || home === away) { flash('Pick two different teams', 'error', 'sched-result'); return; }
  pendingMatchups.push({ homeAbbrev: home, awayAbbrev: away });
  renderPending();
}
function renderPending() {
  document.getElementById('sched-pending').innerHTML = pendingMatchups.map((m, i) =>
    `<span class="matchup-chip">${esc(m.awayAbbrev)} @ ${esc(m.homeAbbrev)} <button onclick="unstage(${i})">✕</button></span>`
  ).join('');
  document.getElementById('sched-save-btn').disabled = pendingMatchups.length === 0;
}
function unstage(i) { pendingMatchups.splice(i, 1); renderPending(); }
async function saveSchedule() {
  if (!pendingMatchups.length) return;
  const week = Number(document.getElementById('sched-week').value);
  const res = await fetch(`/api/guilds/${currentGuildId}/seasons/${currentSeasonId}/games`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ week, isPostseason: week >= 15, matchups: pendingMatchups }),
  });
  const data = await res.json();
  if (data.ok) { flash(`Saved ${data.count} game(s)`, 'success', 'sched-result'); pendingMatchups = []; renderPending(); await loadSchedule(); }
  else flash(data.error || 'Failed', 'error', 'sched-result');
}
async function deleteGame(id) {
  if (!confirm('Delete this game?')) return;
  await fetch(`/api/guilds/${currentGuildId}/seasons/${currentSeasonId}/games/${id}`, { method: 'DELETE' });
  await loadSchedule();
}

// ── Results ──
async function loadResults() {
  if (!currentSeasonId) return;
  buildWeekOptions('results-week');
  const week = document.getElementById('results-week').value;
  const res = await fetch(`/api/guilds/${currentGuildId}/seasons/${currentSeasonId}/games?week=${week}`);
  renderResults(await res.json());
}
function renderResults(games) {
  const tb = document.getElementById('results-tbody');
  if (!games.length) { tb.innerHTML = '<tr><td colspan="8" class="text-muted" style="text-align:center;padding:16px;">No games scheduled for this week</td></tr>'; return; }
  tb.innerHTML = games.map(g => {
    const rt = g.result_type || 'normal';
    return `<tr data-game="${g.id}">
      <td><strong>${esc(g.home_abbrev)}</strong></td>
      <td><input class="grid-input" type="number" id="hs-${g.id}" value="${g.home_score ?? ''}"></td>
      <td><strong>${esc(g.away_abbrev)}</strong></td>
      <td><input class="grid-input" type="number" id="as-${g.id}" value="${g.away_score ?? ''}"></td>
      <td><input class="grid-input" type="number" id="at-${g.id}" value="${g.attempts_taken ?? ''}"></td>
      <td><select class="grid-input wide" id="rt-${g.id}" onchange="toggleWinner(${g.id})">
        <option value="normal" ${rt === 'normal' ? 'selected' : ''}>Normal</option>
        <option value="FR" ${rt === 'FR' ? 'selected' : ''}>FR</option>
        <option value="FS" ${rt === 'FS' ? 'selected' : ''}>FS</option>
      </select></td>
      <td><select class="grid-input wide" id="wn-${g.id}" ${rt === 'normal' ? 'disabled' : ''}>
        <option value="">—</option>
        <option value="home" ${g.winner_side === 'home' ? 'selected' : ''}>${esc(g.home_abbrev)}</option>
        <option value="away" ${g.winner_side === 'away' ? 'selected' : ''}>${esc(g.away_abbrev)}</option>
      </select></td>
      <td><button class="btn btn-primary btn-sm" onclick="saveResult(${g.id})">Save</button></td>
    </tr>`;
  }).join('');
}
function toggleWinner(id) {
  document.getElementById(`wn-${id}`).disabled = document.getElementById(`rt-${id}`).value === 'normal';
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

init();
