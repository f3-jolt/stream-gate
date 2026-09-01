'use strict';

let currentUser = null;
let currentGuildId = null;
let currentLeagueId = null;      // global league scope; null = All Leagues
let activeTab = 'users';         // which tab is currently shown
let allUsers = [];
let allLeagues = [];            // active only — everything outside the Leagues tab
let allLeaguesWithInactive = []; // Leagues tab, so deactivated ones can be restored
let showDeactivatedLeagues = false; // Leagues tab hides deactivated ones until asked
let editingLeagueId = null;
let discordMeta = null;         // { channels, categories, roles } for the current guild
let allStreams = [];
let streamFilter = 'all';   // all | posted | skipped
let teamCatalog = [];
let showDeactivatedTeams = false;
let editingTeamAbbrev = null;   // null = add mode
let teamLogoData = null;        // base64 data URL from a file upload, pending save
let teamAssetVersion = 0;       // cache-buster for logo <img> after edits
let userSort = { col: 'discord_username', dir: 1 };
let showArchivedUsers = false;   // include memberships in deactivated leagues
let streamSort = { col: 'posted_at', dir: -1 };
let teamSort = { col: 'name', dir: 1 };

// ── Dynasty state ──
let allSeasons = [];
let currentSeasonId = null;
let currentDynLeagueId = null;
let allTeams = [];
let allCoaches = [];
let summaryData = [];
let coachData = [];
let summarySort = { col: 'wins', dir: -1 };
let coachSort = { col: 'wins', dir: -1 };
let coachAssignRows = [];
let coachAssignSort = { col: 'coach', dir: 1 };

const DYNASTY_TABS = new Set(['season', 'schedule', 'results', 'summary', 'coaches']);
// Tabs that act on one specific league and can't operate on "All Leagues".
const SINGLE_LEAGUE_TABS = new Set(['advance', 'season', 'schedule', 'results', 'summary', 'coaches', 'settings']);
// Mirror of src/utils/weeks.js — keep the two in step. `value` is what the
// database stores (frozen for the weeks that carry games), and the array order
// is the order a season plays them; `games: false` stages are admin work only,
// so they never reach the schedule builder or the results grid.
const WEEKS = [
  { value: -1, label: 'Preseason',                    short: 'Pre',      games: false },
  { value:  0, label: 'Week 0',                       short: 'W0',       games: true  },
  { value:  1, label: 'Week 1',                       short: 'W1',       games: true  },
  { value:  2, label: 'Week 2',                       short: 'W2',       games: true  },
  { value:  3, label: 'Week 3',                       short: 'W3',       games: true  },
  { value:  4, label: 'Week 4',                       short: 'W4',       games: true  },
  { value:  5, label: 'Week 5',                       short: 'W5',       games: true  },
  { value:  6, label: 'Week 6',                       short: 'W6',       games: true  },
  { value:  7, label: 'Week 7',                       short: 'W7',       games: true  },
  { value:  8, label: 'Week 8',                       short: 'W8',       games: true  },
  { value:  9, label: 'Week 9',                       short: 'W9',       games: true  },
  { value: 10, label: 'Week 10',                      short: 'W10',      games: true  },
  { value: 11, label: 'Week 11',                      short: 'W11',      games: true  },
  { value: 12, label: 'Week 12',                      short: 'W12',      games: true  },
  { value: 13, label: 'Week 13',                      short: 'W13',      games: true  },
  { value: 14, label: 'Week 14',                      short: 'W14',      games: true  },
  { value: 20, label: 'Week 15',                      short: 'W15',      games: false, years: y => y === 2026 },
  { value: 15, label: 'CCW',                          short: 'CCW',      games: true  },
  { value: 21, label: 'Week 16',                      short: 'W16',      games: false, years: y => y >= 2027 },
  { value: 16, label: 'Bowl Week 1',                  short: 'BW1',      games: true  },
  { value: 17, label: 'Bowl Week 2',                  short: 'BW2',      games: true  },
  { value: 18, label: 'CFP Semi-Finals',              short: 'CFP Semi', games: true  },
  { value: 19, label: 'National Championship',        short: 'NC',       games: true  },
  { value: 22, label: 'End of Season',                short: 'EOS',      games: false },
  { value: 23, label: 'Players Leaving',              short: 'Leaving',  games: false },
  { value: 24, label: 'Offseason Recruiting Week 1',  short: 'REC1',     games: false },
  { value: 25, label: 'Offseason Recruiting Week 2',  short: 'REC2',     games: false },
  { value: 26, label: 'Offseason Recruiting Week 3',  short: 'REC3',     games: false },
  { value: 27, label: 'Offseason Recruiting Week 4',  short: 'REC4',     games: false },
  { value: 28, label: 'National Signing Day',         short: 'NSD',      games: false },
  { value: 29, label: 'Training Results',             short: 'Training', games: false },
  { value: 30, label: 'Offseason',                    short: 'Off',      games: false },
];
const WEEK_BY_VALUE = new Map(WEEKS.map(w => [w.value, w]));
// Weeks that carry games, in playing order — their values run 0..19.
const GAME_WEEKS = WEEKS.filter(w => w.games);
// Highest week the schedule builder exposes (0–14 regular season, 15–19 postseason).
const SCHED_MAX_WEEK = 19;
function weekShort(w) { return WEEK_BY_VALUE.get(Number(w))?.short ?? `W${w}`; }
// The stages one season runs — the 2026 and 2027+ bye weeks differ.
function weeksForYear(year) {
  const y = Number(year);
  return WEEKS.filter(w => !w.years || (Number.isFinite(y) && w.years(y)));
}

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
  initAdvanceForm();

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
  currentLeagueId = null; // reset league scope when switching servers
  if (!currentGuildId) { document.getElementById('main-content').style.display = 'none'; return; }
  document.getElementById('main-content').style.display = 'block';
  await Promise.all([loadUsers(), loadLeagues(), loadStreams(), loadHealth(), loadTeams()]);
  renderActiveTab();
}

function logout() { location.href = '/auth/logout'; }

// ── Tabs & global league scope ───────────────────────────────────────────────────

function switchTab(name) {
  activeTab = name;
  renderActiveTab();
}

// Jump to the league management view (reached via the top-nav Configure button
// rather than a peer tab).
function openLeagueConfig() {
  activeTab = 'leagues';
  renderActiveTab();
}

// Single source of truth for which panel is shown, driven by activeTab +
// the global league selection.
function renderActiveTab() {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('configure-btn').classList.toggle('active', activeTab === 'leagues');
  document.querySelector(`.tab-btn[data-tab="${activeTab}"]`)?.classList.add('active');

  // A single-league tab with no league picked shows the prompt instead.
  const needsLeague = SINGLE_LEAGUE_TABS.has(activeTab) && !currentLeagueId;
  const panelId = needsLeague ? 'pick-league' : activeTab;
  document.getElementById(`tab-${panelId}`).classList.add('active');

  const showDynBar = DYNASTY_TABS.has(activeTab) && !needsLeague;
  document.getElementById('dynasty-bar').style.display = showDynBar ? 'flex' : 'none';
  if (showDynBar) onDynastyTabShown(activeTab);

  if (activeTab === 'settings' && !needsLeague) loadLeagueSettings();
  if (activeTab === 'advance' && !needsLeague) showAdvanceTab();
}

function currentLeague() {
  return allLeagues.find(l => l.id === currentLeagueId) || null;
}

function populateNavLeague(leagues) {
  const sel = document.getElementById('nav-league-select');
  const prev = currentLeagueId;
  sel.innerHTML = `<option value="">All Leagues</option>` +
    leagues.map(l => `<option value="${l.id}">${esc(l.name)} (${esc(l.abbr)})</option>`).join('');
  // Preserve the current pick across reloads when it still exists.
  if (prev && leagues.some(l => l.id === prev)) {
    sel.value = String(prev);
  } else {
    sel.value = '';
    currentLeagueId = null;
  }
}

function onNavLeagueChange() {
  const v = document.getElementById('nav-league-select').value;
  currentLeagueId = v ? Number(v) : null;
  applyUserFilters();
  applyStreamFilters();
  syncDynastyLeague();
  renderActiveTab();
}

// Point the dynasty/advance machinery at the globally-selected league.
function syncDynastyLeague() {
  currentDynLeagueId = currentLeagueId;
  const badge = document.getElementById('dyn-league-badge');
  const lg = currentLeague();
  if (badge) badge.textContent = lg ? `${lg.name} (${lg.abbr})` : '';
  if (currentDynLeagueId) {
    loadSeasons();
    loadAdvanceFooters();
  } else {
    allSeasons = []; currentSeasonId = null;
  }
}

// ── Flash ──────────────────────────────────────────────────────────────────────

// sticky keeps the message up until the next flash on the same target. Use it
// for errors the user has to act on — a 4-second auto-hide loses them.
function flash(msg, type = 'success', targetId = 'flash', sticky = false) {
  const el = document.getElementById(targetId);
  el.textContent = msg;
  el.className = `flash ${type} show`;
  clearTimeout(el._flashTimer);
  if (!sticky) el._flashTimer = setTimeout(() => { el.className = 'flash'; }, 4000);
}

// ── Users ──────────────────────────────────────────────────────────────────────

async function loadUsers() {
  const qs = showArchivedUsers ? '?includeInactive=1' : '';
  const res = await fetch(`/api/guilds/${currentGuildId}/users${qs}`);
  allUsers = await res.json();
  applyUserFilters();
}

function toggleArchivedUsers() {
  showArchivedUsers = !showArchivedUsers;
  document.getElementById('toggle-archived-users-btn').textContent =
    showArchivedUsers ? 'Hide archived' : 'Show archived';
  loadUsers();
}

function applyUserFilters() {
  const q = (document.getElementById('user-search').value || '').toLowerCase();

  let filtered = allUsers.filter(u => {
    const matchesText = !q ||
      u.discord_username.toLowerCase().includes(q) ||
      u.discord_id.includes(q) ||
      (u.league_name || '').toLowerCase().includes(q) ||
      (u.team_name || '').toLowerCase().includes(q);
    const matchesLeague = !currentLeagueId || u.league_id === currentLeagueId;
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
    const isArchived = Boolean(u.league_id) && u.league_active === 0;
    const leagueCell = u.league_id
      ? `<span class="badge badge-blue">${esc(u.league_abbr)}</span> ${esc(u.league_name)}${isArchived ? ' <span class="badge">archived</span>' : ''}`
      : '<span class="badge">Unassigned</span>';
    // Archived-league memberships are read-only (the league is deactivated).
    const removeBtn = (u.league_id && !isArchived)
      ? `<button class="btn btn-danger btn-sm"
          onclick="removeFromLeague('${esc(u.discord_id)}', ${u.league_id}, '${esc(u.discord_username)}', '${esc(u.league_name)}')">
          Remove
        </button>`
      : '';
    const tr = document.createElement('tr');
    if (isArchived) tr.style.opacity = '0.55';
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
  renderLeaguesList();
  populateNavLeague(allLeagues);
  syncDynastyLeague();
}

// Deactivated leagues are hidden by default; the toggle reveals them.
function renderLeaguesList() {
  const deactivatedCount = allLeaguesWithInactive.filter(l => !l.active).length;
  const list = showDeactivatedLeagues
    ? allLeaguesWithInactive
    : allLeaguesWithInactive.filter(l => l.active);

  const btn = document.getElementById('toggle-deactivated-btn');
  btn.style.display = deactivatedCount ? '' : 'none';
  btn.textContent = showDeactivatedLeagues
    ? 'Hide deactivated'
    : `Show deactivated (${deactivatedCount})`;

  renderLeagues(list);
}

function toggleDeactivatedLeagues() {
  showDeactivatedLeagues = !showDeactivatedLeagues;
  renderLeaguesList();
}

// ── Teams ────────────────────────────────────────────────────────────────────

async function loadTeams() {
  const res = await fetch(`/api/guilds/${currentGuildId}/teams`);
  teamCatalog = await res.json();
  applyTeamFilters();
}

function applyTeamFilters() {
  const q = (document.getElementById('team-search').value || '').toLowerCase();
  const deactivatedCount = teamCatalog.filter(t => !t.active).length;

  let filtered = teamCatalog.filter(t => {
    if (!showDeactivatedTeams && !t.active) return false;
    return !q ||
      t.name.toLowerCase().includes(q) ||
      t.abbrev.toLowerCase().includes(q) ||
      (t.conference || '').toLowerCase().includes(q) ||
      (t.mascot || '').toLowerCase().includes(q);
  });
  filtered = sortData(filtered, teamSort.col, teamSort.dir);

  const btn = document.getElementById('toggle-deactivated-teams-btn');
  btn.style.display = deactivatedCount ? '' : 'none';
  btn.textContent = showDeactivatedTeams ? 'Hide deactivated' : `Show deactivated (${deactivatedCount})`;

  renderTeams(filtered);
  updateSortHeaders('team-catalog-table', teamSort);
}

function sortTeams(col) {
  if (teamSort.col === col) teamSort.dir *= -1;
  else { teamSort.col = col; teamSort.dir = 1; }
  applyTeamFilters();
}

function toggleDeactivatedTeams() {
  showDeactivatedTeams = !showDeactivatedTeams;
  applyTeamFilters();
}

function renderTeams(teams) {
  const tbody = document.getElementById('team-catalog-tbody');
  if (!teams.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-muted" style="text-align:center;padding:24px;">No teams found</td></tr>';
    return;
  }
  tbody.innerHTML = teams.map(t => {
    const logo = t.has_logo
      ? `<img src="/api/guilds/${currentGuildId}/team-logo/${encodeURIComponent(t.abbrev)}?v=${teamAssetVersion}" alt="" style="width:32px;height:32px;object-fit:contain;" onerror="this.style.visibility='hidden'">`
      : '';
    const swatches = (t.colors || []).map(c =>
      `<span title="${esc(c)}" style="display:inline-block;width:16px;height:16px;border-radius:3px;border:1px solid var(--border);background:${esc(c)};"></span>`
    ).join(' ');
    const typeBadge = t.is_custom
      ? '<span class="badge badge-blue">Custom</span>'
      : '<span class="badge">NCAA</span>';
    const actions = t.active
      ? `<button class="btn btn-ghost btn-sm" onclick="openTeamModal('${esc(t.abbrev)}')">Edit</button>
         <button class="btn btn-danger btn-sm" onclick="deactivateTeam('${esc(t.abbrev)}','${esc(t.name)}')">Deactivate</button>`
      : `<button class="btn btn-primary btn-sm" onclick="restoreTeam('${esc(t.abbrev)}','${esc(t.name)}')">Reactivate</button>`;
    return `
      <tr ${t.active ? '' : 'style="opacity:.55;"'}>
        <td style="width:40px;">${logo}</td>
        <td>
          <div style="font-weight:600;">${esc(t.name)} ${t.active ? '' : '<span class="badge badge-red">Deactivated</span>'}</div>
          <div class="text-muted" style="font-size:11px;">${esc(t.abbrev)}${t.mascot ? ' · ' + esc(t.mascot) : ''}</div>
        </td>
        <td>${esc(t.conference || '—')}</td>
        <td>${typeBadge}</td>
        <td style="white-space:nowrap;">${swatches || '<span class="text-muted">—</span>'}</td>
        <td style="white-space:nowrap;">${actions}</td>
      </tr>`;
  }).join('');
}

function onTeamLogoFile(event) {
  const file = event.target.files[0];
  if (!file) { teamLogoData = null; return; }
  const reader = new FileReader();
  reader.onload = () => {
    teamLogoData = reader.result; // data URL
    const img = document.getElementById('team-logo-preview');
    img.src = teamLogoData;
    img.style.display = '';
    document.getElementById('team-logo-url').value = ''; // file wins over URL
  };
  reader.readAsDataURL(file);
}

function openTeamModal(abbrev = null) {
  const team = abbrev ? teamCatalog.find(t => t.abbrev === abbrev) : null;
  editingTeamAbbrev = team ? team.abbrev : null;
  teamLogoData = null;

  document.getElementById('team-modal-title').textContent = team ? `Edit ${team.name}` : 'Add Team';
  document.getElementById('team-save-btn').textContent = team ? 'Save Changes' : 'Add Team';

  document.getElementById('team-name').value = team?.name ?? '';
  const abbrevInput = document.getElementById('team-abbrev');
  abbrevInput.value = team?.abbrev ?? '';
  abbrevInput.disabled = Boolean(team); // routing key is locked once created
  document.getElementById('team-abbrev-hint').style.display = team ? 'none' : '';
  document.getElementById('team-conference').value = team?.conference ?? '';
  document.getElementById('team-mascot').value = team?.mascot ?? '';
  document.getElementById('team-color1').value = team?.colors?.[0] ?? '';
  document.getElementById('team-color2').value = team?.colors?.[1] ?? '';

  document.getElementById('team-logo-file').value = '';
  document.getElementById('team-logo-url').value = '';
  const preview = document.getElementById('team-logo-preview');
  if (team && team.has_logo) {
    preview.src = `/api/guilds/${currentGuildId}/team-logo/${encodeURIComponent(team.abbrev)}?v=${teamAssetVersion}`;
    preview.style.display = '';
  } else {
    preview.style.display = 'none';
  }

  document.getElementById('team-modal').classList.add('open');
}

function closeTeamModal() {
  editingTeamAbbrev = null;
  teamLogoData = null;
  document.getElementById('team-modal').classList.remove('open');
}

async function submitTeam() {
  const colors = [
    document.getElementById('team-color1').value.trim(),
    document.getElementById('team-color2').value.trim(),
  ].filter(Boolean);

  const body = {
    name: document.getElementById('team-name').value.trim(),
    conference: document.getElementById('team-conference').value.trim(),
    mascot: document.getElementById('team-mascot').value.trim(),
    colors,
  };
  const logoUrl = document.getElementById('team-logo-url').value.trim();
  if (teamLogoData) body.logoData = teamLogoData;
  else if (logoUrl) body.logoUrl = logoUrl;

  const editing = editingTeamAbbrev !== null;
  if (!editing) {
    body.abbrev = document.getElementById('team-abbrev').value.trim().toUpperCase();
    if (!body.name || !body.abbrev) { alert('Name and Abbreviation are required.'); return; }
  } else if (!body.name) {
    alert('Name is required.');
    return;
  }

  const url = editing
    ? `/api/guilds/${currentGuildId}/teams/${encodeURIComponent(editingTeamAbbrev)}`
    : `/api/guilds/${currentGuildId}/teams`;
  const res = await fetch(url, {
    method: editing ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.ok) {
    teamAssetVersion++; // bust cached logo <img> URLs
    flash(editing ? `Updated ${body.name}` : `Added ${body.name}`);
    closeTeamModal();
    await loadTeams();
  } else {
    flash(data.error || 'Save failed', 'error');
  }
}

async function deactivateTeam(abbrev, name) {
  if (!confirm(`Deactivate ${name}? It will be hidden from team selection.`)) return;
  const res = await fetch(`/api/guilds/${currentGuildId}/teams/${encodeURIComponent(abbrev)}/deactivate`, { method: 'POST' });
  const data = await res.json();
  if (data.ok) { flash(`Deactivated ${name}`); await loadTeams(); }
  else flash(data.error || 'Failed', 'error');
}

async function restoreTeam(abbrev, name) {
  const res = await fetch(`/api/guilds/${currentGuildId}/teams/${encodeURIComponent(abbrev)}/restore`, { method: 'POST' });
  const data = await res.json();
  if (data.ok) { flash(`Reactivated ${name}`); await loadTeams(); }
  else flash(data.error || 'Failed', 'error');
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
  fillPicker('league-settings-channel', chanOpts, chanIds, league?.settings_channel_id, '— None —');
  fillPicker('league-roster-channel', chanOpts, chanIds, league?.roster_channel_id, '— None —');
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
    settingsChannelId: document.getElementById('league-settings-channel').value.trim(),
    rosterChannelId: document.getElementById('league-roster-channel').value.trim(),
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

// ── Streams ────────────────────────────────────────────────────────────────────

// Friendly labels for the skip-reason codes emitted by the bot.
const STREAM_REASON_LABELS = {
  title_no_keyword: 'Title had no league keyword',
  user_not_registered: 'Streamer not registered',
  discord_id_mismatch: 'Posted from a different Discord account',
  not_league_member: 'Not a member of this league',
  already_posted: 'Already posted',
  disambiguation_sent: 'Awaiting league choice (DM sent)',
  stream_not_found: 'Twitch stream not found (API lag)',
  not_live_after_retries: "YouTube video wasn't live",
  channel_not_registered: 'YouTube channel not linked',
  youtube_channel_not_linked: 'YouTube channel not linked',
  youtube_channel_not_found: 'YouTube channel not found',
  youtube_no_video_id: 'No video ID in link',
  twitch_vod_not_found: 'Twitch VOD not found',
  stream_not_live: "Stream wasn't live",
  resolve_error: 'Error resolving stream',
};
function reasonLabel(code) {
  return code ? (STREAM_REASON_LABELS[code] || code) : '';
}

function setStreamFilter(f) {
  streamFilter = f;
  document.querySelectorAll('#stream-filter-group [data-filter]').forEach(b => {
    const active = b.dataset.filter === f;
    b.classList.toggle('btn-primary', active);
    b.classList.toggle('btn-ghost', !active);
  });
  loadStreams();
}

async function loadStreams() {
  const res = await fetch(`/api/guilds/${currentGuildId}/streams?filter=${streamFilter}`);
  allStreams = await res.json();
  applyStreamFilters();
}

function applyStreamFilters() {
  const q = (document.getElementById('stream-search').value || '').toLowerCase();

  let filtered = allStreams.filter(s => {
    const matchesText = !q ||
      (s.streamer || s.discord_username || '').toLowerCase().includes(q) ||
      (s.stream_title || '').toLowerCase().includes(q) ||
      (s.platform || '').toLowerCase().includes(q) ||
      reasonLabel(s.reason).toLowerCase().includes(q);
    // League-specific rows honor the nav league filter; rows with no league
    // (e.g. an unregistered streamer's skip) always show.
    const matchesLeague = !currentLeagueId || s.league_id === currentLeagueId || s.league_id == null;
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
    tbody.innerHTML = '<tr><td colspan="6" class="text-muted" style="text-align:center;padding:24px;">No streams recorded</td></tr>';
    return;
  }
  tbody.innerHTML = streams.map(s => {
    const streamer = s.streamer || s.discord_username;
    const league = s.league_abbr
      ? `<span class="badge badge-blue">${esc(s.league_abbr)}</span>`
      : '<span class="text-muted">—</span>';
    const result = s.outcome === 'posted'
      ? '<span class="badge badge-green">Posted</span>'
      : `<span class="badge badge-red">Skipped</span> <span class="text-muted" style="font-size:12px;">${esc(reasonLabel(s.reason))}</span>`;
    return `
    <tr>
      <td class="text-muted" style="white-space:nowrap;">${fmtDate(s.posted_at)}</td>
      <td>${streamer ? esc(streamer) : '<span class="text-muted">—</span>'}</td>
      <td>${league}</td>
      <td><span class="badge badge-${s.platform === 'twitch' ? 'blue' : 'red'}">${esc(s.platform)}</span></td>
      <td>${s.stream_title ? esc(s.stream_title) : '<span class="text-muted">—</span>'}</td>
      <td style="white-space:nowrap;">${result}</td>
    </tr>`;
  }).join('');
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
  renderHealthDetails(h);
}

// Drill-down panels for any metric that isn't healthy, listing the specific
// accounts/routes behind the number so an admin can act on them.
function renderHealthDetails(h) {
  const panels = [];

  const missingSubPanel = (title, platform, missing) => {
    if (!missing || !missing.length) return;
    const rows = missing.map(m => `
      <tr>
        <td>${esc(m.discord_username || m.discord_id)}</td>
        <td><span class="badge badge-${platform === 'twitch' ? 'blue' : 'red'}">${platform}: ${esc(m.platform_username)}</span></td>
      </tr>`).join('');
    panels.push(`
      <div class="detail-panel">
        <h3>${title} — ${missing.length} not subscribed</h3>
        <p class="text-muted" style="font-size:12px;margin:0 0 8px;">
          No active EventSub/WebSub subscription — the bot won't get a live notification for these accounts.
          Try re-saving the user's stream details (Edit on the Users tab) to re-subscribe.
        </p>
        <div class="table-wrap"><table><thead><tr><th>User</th><th>Account</th></tr></thead><tbody>${rows}</tbody></table></div>
      </div>`);
  };

  missingSubPanel('Twitch subscriptions', 'twitch', h.twitchMissing);
  missingSubPanel('YouTube subscriptions', 'youtube', h.youtubeMissing);

  if (h.stuckRouteDetails && h.stuckRouteDetails.length) {
    const rows = h.stuckRouteDetails.map(r => `
      <tr>
        <td>${esc(r.discord_username || r.user_name || r.discord_user_id)}</td>
        <td><span class="badge badge-${r.platform === 'twitch' ? 'blue' : 'red'}">${esc(r.platform)}</span></td>
        <td>${r.stream_title ? esc(r.stream_title) : '<span class="text-muted">—</span>'}</td>
        <td class="text-muted" style="white-space:nowrap;">${fmtDate(r.created_at)}</td>
      </tr>`).join('');
    panels.push(`
      <div class="detail-panel">
        <h3>Stuck routes — ${h.stuckRouteDetails.length}</h3>
        <p class="text-muted" style="font-size:12px;margin:0 0 8px;">
          The bot DM'd these streamers to pick a league and is still waiting (over 5 minutes). They haven't chosen yet.
        </p>
        <div class="table-wrap"><table><thead><tr><th>User</th><th>Platform</th><th>Stream</th><th>Waiting since</th></tr></thead><tbody>${rows}</tbody></table></div>
      </div>`);
  }

  const container = document.getElementById('health-details');
  container.innerHTML = panels.length
    ? panels.join('')
    : '<p class="text-muted" style="text-align:center;padding:16px;">Everything looks healthy — no issues to show.</p>';
}

// ── Advance ────────────────────────────────────────────────────────────────────

// Populate the time dropdown (30-minute steps only) and default the date to
// +2 days from today. Called once when the portal loads.
function initAdvanceForm() {
  const timeSel = document.getElementById('advance-time');
  if (timeSel && timeSel.options.length <= 1) {
    let opts = '<option value="">— time —</option>';
    for (let h = 0; h < 24; h++) {
      for (const m of [0, 30]) {
        const value = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        const label = `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
        opts += `<option value="${value}">${label}</option>`;
      }
    }
    timeSel.innerHTML = opts;
  }
  const dateInput = document.getElementById('advance-date');
  if (dateInput) {
    const d = new Date();
    d.setDate(d.getDate() + 2);
    dateInput.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
}

// offsetHours shifts the picked moment (e.g. -24 formats the start of a 24h
// advancement window that closes at the picked deadline).
function formatDateOverride(offsetHours = 0) {
  const datePart = document.getElementById('advance-date').value;
  const timePart = document.getElementById('advance-time').value;
  const tz       = document.getElementById('advance-tz').value;
  if (!datePart || !timePart) return '';

  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute]     = timePart.split(':').map(Number);

  const date     = new Date(year, month - 1, day, hour + offsetHours, minute);
  const weekday  = date.toLocaleDateString('en-US', { weekday: 'long' });
  const monthStr = date.toLocaleDateString('en-US', { month: 'long' });
  const dayNum   = date.getDate();
  const ones = dayNum % 10, teens = dayNum % 100;
  const suffix = (teens >= 11 && teens <= 13) ? 'th' : (ones === 1 ? 'st' : ones === 2 ? 'nd' : ones === 3 ? 'rd' : 'th');
  const h        = date.getHours() % 12 || 12;
  const m        = date.getMinutes().toString().padStart(2, '0');
  const ampm     = date.getHours() < 12 ? 'AM' : 'PM';

  return `${weekday}, ${monthStr} ${dayNum}${suffix} at ${h}:${m} ${ampm} ${tz}`;
}

// Label of the currently selected week, e.g. "Week 5" or "CCW", for prompts.
function selectedWeekLabel() {
  const sel = document.getElementById('advance-week');
  return sel.selectedOptions[0]?.textContent || `Week ${sel.value}`;
}

// ── Active week + matchup preview ──
// The league's current season and the week it's actively playing. Posting an
// advancement moves the active week to the week posted, so the picker opens on
// the NEXT week and the matchups below show what's about to go out.
let advanceSeason = null;
let advanceCurrentWeek = null;
// League the picker has been defaulted for, so bouncing between tabs doesn't
// throw away a week you deliberately selected.
let advanceWeekDefaultedFor = null;

function showAdvanceTab() {
  const keep = advanceWeekDefaultedFor === currentLeagueId;
  advanceWeekDefaultedFor = currentLeagueId;
  loadAdvanceState(keep ? document.getElementById('advance-week').value : null);
}

// Fetch the advance screen's state. week === null asks the server for the
// default (one past the active week) and moves the picker there; passing a week
// just reloads that week's matchups.
async function loadAdvanceState(week = null) {
  const leagueAbbr = currentLeague()?.abbr;
  const sel = document.getElementById('advance-week');
  if (!leagueAbbr || !sel) return;

  const params = new URLSearchParams({ leagueAbbr });
  if (week !== null) params.set('week', week);

  let data = null;
  try {
    const res = await fetch(`/api/guilds/${currentGuildId}/advance/state?${params}`);
    data = await res.json();
  } catch { /* network hiccup — fall through to the empty render */ }

  if (!data?.ok) {
    advanceSeason = null;
    advanceCurrentWeek = null;
    buildAdvanceWeekOptions(null);
    renderAdvanceWeek([]);
    return;
  }

  advanceSeason = data.season;
  advanceCurrentWeek = data.currentWeek;
  // Options first — the season decides which bye weeks exist, so the week the
  // server picked has to have somewhere to land.
  buildAdvanceWeekOptions(data.weeks);
  if (week === null) sel.value = String(data.week);
  renderAdvanceWeek(data.games);
}

function renderAdvanceWeek(games) {
  const label = document.getElementById('advance-active-week');
  const btn = document.getElementById('advance-set-week-btn');
  const selected = Number(document.getElementById('advance-week').value);

  if (!advanceSeason) {
    label.textContent = 'No current season for this league — set one on the Season tab to track the active week.';
    btn.style.display = 'none';
  } else {
    const active = advanceCurrentWeek == null ? 'not set yet' : weekLabelFor(advanceCurrentWeek);
    label.innerHTML = `Active week: <strong>${esc(active)}</strong> `
      + `<span class="text-muted">— posting an advancement makes the posted week active.</span>`;
    const differs = advanceCurrentWeek !== selected;
    btn.style.display = differs ? '' : 'none';
    btn.textContent = `Set ${weekLabelFor(selected)} active`;
  }
  renderAdvanceGames(games);
}

function renderAdvanceGames(games) {
  const tb = document.getElementById('advance-games-tbody');
  const count = document.getElementById('advance-games-count');
  const weekLabel = weekLabelFor(document.getElementById('advance-week').value);

  if (!games.length) {
    count.textContent = '';
    tb.innerHTML = `<tr><td colspan="4" class="text-muted" style="text-align:center;padding:16px;">`
      + `No games scheduled for ${esc(weekLabel)}</td></tr>`;
    return;
  }

  count.textContent = `${weekLabel} · ${games.length} game${games.length === 1 ? '' : 's'}`;
  tb.innerHTML = games.map(g => {
    // "User" only when both sides are coached — matches how the advancement
    // message splits USER GAMES from CPU GAMES.
    const userGame = Boolean(g.is_user_game) && g.home_coach_id != null && g.away_coach_id != null;
    return `<tr>
      <td>${resultTeamCell(g.away_abbrev, g.away_colors, g.away_coach_id != null)}`
      + ` <span class="text-muted">@</span> `
      + `${resultTeamCell(g.home_abbrev, g.home_colors, g.home_coach_id != null)}</td>
      <td>${userGame ? '<span class="badge badge-green">User</span>' : '<span class="badge badge-blue">CPU</span>'}</td>
      <td>${esc(g.away_coach_name || '—')}</td>
      <td>${esc(g.home_coach_name || '—')}</td>
    </tr>`;
  }).join('');
}

async function onAdvanceWeekChange() {
  // A preview built for the old week would be misleading next to the new one.
  document.getElementById('advance-preview-box').style.display = 'none';
  await loadAdvanceState(document.getElementById('advance-week').value);
}

// Point the season at the selected week by hand — for correcting the active
// week without re-posting an advancement.
async function setActiveWeek() {
  if (!advanceSeason) { flash('No current season for this league', 'error', 'advance-result'); return; }
  const week = Number(document.getElementById('advance-week').value);

  const res = await fetch(`/api/guilds/${currentGuildId}/seasons/${advanceSeason.id}/current-week`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ week }),
  });
  const data = await res.json();
  if (!data.ok) { flash(data.error || 'Failed to set the active week', 'error', 'advance-result'); return; }

  advanceCurrentWeek = data.currentWeek;
  noteSeasonWeek(advanceSeason.id, data.currentWeek);
  await loadAdvanceState(week);
  flash(`Active week set to ${weekLabelFor(week)}`, 'success', 'advance-result');
}

// Keep the cached season list in step so the Results tab defaults to the new
// active week the next time it's opened.
function noteSeasonWeek(seasonId, week) {
  const season = allSeasons.find(s => s.id === seasonId);
  if (season) season.current_week = week;
  resultsWeekSeasonId = null;
}

async function previewAdvance() {
  const leagueAbbr   = currentLeague()?.abbr;
  const week         = document.getElementById('advance-week').value;
  const dateOverride = formatDateOverride();
  const useWindow    = document.getElementById('advance-window').checked;
  if (!leagueAbbr) return;

  const box = document.getElementById('advance-preview-box');
  const content = document.getElementById('advance-preview-content');

  const load = async (allowEmpty) => {
    const params = new URLSearchParams({ leagueAbbr, week });
    if (dateOverride) params.set('dateOverride', dateOverride);
    if (useWindow) {
      params.set('advanceWindow', '1');
      // An overridden deadline is opaque to the server, so its -24h window
      // start ships pre-formatted from here.
      if (dateOverride) params.set('windowStart', formatDateOverride(-24));
    }
    if (allowEmpty) params.set('allowEmpty', '1');
    const res = await fetch(`/api/guilds/${currentGuildId}/advance/preview?${params}`);
    return res.json();
  };

  let data = await load(false);
  // Empty week: previewing has no side effects, so render the placeholder anyway
  // so it can be reviewed before deciding whether to post.
  if (!data.ok && data.code === 'no-games') data = await load(true);

  if (data.ok) {
    content.textContent = data.message;
    box.style.display = 'block';
    if (data.source === 'empty') {
      flash(`No games scheduled for ${selectedWeekLabel()} — placeholder shown below.`, 'warn', 'advance-result');
    } else {
      document.getElementById('advance-result').classList.remove('show');
    }
  } else {
    box.style.display = 'none';
    flash(data.error || 'Failed to load preview', 'error', 'advance-result');
  }
}

async function postAdvance() {
  const leagueAbbr   = currentLeague()?.abbr;
  const week         = document.getElementById('advance-week').value;
  const dateOverride = formatDateOverride();
  const useWindow    = document.getElementById('advance-window').checked;
  if (!leagueAbbr) return;

  const post = async (allowEmpty) => {
    const body = { leagueAbbr, week: Number(week) };
    if (dateOverride) body.dateOverride = dateOverride;
    if (useWindow) {
      body.advanceWindow = true;
      if (dateOverride) body.windowStart = formatDateOverride(-24);
    }
    if (allowEmpty) body.allowEmpty = true;
    const res = await fetch(`/api/guilds/${currentGuildId}/advance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  };

  let data = await post(false);
  // Empty week: don't silently block — confirm, then post a placeholder
  // advancement. An admin-only stage is empty by design, so it never asks.
  if (!data.ok && data.code === 'no-games') {
    if (selectedWeekHasGames()) {
      const ok = confirm(`No games are scheduled for ${selectedWeekLabel()}.\n\nPost an advancement anyway? The USER GAMES and CPU GAMES sections will show "No Games Scheduled".`);
      if (!ok) { flash('Advancement cancelled', 'warn', 'advance-result'); return; }
    }
    data = await post(true);
  }

  if (data.ok) {
    const threadMsg = data.threadCount > 0 ? ` ${data.threadCount} scheduling thread(s) created.` : '';
    // The posted week is now the active week — reload so the picker moves on to
    // the next one and the matchups below follow it.
    const weekMsg = data.currentWeek != null ? ` ${weekLabelFor(data.currentWeek)} is now the active week.` : '';
    if (data.currentWeek != null && advanceSeason) noteSeasonWeek(advanceSeason.id, data.currentWeek);
    document.getElementById('advance-preview-box').style.display = 'none';
    await loadAdvanceState();
    flash(`Advancement posted.${weekMsg}${threadMsg}`, 'success', 'advance-result');
  } else {
    flash(data.error || 'Failed', 'error', 'advance-result');
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Dynasty: seasons, teams, coaches, schedule, results, summaries
// ════════════════════════════════════════════════════════════════════════════

// Weeks with games only — results and schedules have nothing to show for the
// admin-only stages.
function buildWeekOptions(selectId) {
  const sel = document.getElementById(selectId);
  if (sel.options.length) return;
  sel.innerHTML = GAME_WEEKS.map(w => `<option value="${w.value}">${esc(w.label)}</option>`).join('');
}
function weekLabelFor(v) { return WEEK_BY_VALUE.get(Number(v))?.label ?? `Week ${v}`; }

// The advance picker carries every stage, games or not, for the season in play.
// Rebuilt whenever the season changes, keeping the selection when it still applies.
function buildAdvanceWeekOptions(weeks) {
  const sel = document.getElementById('advance-week');
  const keep = sel.value;
  const list = (weeks && weeks.length) ? weeks : weeksForYear(null);
  const html = list.map(w =>
    `<option value="${w.value}">${esc(w.label)}${w.games ? '' : ' — no games'}</option>`).join('');
  if (sel.innerHTML === html) return;
  sel.innerHTML = html;
  if (keep !== '' && list.some(w => String(w.value) === keep)) sel.value = keep;
}

// True when the selected stage plays games — the empty-week confirm only makes
// sense for a week that was supposed to have some.
function selectedWeekHasGames() {
  return WEEK_BY_VALUE.get(Number(document.getElementById('advance-week').value))?.games ?? true;
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
  if (name === 'season') { loadSeasonTeams(); loadCoaches(); loadRosterPublishState(); }
  else if (name === 'schedule') loadScheduleTab();
  else if (name === 'results') loadResults();
  else if (name === 'summary') loadSummary();
  else if (name === 'coaches') loadCoachHistory();
}

// ── Season roster → Discord ──
// Publish state is per SEASON: a new season starts unpublished, so the button
// reads "Publish Roster" and posts a new message rather than editing last
// season's post.
let rosterPublished = false;
let rosterChannelConfigured = false;

async function loadRosterPublishState() {
  if (!currentDynLeagueId || !currentSeasonId) { renderRosterPublishState(); return; }
  const res = await fetch(`/api/guilds/${currentGuildId}/leagues/${currentDynLeagueId}/seasons/${currentSeasonId}/roster-post`);
  const data = await res.json();
  rosterPublished = Boolean(data.published);
  rosterChannelConfigured = Boolean(data.channelConfigured);
  renderRosterPublishState();
}

function renderRosterPublishState() {
  const btn = document.getElementById('roster-publish-btn');
  const status = document.getElementById('roster-publish-status');
  if (!btn) return;
  btn.textContent = rosterPublished ? 'Update Roster' : 'Publish Roster';

  let disabled = false;
  let note = '';
  if (!currentSeasonId) {
    disabled = true;
    note = 'Select a season to publish its roster.';
  } else if (!rosterChannelConfigured) {
    disabled = true;
    note = 'Set a Roster Channel in ⚙ Configure to publish.';
  } else if (rosterPublished) {
    note = 'Published. Update edits this season’s pinned post and logs coach changes.';
  } else {
    note = 'Not published yet. Publishing posts a new pinned message for this season.';
  }
  btn.disabled = disabled;
  btn.classList.toggle('btn-disabled', disabled);
  status.textContent = note;
}

async function publishSeasonRoster() {
  if (!currentSeasonId) { flash('Select a season first', 'error', 'roster-result'); return; }
  if (!rosterChannelConfigured) {
    flash('Set a Roster Channel in Configure first', 'error', 'roster-result');
    return;
  }
  const verb = rosterPublished
    ? 'update this season’s pinned roster post and log the coach changes'
    : 'publish a new roster post for this season';
  if (!confirm(`This will ${verb} in the league's roster channel. Continue?`)) return;

  // Publishing can take a while (Discord rate-limits emoji uploads), so say so
  // rather than leaving the button looking inert.
  const btn = document.getElementById('roster-publish-btn');
  const restore = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Publishing…';

  let data;
  try {
    const res = await fetch(
      `/api/guilds/${currentGuildId}/leagues/${currentDynLeagueId}/seasons/${currentSeasonId}/roster/publish`,
      { method: 'POST' },
    );
    // A proxy timeout or a restart returns HTML, not JSON. Parsing that throws,
    // and an unguarded throw here rejects silently — no error, nothing happens.
    const body = await res.text();
    try {
      data = JSON.parse(body);
    } catch {
      throw new Error(res.status === 502 || res.status === 504
        ? 'The request timed out on the server. The roster may still have posted — check the channel, then press Update Roster to reconcile.'
        : `Server returned ${res.status} instead of JSON: ${body.slice(0, 200)}`);
    }
  } catch (err) {
    btn.disabled = false;
    btn.textContent = restore;
    flash(err.message || 'Publish failed', 'error', 'roster-result', true);
    return;
  }
  btn.disabled = false;
  btn.textContent = restore;

  if (data.ok) {
    rosterPublished = true;
    renderRosterPublishState();
    const msg = data.action === 'published' ? 'Roster published'
      : data.action === 'republished' ? 'Post was missing — republished'
      : data.action === 'unchanged' ? 'Post refreshed (no coach changes)'
      : `Roster updated — ${data.changed.length} change${data.changed.length === 1 ? '' : 's'} logged`;
    flash(msg, 'success', 'roster-result');
  } else {
    // Sticky: an actionable error shouldn't vanish before it's been read.
    flash(data.error || 'Publish failed', 'error', 'roster-result', true);
  }
}

// ── Season modal ──
function openSeasonModal() {
  if (!currentDynLeagueId) { alert('Select a league first.'); return; }
  // Cloning is only meaningful when a prior season exists to copy from.
  const canClone = allSeasons.length > 0;
  document.getElementById('season-clone-field').style.display = canClone ? 'flex' : 'none';
  document.getElementById('season-clone').checked = canClone;
  document.getElementById('season-modal').classList.add('open');
}
function closeSeasonModal() { document.getElementById('season-modal').classList.remove('open'); }
async function submitSeason() {
  const year = document.getElementById('season-year').value.trim();
  const label = document.getElementById('season-label').value.trim();
  const cloneField = document.getElementById('season-clone-field');
  const clone = cloneField.style.display !== 'none' && document.getElementById('season-clone').checked;
  if (!year) { alert('Year is required.'); return; }
  const res = await fetch(`/api/guilds/${currentGuildId}/leagues/${currentDynLeagueId}/seasons`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ year: Number(year), label, clone }),
  });
  const data = await res.json();
  if (data.id) {
    const c = data.cloned;
    flash(c ? `Season created — cloned ${c.teams} team(s) and ${c.assignments} coach assignment(s)` : 'Season created');
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

// Shared debounce timer for the schedule opponent typeahead (see onOppChange).
let teamSearchTimer = null;

// The 11 FBS conferences — a fixed list; teams get their conference here.
const CONFERENCES = ['ACC', 'American Athletic', 'Big 12', 'Big Ten', 'Conference USA', 'FBS Independents', 'Mid-American', 'Mountain West', 'Pac-12', 'SEC', 'Sun Belt'];
function confOptions(selected) {
  return '<option value="">— conference —</option>' +
    CONFERENCES.map(c => `<option value="${esc(c)}"${c === selected ? ' selected' : ''}>${esc(c)}</option>`).join('');
}
// Team picker drawn from the full catalog — teams join the season when a coach
// is assigned, so every active team is selectable here. Rendered into a
// <datalist> so the team inputs autocomplete as you type.
function teamDatalistOptions() {
  return [...teamCatalog].sort((a, b) => a.name.localeCompare(b.name))
    .map(t => `<option value="${esc(t.abbrev)}">${esc(t.abbrev)} — ${esc(t.name)}</option>`).join('');
}
// Turn whatever the user typed/picked in a team autocomplete input into a team
// abbrev — matches an abbrev, a full name, or the "ABBR — Name" label form.
function resolveTeamAbbrev(raw) {
  const v = (raw || '').trim();
  if (!v) return '';
  const up = v.toUpperCase();
  let t = teamCatalog.find(x => x.abbrev.toUpperCase() === up);
  if (t) return t.abbrev;
  t = teamCatalog.find(x => x.name.toLowerCase() === v.toLowerCase()
    || `${x.abbrev} — ${x.name}`.toLowerCase() === v.toLowerCase());
  if (t) return t.abbrev;
  return up; // fall back to the raw entry uppercased
}
// Picking a team defaults the paired conference dropdown to that team's known
// conference (when it's one of the fixed 11).
function syncCoachConf(teamSelId, confSelId) {
  const abbrev = resolveTeamAbbrev(document.getElementById(teamSelId).value);
  const t = teamCatalog.find(x => x.abbrev === abbrev);
  const confSel = document.getElementById(confSelId);
  if (t && confSel && CONFERENCES.includes(t.conference)) confSel.value = t.conference;
}

// ── Season roster (loaded for schedule/results/chips; managed via coaches) ──
async function loadSeasonTeams() {
  document.getElementById('season-empty').style.display = currentSeasonId ? 'none' : 'block';
  document.getElementById('season-content').style.display = currentSeasonId ? 'block' : 'none';
  if (!currentSeasonId) return;
  const res = await fetch(`/api/guilds/${currentGuildId}/seasons/${currentSeasonId}/teams`);
  allTeams = await res.json();
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
  const confByTeam = new Map(allTeams.map(t => [t.team_abbrev, t.conference_name]));
  // Flatten each coach into a sortable row (numbers for stream so it sorts by
  // status; team_sort keeps unassigned rows at the bottom when ascending).
  coachAssignRows = allCoaches.map(c => {
    const assigned = assignMap.get(c.id) || '';
    return {
      id: c.id,
      coach: c.display_name || '',
      discord: c.discord_id ? (c.discord_username || c.discord_id) : '',
      stream: c.discord_id ? (c.platform_count > 0 ? 2 : 1) : 0,
      platforms: c.platforms || '',
      assigned,
      conference: assigned ? (confByTeam.get(assigned) || '') : '',
      team_sort: assigned ? teamNameFor(assigned) : '￿',
    };
  });
  applyCoachAssign();
  populateCoachTeamSelect();
  renderConfBreakdown();
  renderUnassignedTeams();
}

// Roster teams with no coach assigned. Hidden behind a toggle; each can be
// removed from the season (drops the roster row; the team stays usable as a
// schedule opponent).
let showUnassignedTeams = false;
function toggleUnassignedTeams() {
  showUnassignedTeams = !showUnassignedTeams;
  const btn = document.getElementById('toggle-unassigned');
  if (btn) btn.textContent = showUnassignedTeams ? 'Hide' : 'Show';
  renderUnassignedTeams();
}
function renderUnassignedTeams() {
  const el = document.getElementById('unassigned-teams');
  if (!el) return;
  const teams = allTeams.filter(t => !t.is_user_team);
  const countBadge = document.getElementById('unassigned-count');
  if (countBadge) {
    countBadge.textContent = teams.length;
    countBadge.style.display = teams.length ? 'inline-block' : 'none';
  }
  el.style.display = showUnassignedTeams ? 'block' : 'none';
  if (!showUnassignedTeams) return;
  if (!teams.length) { el.innerHTML = '<p class="text-muted" style="padding:8px 0;">No teams without a coach.</p>'; return; }
  el.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Team</th><th>Conference</th><th></th></tr></thead>
    <tbody>${teams.map(t => `<tr>
      <td>${teamChip(t.team_abbrev, t.team_name, t.colors)}</td>
      <td>${t.conference_name ? esc(t.conference_name) : '<span class="text-muted">—</span>'}</td>
      <td style="text-align:right;"><button class="btn btn-danger btn-sm" onclick="removeSeasonTeamUi('${esc(t.team_abbrev)}')">Remove</button></td>
    </tr>`).join('')}</tbody></table></div>`;
}
async function removeSeasonTeamUi(abbrev) {
  const t = allTeams.find(x => x.team_abbrev === abbrev);
  const name = t ? t.team_name : abbrev;
  if (!confirm(`Remove ${name} (${abbrev}) from this season's roster?`)) return;
  const res = await fetch(`/api/guilds/${currentGuildId}/seasons/${currentSeasonId}/teams/${encodeURIComponent(abbrev)}`, { method: 'DELETE' });
  const data = await res.json();
  if (data.ok) { flash(`Removed ${abbrev}`); await loadSeasonTeams(); await loadCoaches(); }
  else flash(data.error || 'Failed to remove', 'error');
}
// Coaches with no team this season are hidden by default (they persist across
// seasons, so the list fills up with people not playing now). Toggle to show.
let showUnassignedCoaches = false;
function toggleUnassignedCoaches() {
  showUnassignedCoaches = !showUnassignedCoaches;
  applyCoachAssign();
}
function applyCoachAssign() {
  const unassignedCount = coachAssignRows.filter(c => !c.assigned).length;
  const badge = document.getElementById('unassigned-coach-count');
  if (badge) {
    badge.textContent = unassignedCount;
    badge.style.display = unassignedCount ? 'inline-block' : 'none';
  }
  const btn = document.getElementById('toggle-unassigned-coaches');
  if (btn) {
    btn.textContent = showUnassignedCoaches ? 'Hide unassigned' : 'Show unassigned';
    btn.style.display = unassignedCount ? '' : 'none';
  }
  const rows = showUnassignedCoaches ? coachAssignRows : coachAssignRows.filter(c => c.assigned);
  renderCoaches(sortData(rows, coachAssignSort.col, coachAssignSort.dir));
  updateSortHeaders('coaches-table', coachAssignSort);
}
function sortCoachAssign(col) {
  if (coachAssignSort.col === col) coachAssignSort.dir *= -1; else { coachAssignSort.col = col; coachAssignSort.dir = 1; }
  applyCoachAssign();
}
function populateCoachTeamSelect() {
  const dl = document.getElementById('coach-team-options');
  if (dl) dl.innerHTML = teamDatalistOptions();
  const confSel = document.getElementById('coach-conf');
  if (confSel) confSel.innerHTML = confOptions('');
}
// Count season teams per conference for the breakdown card.
function renderConfBreakdown() {
  const el = document.getElementById('conf-breakdown');
  if (!el) return;
  if (!allTeams.length) { el.innerHTML = '<span class="text-muted">No teams in this season yet.</span>'; return; }
  const counts = new Map();
  for (const t of allTeams) {
    const c = t.conference_name || 'No conference';
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  el.innerHTML = entries.map(([conf, n]) =>
    `<div class="conf-tile"><span class="conf-name">${esc(conf)}</span><span class="badge badge-blue">${n}</span></div>`
  ).join('') +
    `<div class="conf-tile conf-total"><span class="conf-name">Total</span><span class="badge badge-green">${allTeams.length}</span></div>`;
}
function renderCoaches(rows) {
  const tb = document.getElementById('coaches-tbody');
  if (!rows.length) {
    const hidden = coachAssignRows.filter(c => !c.assigned).length;
    const msg = (!showUnassignedCoaches && hidden)
      ? `${hidden} unassigned coach${hidden === 1 ? '' : 'es'} hidden — use “Show unassigned” above.`
      : 'No coaches added';
    tb.innerHTML = `<tr><td colspan="6" class="text-muted" style="text-align:center;padding:16px;">${msg}</td></tr>`;
    return;
  }
  tb.innerHTML = rows.map(c => {
    const assigned = c.assigned;
    const teamCell = assigned
      ? teamChip(assigned, teamNameFor(assigned), colorsForTeam(assigned))
      : '<span class="badge badge-red" title="No team assigned">Unassigned</span>';
    const confCell = c.conference
      ? `<span class="badge badge-blue">${esc(c.conference)}</span>`
      : (assigned ? '<span class="badge badge-red" title="No conference set">No conference</span>' : '<span class="text-muted">—</span>');
    let stream;
    if (c.stream === 0) stream = '<span class="text-muted" title="No Discord user linked">—</span>';
    else if (c.stream === 2) stream = `<span class="badge badge-green" title="${esc(c.platforms)}">✓ Set</span>`;
    else stream = '<span class="badge badge-red" title="No stream platforms registered">✗ Missing</span>';
    return `
    <tr>
      <td>${teamCell}</td>
      <td>${confCell}</td>
      <td><strong>${esc(c.coach)}</strong></td>
      <td>${c.discord ? esc(c.discord) : '<span class="text-muted">—</span>'}</td>
      <td>${stream}</td>
      <td>
        <div class="assign-controls">
          <input id="assign-${c.id}" list="coach-team-options" autocomplete="off" placeholder="Team…" value="${esc(assigned)}" onchange="syncCoachConf('assign-${c.id}','conf-${c.id}')" oninput="syncCoachConf('assign-${c.id}','conf-${c.id}')">
          <select id="conf-${c.id}">${confOptions(c.conference)}</select>
          <button class="btn btn-primary btn-sm" onclick="assignCoach(${c.id})">Assign</button>
          ${assigned ? `<button class="btn btn-ghost btn-sm" title="Drop this coach's team but keep the team on the season roster" onclick="unassignCoach(${c.id})">Unassign</button>
          <button class="btn btn-danger btn-sm" title="Remove this team from the season entirely" onclick="removeTeamFromSeasonUi(${c.id})">Remove team</button>` : ''}
        </div>
      </td>
    </tr>`;
  }).join('');
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
  const teamAbbrev = resolveTeamAbbrev(document.getElementById('coach-team').value);
  const conferenceName = document.getElementById('coach-conf').value || null;

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
      body: JSON.stringify({ coachId: coach.id, teamAbbrev, conferenceName }),
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
  document.getElementById('coach-conf').value = '';
  await loadSeasonTeams();
  await loadCoaches();
}
async function assignCoach(coachId) {
  const teamAbbrev = resolveTeamAbbrev(document.getElementById(`assign-${coachId}`).value);
  if (!teamAbbrev) return;
  const conferenceName = document.getElementById(`conf-${coachId}`).value || null;
  const res = await fetch(`/api/guilds/${currentGuildId}/seasons/${currentSeasonId}/assignments`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ coachId, teamAbbrev, conferenceName }),
  });
  const data = await res.json();
  if (data.ok) { flash('Coach assigned'); await loadSeasonTeams(); await loadCoaches(); }
  else flash(data.error || 'Failed', 'error');
}
// Unassign a coach from this season: clears their team + unplayed-game links.
// The coach stays in the league and the team stays on the roster (unassigned).
async function unassignCoach(coachId) {
  const c = coachAssignRows.find(r => r.id === coachId);
  const who = c ? c.coach : 'this coach';
  const team = c && c.assigned ? ` (${c.assigned})` : '';
  if (!confirm(`Remove ${who}${team} from this season? They stay in the league and can be reassigned later.`)) return;
  const res = await fetch(`/api/guilds/${currentGuildId}/seasons/${currentSeasonId}/assignments/${coachId}`, { method: 'DELETE' });
  const data = await res.json();
  if (data.ok) { flash(`Removed ${who} from season`); await loadSeasonTeams(); await loadCoaches(); }
  else flash(data.error || 'Failed to remove', 'error');
}
// Remove a coach's team from the season entirely (drops the roster row and
// unassigns the coach). The coach stays in the league; the team can still be a
// schedule opponent. Only the team's unplayed games against CPU/uncoached
// opponents are cleared — played games and games against another coach's team
// remain on the schedule. Reuses the season-team DELETE endpoint.
async function removeTeamFromSeasonUi(coachId) {
  const c = coachAssignRows.find(r => r.id === coachId);
  if (!c || !c.assigned) return;
  const abbrev = c.assigned;
  const name = teamNameFor(abbrev) || abbrev;
  if (!confirm(`Remove ${name} (${abbrev}) from this season? ${c.coach} will be unassigned; they stay in the league.\n\nPlayed games and games against another coach's team stay on the schedule; only unplayed CPU games are cleared.`)) return;
  const res = await fetch(`/api/guilds/${currentGuildId}/seasons/${currentSeasonId}/teams/${encodeURIComponent(abbrev)}`, { method: 'DELETE' });
  const data = await res.json();
  if (data.ok) { flash(`Removed ${abbrev} from season`); await loadSeasonTeams(); await loadCoaches(); }
  else flash(data.error || 'Failed to remove', 'error');
}

// ── Schedule (team picker + one detail card) ──
let oppMetaTimers = {};
let seasonGames = [];       // all games in the season (for scheduling-rule checks)
let scheduleFilter = '';
let selectedScheduleTeam = null;  // abbrev of the team whose card is loaded

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
  const nav = document.getElementById('schedule-nav-list');
  const detail = document.getElementById('schedule-detail');
  if (!currentSeasonId) {
    nav.innerHTML = '<p class="text-muted" style="padding:12px;">Select a season.</p>';
    detail.innerHTML = '<p class="text-muted" style="padding:16px;">Select a season to build schedules.</p>';
    return;
  }
  const [teamsRes, gamesRes] = await Promise.all([
    fetch(`/api/guilds/${currentGuildId}/seasons/${currentSeasonId}/teams`),
    fetch(`/api/guilds/${currentGuildId}/seasons/${currentSeasonId}/games`),
  ]);
  allTeams = await teamsRes.json();
  seasonGames = await gamesRes.json();
  renderScheduleCards();
}

function filterScheduleCards(v) { scheduleFilter = (v || '').toLowerCase(); renderScheduleNav(); }

// The schedule only manages teams that have a coach assigned (user teams);
// uncoached roster teams are still selectable as opponents, just not listed here.
function coachedScheduleTeams() { return allTeams.filter(t => t.is_user_team); }

// How many games flagged as user games this team plays in (home or away).
function userGameCount(abbr) {
  return seasonGames.filter(g => g.is_user_game === 1 && (g.home_abbrev === abbr || g.away_abbrev === abbr)).length;
}

// A "full" slate is 12 games scheduled across weeks 0–16. Teams short of that
// get their nav count tinted red to flag an incomplete schedule.
const FULL_SCHEDULE_MAX_WEEK = 16;
const FULL_SCHEDULE_GAMES = 12;

// Total games (user or CPU) this team has scheduled within weeks 0–16.
function scheduledGameCount(abbr) {
  return seasonGames.filter(g => g.week <= FULL_SCHEDULE_MAX_WEEK
    && (g.home_abbrev === abbr || g.away_abbrev === abbr)).length;
}

// Season W-L(-T) record per team, derived from resolved games in seasonGames.
// A game is resolved the same way the server counts it: a forfeit with a forced
// winner, or a normal/fair-sim game with both scores. Keyed by team abbrev.
function computeSeasonRecords() {
  const rec = new Map();
  const get = a => { if (!rec.has(a)) rec.set(a, { w: 0, l: 0, t: 0 }); return rec.get(a); };
  for (const g of seasonGames) {
    const resolved = (g.result_type === 'FR' && g.winner_side) || (g.home_score != null && g.away_score != null);
    if (!resolved) continue;
    const h = get(g.home_abbrev), a = get(g.away_abbrev);
    if (g.result_type === 'FR') {
      if (g.winner_side === 'home') { h.w++; a.l++; } else { a.w++; h.l++; }
    } else if (g.home_score > g.away_score) { h.w++; a.l++; }
    else if (g.away_score > g.home_score) { a.w++; h.l++; }
    else { h.t++; a.t++; }
  }
  return rec;
}
function recStr(r) { return r ? `${r.w}-${r.l}${r.t ? `-${r.t}` : ''}` : '0-0'; }

// Entry render: ensure a valid selection, then draw the team nav + detail card.
function renderScheduleCards() {
  const nav = document.getElementById('schedule-nav-list');
  const detail = document.getElementById('schedule-detail');
  const coached = coachedScheduleTeams();
  if (!coached.length) {
    nav.innerHTML = '<p class="text-muted" style="padding:12px;">No coached teams.</p>';
    detail.innerHTML = '<p class="text-muted" style="padding:16px;">No teams with a coach assigned yet — assign coaches in the Season tab.</p>';
    return;
  }
  if (!selectedScheduleTeam || !coached.some(t => t.team_abbrev === selectedScheduleTeam)) {
    selectedScheduleTeam = coached[0].team_abbrev;
  }
  renderScheduleNav();
  renderScheduleDetail();
}

// Left-nav list of coached teams; the active one is highlighted. Filtering only
// narrows the list — the loaded card stays put until another team is clicked.
function renderScheduleNav() {
  const nav = document.getElementById('schedule-nav-list');
  const f = scheduleFilter;
  const teams = coachedScheduleTeams().filter(t => !f || t.team_abbrev.toLowerCase().includes(f) || (t.team_name || '').toLowerCase().includes(f));
  if (!teams.length) { nav.innerHTML = '<p class="text-muted" style="padding:12px;">No teams match.</p>'; return; }
  nav.innerHTML = teams.map(t => {
    const active = t.team_abbrev === selectedScheduleTeam;
    const userGames = userGameCount(t.team_abbrev);
    const scheduled = scheduledGameCount(t.team_abbrev);
    const incomplete = scheduled < FULL_SCHEDULE_GAMES;
    const countTitle = `${userGames} user game${userGames === 1 ? '' : 's'} · ${scheduled}/${FULL_SCHEDULE_GAMES} games scheduled (W0–W16)${incomplete ? ' — incomplete' : ''}`;
    return `<button class="sched-nav-item${active ? ' active' : ''}" onclick="selectScheduleTeam('${t.team_abbrev}')" title="${esc(t.team_name)}">`
      + `<img class="sched-nav-logo" src="${logoUrl(t.team_abbrev)}" alt="" onerror="this.style.display='none'">`
      + `<span class="sched-nav-abbr">${esc(t.team_abbrev)}</span>`
      + `<span class="sched-nav-name">${esc(t.team_name)}</span>`
      + `<span class="sched-nav-count${incomplete ? ' low' : ''}" title="${countTitle}">${userGames}</span></button>`;
  }).join('');
}

function selectScheduleTeam(abbr) {
  selectedScheduleTeam = abbr;
  renderScheduleNav();
  renderScheduleDetail();
}

// The loaded card: team + coach info header, then the week grid (0–14 regular
// season, 15–19 postseason under a divider).
function renderScheduleDetail() {
  closeAvailPop(); // the rows it was anchored to are being replaced
  const detail = document.getElementById('schedule-detail');
  const t = allTeams.find(x => x.team_abbrev === selectedScheduleTeam);
  if (!t) { detail.innerHTML = ''; return; }
  detail.innerHTML = scheduleCardHtml(t);
  refreshCardWarnings(t.team_abbrev);
}

// Inline person glyph used to mark user games (row marker + toggle label).
const USER_ICON = '<svg class="user-svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 12a5 5 0 100-10 5 5 0 000 10zm0 2c-4.42 0-8 2.24-8 5v1h16v-1c0-2.76-3.58-5-8-5z"/></svg>';

function scheduleCardHtml(t) {
  const abbr = t.team_abbrev;
  const records = computeSeasonRecords();
  const myRec = records.get(abbr);
  const byWeek = new Map();
  for (const g of seasonGames) {
    if (g.home_abbrev === abbr || g.away_abbrev === abbr) byWeek.set(g.week, g);
  }
  // Quick-glance totals for the header (reflect the last saved schedule).
  let gamesScheduled = 0, homeGames = 0, userGames = 0;
  for (const g of byWeek.values()) {
    gamesScheduled++;
    if (g.home_abbrev === abbr) homeGames++;
    if (g.is_user_game === 1) userGames++;
  }
  const headerBg = (t.colors && t.colors.length)
    ? `linear-gradient(90deg, ${hexToRgba(t.colors[0], 0.9)}, ${hexToRgba(t.colors[1] || t.colors[0], 0.55)})`
    : 'var(--surface2)';
  let rows = '';
  for (let w = 0; w <= SCHED_MAX_WEEK; w++) {
    if (w === 15) rows += `<tr class="sched-sep"><td colspan="10">Postseason</td></tr>`;
    const g = byWeek.get(w);
    const isHome = g ? g.home_abbrev === abbr : true;
    const opp = g ? (isHome ? g.away_abbrev : g.home_abbrev) : '';
    const colors = g ? ((isHome ? g.away_colors : g.home_colors) || []) : [];
    const user = g ? g.is_user_game === 1 : false;
    const has = !!opp;
    // Result entry, from the selected team's view. Inputs are rendered in the
    // SAVED game's orientation (data-home on the row); saveCard re-maps them to
    // home/away after the schedule half of the save settles each game's sides.
    // Rows with no saved game yet (a new matchup, or a BYE) get no inputs.
    let oppRecCell = '', scoreCell = '', attCell = '', typeCell = '', winCell = '', resultCell = '';
    if (g && has) {
      oppRecCell = `<span class="opp-rec" title="${esc(opp)} season record">${recStr(records.get(opp))}</span>`;
      const rt = g.result_type || 'normal';
      const sim = rt === 'FR' || rt === 'FS'; // forfeit / fair sim → no attempts
      const myScore = isHome ? g.home_score : g.away_score;
      const opScore = isHome ? g.away_score : g.home_score;
      const myKey = isHome ? 'home' : 'away';
      const oppKey = isHome ? 'away' : 'home';
      // A score can be entered for any result type, forfeits included — the
      // winner still decides a forfeit, but the score is kept when one is given.
      scoreCell = `<div class="sc-pair">
          <input class="grid-input sc-in" type="number" id="msc-${abbr}-${w}" value="${myScore ?? ''}"
                 placeholder="${esc(abbr)}" title="${esc(abbr)} score" onkeydown="onGridTab(event,'${abbr}',${w},'msc')">
          <span class="sc-dash">–</span>
          <input class="grid-input sc-in" type="number" id="osc-${abbr}-${w}" value="${opScore ?? ''}"
                 placeholder="${esc(opp)}" title="${esc(opp)} score" onkeydown="onGridTab(event,'${abbr}',${w},'osc')">
        </div>`;
      attCell = `<input class="grid-input sc-in" type="number" id="att-${abbr}-${w}" tabindex="-1"
                        value="${g.attempts_taken ?? ''}" title="Attempts taken" ${sim ? 'disabled' : ''}>`;
      typeCell = `<select class="grid-input sc-sel" id="rtyp-${abbr}-${w}" tabindex="-1" onchange="onSchedTypeChange('${abbr}',${w})">
          <option value="normal" ${rt === 'normal' ? 'selected' : ''}>Normal</option>
          <option value="FR" ${rt === 'FR' ? 'selected' : ''}>FR</option>
          <option value="FS" ${rt === 'FS' ? 'selected' : ''}>FS</option>
        </select>`;
      winCell = `<select class="grid-input sc-sel" id="winr-${abbr}-${w}" tabindex="-1" ${rt === 'FR' ? '' : 'disabled'}>
          <option value="">—</option>
          <option value="${myKey}" ${g.winner_side === myKey ? 'selected' : ''}>${esc(abbr)}</option>
          <option value="${oppKey}" ${g.winner_side === oppKey ? 'selected' : ''}>${esc(opp)}</option>
        </select>`;
      const resolved = (rt === 'FR' && g.winner_side) || (myScore != null && opScore != null);
      if (resolved) {
        let outcome;
        if (rt === 'FR') outcome = g.winner_side === myKey ? 'w' : 'l';
        else if (myScore > opScore) outcome = 'w';
        else if (myScore < opScore) outcome = 'l';
        else outcome = 't';
        const tag = sim ? ` <span class="res-tag">${rt}</span>` : '';
        resultCell = `<span class="res res-${outcome}">${outcome.toUpperCase()}</span>${tag}`;
      }
    }
    // data-result marks a game with something already recorded, so the schedule
    // save can warn before a matchup change drops it. data-orig snapshots the
    // saved result so only edited rows are posted back — re-saving an untouched
    // game would re-stamp played_at and re-snapshot its coaches.
    const recorded = g && (g.played_at != null || g.home_score != null || g.away_score != null
      || (g.attempts_taken ?? 0) > 0 || g.winner_side != null);
    const orig = g && has ? resultKey(
      (isHome ? g.home_score : g.away_score) ?? '', (isHome ? g.away_score : g.home_score) ?? '',
      g.attempts_taken ?? '', g.result_type || 'normal', g.winner_side ?? '') : '';
    rows += `<tr id="schedrow-${abbr}-${w}"${g ? ` data-game="${g.id}"` : ''} data-home="${isHome ? 1 : 0}"
        data-opp="${esc(opp || '')}" data-result="${recorded ? 1 : 0}" data-orig="${esc(orig)}">
      <td class="wk${w > 14 ? ' wk-post' : ''}">${weekShort(w)}</td>
      <td>
        <div class="opp-cell" id="oppcell-${abbr}-${w}" style="background:${has ? shadeFor(colors) : 'transparent'};">
          <span class="user-mark" id="usermark-${abbr}-${w}" title="User game" style="${user && has ? '' : 'display:none;'}">${USER_ICON}</span>
          <img class="opp-logo" id="opplogo-${abbr}-${w}" alt="" ${has ? `src="${logoUrl(opp)}"` : ''}
               onerror="this.style.visibility='hidden'" style="${has ? '' : 'visibility:hidden;'}">
          <input class="grid-input opp-input" list="team-options" id="opp-${abbr}-${w}" value="${esc(opp || '')}"
                 placeholder="BYE" oninput="onOppChange('${abbr}',${w})" onkeydown="onGridTab(event,'${abbr}',${w},'opp')">
          ${w <= 14 ? `<button class="avail-btn" tabindex="-1" title="User teams free in ${weekShort(w)} (non-conference)"
                  onclick="toggleAvailPop('${abbr}',${w},this)">?</button>` : ''}
        </div>
      </td>
      <td>
        <div class="side-toggle" id="sidewrap-${abbr}-${w}" style="${has ? '' : 'display:none;'}">
          <span class="side-label ${isHome ? 'active' : ''}" id="sidehome-${abbr}-${w}">H</span>
          <label class="switch"><input type="checkbox" id="side-${abbr}-${w}" ${!isHome ? 'checked' : ''} tabindex="-1" onchange="onSideToggle('${abbr}',${w})"><span class="slider"></span></label>
          <span class="side-label ${!isHome ? 'active' : ''}" id="sideaway-${abbr}-${w}">A</span>
        </div>
      </td>
      <td>
        <div class="user-toggle" id="userwrap-${abbr}-${w}" style="${has ? '' : 'display:none;'}">
          <span class="user-toggle-icon ${user ? 'active' : ''}" id="usericon-${abbr}-${w}">${USER_ICON}</span>
          <label class="switch"><input type="checkbox" id="user-${abbr}-${w}" ${user ? 'checked' : ''} tabindex="-1" onchange="onUserToggle('${abbr}',${w})"><span class="slider"></span></label>
        </div>
      </td>
      <td class="sched-opprec">${oppRecCell}</td>
      <td class="sched-score">${scoreCell}</td>
      <td class="sched-att">${attCell}</td>
      <td class="sched-type">${typeCell}</td>
      <td class="sched-win">${winCell}</td>
      <td class="sched-result">${resultCell}</td>
    </tr>`;
  }
  const coachInfo = t.coach_name
    ? `<span class="badge badge-blue">Coach: ${esc(t.coach_name)}</span>`
    : '<span class="badge badge-red">No coach assigned</span>';
  const confInfo = t.conference_name
    ? `<span class="badge">${esc(t.conference_name)}</span>`
    : '<span class="text-muted">No conference</span>';
  return `<div class="sched-card sched-card-solo">
    <div class="sched-card-head" style="background:${headerBg};">
      <img class="sched-card-logo" src="${logoUrl(abbr)}" alt="" onerror="this.style.display='none'">
      <span>${esc(t.team_name)} <small>(${esc(abbr)})</small></span>
      ${t.is_user_team ? '<span class="badge badge-yellow" style="margin-left:auto;">user</span>' : ''}
    </div>
    <div class="sched-card-meta">${confInfo} ${coachInfo}
      <div class="sched-card-actions">
        <span id="cardflash-${abbr}" class="card-flash"></span>
        <button class="btn btn-primary btn-sm" onclick="saveCard('${abbr}')" title="Save ${esc(abbr)}'s matchups (opponent, H/A, user flag) and any results entered">Save</button>
      </div>
    </div>
    <div class="sched-summary">
      <div class="sched-stat"><span class="sched-stat-num">${gamesScheduled}</span><span class="sched-stat-lbl">Games</span></div>
      <div class="sched-stat"><span class="sched-stat-num">${homeGames}</span><span class="sched-stat-lbl">Home</span></div>
      <div class="sched-stat"><span class="sched-stat-num">${userGames}</span><span class="sched-stat-lbl">User</span></div>
      <div class="sched-stat"><span class="sched-stat-num">${recStr(myRec)}</span><span class="sched-stat-lbl">Record</span></div>
    </div>
    <div class="sched-warn" id="cardwarn-${abbr}" hidden></div>
    <div class="sched-table-wrap"><table class="sched-card-table">
      <thead><tr class="sched-head-row">
        <th>Wk</th><th>Opponent</th><th>H/A</th><th>User</th>
        <th title="Opponent season record">Opp Rec</th>
        <th title="Score — ${esc(abbr)} first, then the opponent">Score</th>
        <th title="Attempts taken">Att</th>
        <th title="Result type: Normal, forfeit (FR) or fair sim (FS)">Type</th>
        <th title="Winner — forfeits only">Win</th>
        <th title="Outcome from ${esc(abbr)}'s view">Res</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

const gid = (prefix, abbr, w) => document.getElementById(`${prefix}-${abbr}-${w}`);

// "FCS" is a generic non-user placeholder opponent — many teams schedule it, so
// it's the one team exempt from the double-booking and rematch checks. It never
// counts as busy and is never flagged for a repeat.
const GENERIC_OPPONENT = 'FCS';
function isGenericOpponent(abbr) { return (abbr || '').toUpperCase() === GENERIC_OPPONENT; }

// Teams playing another matchup in week w — not selectable as this team's opponent
// (rule 2). The generic opponent is exempt: it can be booked in multiple games
// the same week, so it's never added to the busy set.
function bookedThatWeek(abbr, w) {
  const set = new Set();
  for (const g of seasonGames) {
    if (g.week !== w) continue;
    if (g.home_abbrev === abbr || g.away_abbrev === abbr) continue;
    if (!isGenericOpponent(g.home_abbrev)) set.add(g.home_abbrev);
    if (!isGenericOpponent(g.away_abbrev)) set.add(g.away_abbrev);
  }
  return set;
}

// Abbrevs not selectable for (abbr, w): self (rule 1) and any team already busy
// that week (rule 2) — both are genuine impossibilities. Rematches (an opponent
// already on another regular-season row) stay selectable; they're allowed now
// and flagged as a warning instead of being blocked.
function excludedForRow(abbr, w) {
  const set = new Set([abbr]);
  bookedThatWeek(abbr, w).forEach(a => set.add(a));
  return set;
}

// User teams free to schedule in week w for this card: every coached team other
// than the card's own with no matchup that week, and out of conference —
// conference matchups come from the game's own schedule, so only
// non-conference slots are hand-filled. Regular season only: postseason rows
// don't offer the helper at all. Each entry carries its current user-game
// total so schedules can be balanced at a glance. Availability follows saved
// games (same basis as the double-booking rule), not unsaved card edits.
function availableUserTeams(abbr, w) {
  const busy = bookedThatWeek(abbr, w);
  const myConf = allTeams.find(t => t.team_abbrev === abbr)?.conference_name || null;
  return coachedScheduleTeams()
    .filter(t => t.team_abbrev !== abbr && !busy.has(t.team_abbrev)
      && !(myConf && t.conference_name === myConf))
    .map(t => ({ abbrev: t.team_abbrev, name: t.team_name, userGames: userGameCount(t.team_abbrev) }))
    .sort((a, b) => a.userGames - b.userGames || a.abbrev.localeCompare(b.abbrev));
}

// ── "Who's free this week?" popover (the ? button on each week row) ──
let availPopKey = null; // `${abbr}-${w}` of the open popover, null when closed

// Single shared popover element, created on first use and kept on <body> so the
// scrolling table wrapper can't clip it.
function availPopEl() {
  let el = document.getElementById('avail-pop');
  if (!el) {
    el = document.createElement('div');
    el.id = 'avail-pop';
    el.className = 'avail-pop';
    el.addEventListener('click', e => {
      const item = e.target.closest('.avail-item');
      if (item) pickAvailTeam(item.dataset.abbr, Number(item.dataset.week), item.dataset.opp);
    });
    document.body.appendChild(el);
  }
  return el;
}

function closeAvailPop() {
  availPopKey = null;
  const el = document.getElementById('avail-pop');
  if (el) el.style.display = 'none';
}

function toggleAvailPop(abbr, w, btn) {
  const key = `${abbr}-${w}`;
  if (availPopKey === key) { closeAvailPop(); return; }
  const teams = availableUserTeams(abbr, w);
  const current = (gid('opp', abbr, w).value || '').trim().toUpperCase();
  const items = teams.map(t => {
    const isCur = t.abbrev === current;
    return `<button class="avail-item${isCur ? ' current' : ''}" data-abbr="${esc(abbr)}" data-week="${w}" data-opp="${esc(t.abbrev)}"
        title="${isCur ? 'Current opponent this week' : `Schedule ${esc(t.abbrev)} in ${weekShort(w)}`}">`
      + `<img class="avail-logo" src="${logoUrl(t.abbrev)}" alt="" onerror="this.style.visibility='hidden'">`
      + `<span class="avail-abbr">${esc(t.abbrev)}</span>`
      + `<span class="avail-name">${esc(t.name || '')}</span>`
      + `<span class="avail-count" title="${t.userGames} user game${t.userGames === 1 ? '' : 's'} on ${esc(t.abbrev)}'s schedule">${t.userGames}</span></button>`;
  }).join('');
  const el = availPopEl();
  el.innerHTML = `<div class="avail-pop-head"><span>${weekShort(w)} · non-conf user teams free</span><span class="avail-head-hint">user games</span></div>`
    + `<div class="avail-list">${items || '<div class="avail-empty">No non-conference user teams are free this week.</div>'}</div>`;
  el.style.display = 'block';
  // Anchor to the button: below it by default, above when there's more room
  // there, clamped to the viewport horizontally (position: fixed).
  const r = btn.getBoundingClientRect();
  el.style.left = Math.max(8, Math.min(r.left, window.innerWidth - el.offsetWidth - 8)) + 'px';
  el.style.top = ''; el.style.bottom = '';
  const spaceBelow = window.innerHeight - r.bottom;
  if (spaceBelow < Math.min(el.offsetHeight + 12, 260) && r.top > spaceBelow) {
    el.style.bottom = (window.innerHeight - r.top + 4) + 'px';
  } else {
    el.style.top = (r.bottom + 4) + 'px';
  }
  availPopKey = key;
}

// Fill the chosen team into the week's opponent input, as if typed by hand.
function pickAvailTeam(abbr, w, opp) {
  const input = gid('opp', abbr, w);
  if (input) { input.value = opp; onOppChange(abbr, w); }
  closeAvailPop();
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
  gid('userwrap', abbr, w).style.display = has ? '' : 'none';
  syncUserMark(abbr, w);
  refreshCardWarnings(abbr);
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

// User-game toggle: mark it manually set, then refresh the row's user marker.
function onUserToggle(abbr, w) {
  gid('user', abbr, w).dataset.touched = '1';
  syncUserMark(abbr, w);
}

// Reflect the user-game state: highlight the toggle icon and show/hide the
// person marker to the left of the opponent logo (hidden when there's no game).
function syncUserMark(abbr, w) {
  const cb = gid('user', abbr, w);
  if (!cb) return;
  const on = cb.checked && !!(gid('opp', abbr, w).value || '').trim();
  const mark = gid('usermark', abbr, w);
  if (mark) mark.style.display = on ? '' : 'none';
  gid('usericon', abbr, w).classList.toggle('active', cb.checked);
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

// Regular-season rematches on this card: the same opponent scheduled in two or
// more weeks (weeks 0–14). Postseason weeks (15+) may rematch freely and are not
// reported. Returns [{ opp, firstWeek, week }] for each repeat occurrence.
function cardRematches(abbr) {
  const seen = new Map(); // opponent abbrev -> first regular-season week seen
  const out = [];
  for (let w = 0; w <= 14; w++) {
    const opp = (gid('opp', abbr, w)?.value || '').trim().toUpperCase();
    if (!opp || isGenericOpponent(opp)) continue; // generic opponent may repeat
    if (seen.has(opp)) out.push({ opp, firstWeek: seen.get(opp), week: w });
    else seen.set(opp, w);
  }
  return out;
}

// Surface rematches inline: outline the affected rows and show a warning banner
// on the card. Rematches are allowed now, so this only informs — it never blocks.
function refreshCardWarnings(abbr) {
  const rematches = cardRematches(abbr);
  const flagged = new Set();
  rematches.forEach(r => { flagged.add(r.firstWeek); flagged.add(r.week); });
  for (let w = 0; w <= SCHED_MAX_WEEK; w++) {
    gid('oppcell', abbr, w)?.classList.toggle('rematch', flagged.has(w));
  }
  const banner = document.getElementById(`cardwarn-${abbr}`);
  if (!banner) return;
  if (!rematches.length) { banner.hidden = true; banner.textContent = ''; return; }
  const parts = rematches.map(r => `${esc(r.opp)} (${weekShort(r.firstWeek)} & ${weekShort(r.week)})`);
  banner.hidden = false;
  banner.innerHTML = `<strong>⚠ Rematch:</strong> ${parts.join(' · ')} — allowed, but double-check it's intended.`;
}

// Validate one card before sending. Hard errors (a team playing itself, or an
// opponent double-booked in the same week) block the save. Regular-season
// rematches are returned separately as warnings — the caller confirms them
// rather than blocking. The server enforces the hard rules too.
function validateCard(abbr) {
  const T = abbr.toUpperCase();
  for (let w = 0; w <= SCHED_MAX_WEEK; w++) {
    const opp = (gid('opp', abbr, w).value || '').trim().toUpperCase();
    if (!opp) continue;
    if (opp === T) return { error: `${weekShort(w)}: a team can't play itself.` };
    if (bookedThatWeek(abbr, w).has(opp)) return { error: `${opp} is already booked in ${weekShort(w)}.` };
  }
  const warnings = cardRematches(abbr).map(r =>
    `${r.opp} is scheduled twice (${weekShort(r.firstWeek)} & ${weekShort(r.week)}).`);
  return { error: null, warnings };
}

// Weeks where a recorded result would be thrown away by the schedule save: the
// game already has a result and the opponent is being changed or cleared, so the
// old row is dropped and re-placed. An unchanged matchup (even with H/A flipped)
// keeps its row and result, so it never appears here.
function resultLossWarnings(abbr) {
  const out = [];
  for (let w = 0; w <= SCHED_MAX_WEEK; w++) {
    const row = document.getElementById(`schedrow-${abbr}-${w}`);
    if (!row || row.dataset.result !== '1') continue;
    const now = (gid('opp', abbr, w).value || '').trim().toUpperCase();
    if (now !== row.dataset.opp) {
      out.push(`${weekShort(w)}: the recorded result vs ${row.dataset.opp} is cleared by switching to ${now || 'a BYE'}.`);
    }
  }
  return out;
}

// One save for the whole card: matchups first, then any result edits. Result
// rows are validated before anything posts, so a bad score can't leave the
// schedule saved with the results half rejected mid-batch (the bulk endpoint
// applies rows one at a time). After the schedule lands, games are re-fetched
// and each result maps onto the game row as it now exists — a re-placed
// matchup has a new id, and an H/A flip inverts the score/winner orientation.
async function saveCard(abbr) {
  const { error, warnings } = validateCard(abbr);
  if (error) { flashCard(abbr, error, 'error'); return; }
  const results = readCardResults(abbr);
  for (const r of results) {
    const oneScore = (r.myScore === '') !== (r.opScore === '');
    if (r.resultType === 'FR') {
      // A forfeit is decided by the winner; a score is optional but must be a pair.
      if (r.winnerIsMe == null) { flashCard(abbr, `${weekShort(r.week)}: a forfeit (FR) needs a winner.`, 'error'); return; }
      if (oneScore) { flashCard(abbr, `${weekShort(r.week)}: enter both scores or neither.`, 'error'); return; }
    } else if (r.myScore === '' || r.opScore === '') {
      flashCard(abbr, `${weekShort(r.week)}: both scores are required.`, 'error'); return;
    }
  }
  const losses = resultLossWarnings(abbr);
  if (losses.length) {
    const ok = confirm(`Saving this schedule discards recorded results:\n\n${losses.join('\n')}\n\nSave anyway?`);
    if (!ok) { flashCard(abbr, 'Save cancelled', 'warn'); return; }
  }
  if (warnings.length) {
    const ok = confirm(`This schedule has regular-season rematches:\n\n${warnings.join('\n')}\n\nRematches are unusual but allowed. Save anyway?`);
    if (!ok) { flashCard(abbr, 'Save cancelled', 'warn'); return; }
  }
  const weeks = [];
  for (let w = 0; w <= SCHED_MAX_WEEK; w++) {
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
  if (!data.ok) { flashCard(abbr, data.error || 'Failed', 'error'); return; }

  let savedResults = 0, resultError = null;
  if (results.length) {
    const games = await (await fetch(`/api/guilds/${currentGuildId}/seasons/${currentSeasonId}/games`)).json();
    const payload = [];
    for (const r of results) {
      const g = games.find(x => x.week === r.week
        && ((x.home_abbrev === abbr && x.away_abbrev === r.opp)
          || (x.away_abbrev === abbr && x.home_abbrev === r.opp)));
      if (!g) continue;
      const isHome = g.home_abbrev === abbr;
      payload.push({
        gameId: g.id,
        homeScore: isHome ? r.myScore : r.opScore,
        awayScore: isHome ? r.opScore : r.myScore,
        attempts: r.attempts,
        resultType: r.resultType,
        winnerSide: r.winnerIsMe == null ? null : (r.winnerIsMe === isHome ? 'home' : 'away'),
      });
    }
    if (payload.length) {
      const rr = await fetch(`/api/guilds/${currentGuildId}/seasons/${currentSeasonId}/results`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ results: payload }),
      });
      const rd = await rr.json();
      if (rd.ok) savedResults = rd.saved;
      else resultError = rd.error || 'Failed';
    }
  }

  // Reload first — it re-renders the card (and the flash span with it).
  await loadScheduleTab();
  if (resultError) { flashCard(abbr, `Schedule saved, but results failed: ${resultError}`, 'error'); return; }
  let msg = savedResults ? `Saved schedule + ${savedResults} result${savedResults === 1 ? '' : 's'}` : 'Saved';
  if (warnings.length) msg += ` — ${warnings.length} rematch warning${warnings.length > 1 ? 's' : ''}`;
  flashCard(abbr, msg, warnings.length ? 'warn' : 'success');
}

// Result type changed on a schedule row: only a forfeit (FR) forces a winner,
// and forfeits/fair sims record no attempts. Mirrors the Results tab.
function onSchedTypeChange(abbr, w) {
  const rt = gid('rtyp', abbr, w).value;
  const wn = gid('winr', abbr, w);
  const at = gid('att', abbr, w);
  wn.disabled = rt !== 'FR';
  if (rt !== 'FR') wn.value = '';
  const sim = rt === 'FR' || rt === 'FS';
  at.disabled = sim;
  if (sim) at.value = 0;
}

// Tab lanes in the week grid. The opponent column and the score pair each tab
// straight down their own column, so building a schedule and entering results
// are both uninterrupted typing: opponent → opponent, and team score → opponent
// score → next week's team score. Attempts/type/winner sit out of the tab order
// (tabindex -1) and are reached by click. Weeks with nothing in that column (a
// BYE has no score inputs) are skipped; running off the end tabs out normally.
function onGridTab(e, abbr, w, col) {
  if (e.key !== 'Tab') return;
  const back = e.shiftKey;
  const step = (fromWeek, dir, prefix) => {
    for (let x = fromWeek + dir; x >= 0 && x <= SCHED_MAX_WEEK; x += dir) {
      const el = gid(prefix, abbr, x);
      if (el && !el.disabled) return el;
    }
    return null;
  };
  let target = null;
  if (col === 'opp') target = step(w, back ? -1 : 1, 'opp');
  else if (col === 'msc') target = back ? step(w, -1, 'osc') : gid('osc', abbr, w);
  else if (col === 'osc') target = back ? gid('msc', abbr, w) : step(w, 1, 'msc');
  if (!target || target.disabled) return;
  e.preventDefault();
  target.focus();
  target.select();
}

// One comparable string for a row's result, so an edit can be told from what
// was loaded. Values are normalised to strings ('' = not set).
function resultKey(my, op, att, type, win) {
  return [my, op, att, type, win].map(v => (v == null ? '' : String(v))).join('|');
}

// Rows on this card whose result was EDITED (compared with data-orig from the
// last load). Scores and the winner stay relative to this team — saveCard maps
// them to home/away only after the schedule is saved, because a matchup can be
// re-placed (new game id) or side-flipped (orientation inverted) by that save.
// A row whose opponent changed is skipped: its recorded result is being
// discarded (saveCard warns first) and the typed values meant the old matchup.
function readCardResults(abbr) {
  const out = [];
  for (let w = 0; w <= SCHED_MAX_WEEK; w++) {
    const row = document.getElementById(`schedrow-${abbr}-${w}`);
    if (!row || !row.dataset.game) continue;
    const opp = (gid('opp', abbr, w).value || '').trim().toUpperCase();
    if (opp !== row.dataset.opp) continue;
    const resultType = gid('rtyp', abbr, w).value;
    const my = (gid('msc', abbr, w).value || '').trim();
    const op = (gid('osc', abbr, w).value || '').trim();
    const att = (gid('att', abbr, w).value || '').trim();
    const winnerSide = gid('winr', abbr, w).value || null;
    if (resultKey(my, op, att, resultType, winnerSide) === row.dataset.orig) continue;
    if (my === '' && op === '' && att === '' && resultType === 'normal') continue;
    // The winner select's home/away values use the row's render-time
    // orientation, so translate through data-home rather than the H/A toggle.
    const myKey = row.dataset.home === '1' ? 'home' : 'away';
    out.push({
      week: w,
      opp,
      myScore: my,
      opScore: op,
      attempts: att,
      resultType,
      winnerIsMe: winnerSide == null ? null : winnerSide === myKey,
    });
  }
  return out;
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
// Season the week picker has been defaulted for. Defaulting happens once per
// season so re-opening the tab doesn't yank you off the week you were entering.
let resultsWeekSeasonId = null;

async function loadResults() {
  if (!currentSeasonId) return;
  buildWeekOptions('results-week');
  const sel = document.getElementById('results-week');

  // Open on the week the league is actively playing — that's the week whose
  // results are being entered.
  if (resultsWeekSeasonId !== currentSeasonId) {
    resultsWeekSeasonId = currentSeasonId;
    const season = allSeasons.find(s => s.id === currentSeasonId);
    const active = season?.current_week;
    // current_week can point at an admin-only stage, which the grid doesn't
    // list — fall back to Week 0 rather than leaving the picker blank.
    sel.value = String(GAME_WEEKS.some(w => w.value === Number(active)) ? active : 0);
  }

  const week = sel.value;
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
    // Flag played fair-sim games with no attempts: a recorded result the teams
    // never actually played out. Tint the row red so it stands out.
    const played = g.played_at != null || (g.home_score != null && g.away_score != null);
    const fsZero = rt === 'FS' && (g.attempts_taken ?? 0) === 0 && played;
    return `<tr data-game="${g.id}"${fsZero ? ' class="row-fs-zero"' : ''}>
      <td>${resultTeamCell(g.away_abbrev, g.away_colors, g.away_coach_id != null)}</td>
      <td><input class="grid-input" type="number" id="as-${g.id}" value="${g.away_score ?? ''}"></td>
      <td>${resultTeamCell(g.home_abbrev, g.home_colors, g.home_coach_id != null)}</td>
      <td><input class="grid-input" type="number" id="hs-${g.id}" value="${g.home_score ?? ''}"></td>
      <td><input class="grid-input" type="number" id="at-${g.id}" value="${g.attempts_taken ?? ''}" ${sim ? 'disabled' : ''}></td>
      <td><select class="grid-input wide" id="rt-${g.id}" onchange="toggleWinner(${g.id})">
        <option value="normal" ${rt === 'normal' ? 'selected' : ''}>Normal</option>
        <option value="FR" ${rt === 'FR' ? 'selected' : ''}>FR</option>
        <option value="FS" ${rt === 'FS' ? 'selected' : ''}>FS</option>
      </select></td>
      <td><select class="grid-input wide" id="wn-${g.id}" ${rt === 'FR' ? '' : 'disabled'}>
        <option value="">—</option>
        <option value="away" ${g.winner_side === 'away' ? 'selected' : ''}>${esc(g.away_abbrev)}</option>
        <option value="home" ${g.winner_side === 'home' ? 'selected' : ''}>${esc(g.home_abbrev)}</option>
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
  if (!rows.length) { tb.innerHTML = '<tr><td colspan="9" class="text-muted" style="text-align:center;padding:16px;">No results yet</td></tr>'; return; }
  tb.innerHTML = rows.map(r => {
    // Flag records that were earned without playing: a decided game count
    // (W/L/T) but zero games actually played — i.e. all forfeits/fair sims.
    const decided = r.wins + r.losses + r.ties;
    const unearned = decided > 0 && r.games_played === 0;
    return `<tr>
    <td><strong>${esc(r.team_abbrev)}</strong> ${esc(r.team_name)}</td>
    <td>${r.conference_name ? esc(r.conference_name) : '<span class="text-muted">—</span>'}</td>
    <td>${r.wins}</td><td>${r.losses}</td><td>${r.ties}</td>
    <td class="${unearned ? 'gp-zero' : ''}" ${unearned ? 'title="No games actually played — record is all forfeits/fair sims"' : ''}>${r.games_played}</td>
    <td>${r.points_for}</td><td>${r.points_against}</td>
    <td>${r.point_diff > 0 ? '+' : ''}${r.point_diff}</td>
  </tr>`;
  }).join('');
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

// ── Advancement footers ──
// The message frame is fixed server-side; only these two footers are editable.
async function loadAdvanceFooters() {
  const leagueId = currentLeagueId;
  if (!leagueId) return;
  const res = await fetch(`/api/guilds/${currentGuildId}/leagues/${leagueId}/advance-footers`);
  const data = await res.json();
  const set = (id, value, placeholder) => {
    const el = document.getElementById(id);
    el.value = value || '';
    if (placeholder) el.placeholder = placeholder;
  };
  set('advance-footer', data.footer, data.defaults?.footer);
  set('advance-admin-footer', data.adminFooter, data.defaults?.adminFooter);
}

async function saveAdvanceFooters() {
  const leagueId = currentLeagueId;
  if (!leagueId) { flash('Select a league first', 'error', 'tmpl-result'); return; }
  const body = {
    footer: document.getElementById('advance-footer').value,
    adminFooter: document.getElementById('advance-admin-footer').value,
  };
  const res = await fetch(`/api/guilds/${currentGuildId}/leagues/${leagueId}/advance-footers`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.ok) flash('Footers saved', 'success', 'tmpl-result');
  else flash(data.error || 'Failed', 'error', 'tmpl-result');
}

// ── League settings (sliders) ──
let settingsSections = [];        // schema from the server
let settingsValues = {};          // key -> current (resolved) value, edited in place
let settingsPublished = false;    // a settings post already exists in Discord
let settingsChannelConfigured = false; // league has a settings channel set
let settingsDirty = false;        // UI edited since the last Save/load

async function loadLeagueSettings() {
  const leagueId = currentLeagueId;
  if (!leagueId) return;
  const lg = currentLeague();
  document.getElementById('settings-league-badge').textContent = lg ? `${lg.name} (${lg.abbr})` : '';
  const res = await fetch(`/api/guilds/${currentGuildId}/leagues/${leagueId}/settings`);
  const data = await res.json();
  settingsSections = data.sections || [];
  settingsValues = data.values || {};
  settingsPublished = Boolean(data.published);
  settingsChannelConfigured = Boolean(data.channelConfigured);
  settingsDirty = false;
  renderSettings();
  renderSettingsPublishState();
}

// The publish button is "Publish Settings" until a post exists, then becomes
// "Update Settings". It's disabled without a configured channel or while there
// are unsaved edits (publishing always posts the SAVED state).
function renderSettingsPublishState() {
  const btn = document.getElementById('settings-publish-btn');
  const status = document.getElementById('settings-publish-status');
  if (!btn) return;
  btn.textContent = settingsPublished ? 'Update Settings' : 'Publish Settings';

  let disabled = false;
  let note = '';
  if (!settingsChannelConfigured) {
    disabled = true;
    note = 'Set a Settings Channel in ⚙ Configure to publish.';
  } else if (settingsDirty) {
    disabled = true;
    note = 'You have unsaved changes — Save Settings before publishing.';
  } else if (settingsPublished) {
    note = 'Published. Update edits the pinned post and adds a changelog message.';
  } else {
    note = 'Not published yet. Publishing posts the pinned settings message.';
  }
  btn.disabled = disabled;
  btn.classList.toggle('btn-disabled', disabled);
  status.textContent = note;
}

function markSettingsDirty() {
  if (!settingsDirty) {
    settingsDirty = true;
    renderSettingsPublishState();
  }
}

function renderSettings() {
  const root = document.getElementById('settings-sections');
  root.innerHTML = settingsSections.map(section => `
    <section class="settings-section">
      <h4 class="settings-section-title">${esc(section.title)}</h4>
      <div class="settings-grid">
        ${section.settings.map(renderSettingRow).join('')}
      </div>
    </section>
  `).join('');
}

function renderSettingRow(s) {
  const val = settingsValues[s.key];
  let control;
  if (s.type === 'range') {
    control = `
      <input type="range" class="setting-slider" id="setting-slider-${esc(s.key)}" min="${s.min}" max="${s.max}" step="1"
             value="${esc(val)}" data-key="${esc(s.key)}"
             oninput="onSettingSlider('${esc(s.key)}', this.value)">
      <input type="number" class="setting-value-input" id="setting-num-${esc(s.key)}"
             min="${s.min}" max="${s.max}" step="1" inputmode="numeric" value="${esc(val)}"
             oninput="onSettingNumber('${esc(s.key)}', this.value)"
             onchange="commitSettingNumber('${esc(s.key)}')" onfocus="this.select()">
      ${s.unit ? `<span class="setting-unit">${esc(s.unit)}</span>` : ''}`;
  } else {
    const opts = (s.type === 'toggle' ? ['OFF', 'ON'] : s.options)
      .map(o => `<option value="${esc(o)}"${String(o) === String(val) ? ' selected' : ''}>${esc(o)}</option>`)
      .join('');
    control = `
      <select class="setting-select" data-key="${esc(s.key)}"
              onchange="onSettingSelect('${esc(s.key)}', this.value)">${opts}</select>`;
  }
  return `
    <div class="setting-row">
      <label class="setting-label">${esc(s.label)}</label>
      <div class="setting-control">${control}</div>
    </div>`;
}

// Dragging the slider drives state and mirrors into the number box.
function onSettingSlider(key, value) {
  settingsValues[key] = Number(value);
  const num = document.getElementById(`setting-num-${key}`);
  if (num) num.value = value;
  markSettingsDirty();
}

// Typing in the number box drives state and the slider. Values are clamped for
// state/slider but the field text is left as typed until blur/Enter (see
// commitSettingNumber) so mid-typing isn't fought.
function onSettingNumber(key, value) {
  if (value === '' || value === '-') return; // let the user keep typing
  const n = Number(value);
  if (!Number.isFinite(n)) return;
  const setting = findSetting(key);
  const clamped = Math.min(setting.max, Math.max(setting.min, Math.round(n)));
  settingsValues[key] = clamped;
  const slider = document.getElementById(`setting-slider-${key}`);
  if (slider) slider.value = clamped;
  markSettingsDirty();
}

// On blur/Enter, snap the field text to the clamped integer (falling back to the
// current value when the box was left empty or invalid).
function commitSettingNumber(key) {
  const setting = findSetting(key);
  const num = document.getElementById(`setting-num-${key}`);
  const text = num.value.trim();
  const raw = Number(text);
  // Empty box ('' coerces to 0) or non-numeric text restores the current value.
  const clamped = (text === '' || !Number.isFinite(raw))
    ? settingsValues[key]
    : Math.min(setting.max, Math.max(setting.min, Math.round(raw)));
  settingsValues[key] = clamped;
  num.value = clamped;
  const slider = document.getElementById(`setting-slider-${key}`);
  if (slider) slider.value = clamped;
  markSettingsDirty();
}

function onSettingSelect(key, value) {
  settingsValues[key] = value;
  markSettingsDirty();
}

function findSetting(key) {
  for (const section of settingsSections) {
    const found = section.settings.find(s => s.key === key);
    if (found) return found;
  }
  return null;
}

async function saveLeagueSettings() {
  const leagueId = currentLeagueId;
  if (!leagueId) { flash('Select a league first', 'error', 'settings-result'); return; }
  const res = await fetch(`/api/guilds/${currentGuildId}/leagues/${leagueId}/settings`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: settingsValues }),
  });
  const data = await res.json();
  if (data.ok) {
    settingsValues = data.values || settingsValues; // reflect server-clamped values
    settingsDirty = false;
    renderSettings();
    renderSettingsPublishState();
    flash('Settings saved', 'success', 'settings-result');
  } else {
    flash(data.error || 'Failed to save', 'error', 'settings-result');
  }
}

// Reset every control to its schema default (client-side only until Save).
function resetLeagueSettings() {
  for (const section of settingsSections) {
    for (const s of section.settings) settingsValues[s.key] = s.default;
  }
  renderSettings();
  markSettingsDirty();
  flash('Reset to defaults — Save to apply', 'success', 'settings-result');
}

// Publish (first time) or update the pinned Discord post. Operates on the SAVED
// state, so we require a clean (saved) editor first.
async function publishLeagueSettings() {
  const leagueId = currentLeagueId;
  if (!leagueId) { flash('Select a league first', 'error', 'settings-result'); return; }
  if (!settingsChannelConfigured) {
    flash('Set a Settings Channel in Configure first', 'error', 'settings-result');
    return;
  }
  if (settingsDirty) {
    flash('Save your changes before publishing', 'error', 'settings-result');
    return;
  }
  const verb = settingsPublished ? 'update the pinned settings post and post a changelog' : 'publish the settings post';
  if (!confirm(`This will ${verb} in the league's settings channel. Continue?`)) return;

  const res = await fetch(`/api/guilds/${currentGuildId}/leagues/${leagueId}/settings/publish`, { method: 'POST' });
  const data = await res.json();
  if (data.ok) {
    settingsPublished = true;
    renderSettingsPublishState();
    const msg = data.action === 'published' ? 'Settings published'
      : data.action === 'republished' ? 'Post was missing — republished'
      : data.action === 'unchanged' ? 'Post refreshed (no value changes)'
      : `Settings updated — ${data.changed.length} change${data.changed.length === 1 ? '' : 's'} logged`;
    flash(msg, 'success', 'settings-result');
  } else {
    flash(data.error || 'Publish failed', 'error', 'settings-result');
  }
}

// Coerce one imported value to a valid value for its setting (mirrors the
// server's sanitizer), or null if it can't be salvaged.
function coerceSettingValue(setting, value) {
  if (value === undefined || value === null) return null;
  if (setting.type === 'range') {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return null;
    return Math.min(setting.max, Math.max(setting.min, n));
  }
  if (setting.type === 'toggle') {
    const v = String(value).toUpperCase();
    return (v === 'ON' || v === 'OFF') ? v : null;
  }
  if (setting.type === 'enum') {
    const v = String(value);
    return setting.options.includes(v) ? v : null;
  }
  return null;
}

// Download the current league's full (resolved) settings as a JSON file.
function exportLeagueSettings() {
  if (!settingsSections.length) { flash('Load a league first', 'error', 'settings-result'); return; }
  const lg = currentLeague();
  const payload = {
    app: 'streamgate',
    type: 'league-settings',
    version: 1,
    league: lg ? { name: lg.name, abbr: lg.abbr } : null,
    exportedAt: new Date().toISOString(),
    values: { ...settingsValues },
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const tag = lg ? lg.abbr.toLowerCase() : 'league';
  a.href = url;
  a.download = `league-settings-${tag}-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  flash('Exported settings JSON', 'success', 'settings-result');
}

function triggerSettingsImport() {
  if (!settingsSections.length) { flash('Load a league first', 'error', 'settings-result'); return; }
  document.getElementById('settings-import-file').click();
}

// Read a JSON file, validate each value against the schema, and load it into the
// editor. Nothing is saved or posted — the user reviews and clicks Save.
function onSettingsImportFile(event) {
  const input = event.target;
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    input.value = ''; // allow re-importing the same file later
    let parsed;
    try {
      parsed = JSON.parse(reader.result);
    } catch {
      flash('Import failed: file is not valid JSON', 'error', 'settings-result');
      return;
    }
    // Accept our export shape ({ values: {...} }) or a bare { key: value } map.
    const incoming = parsed && typeof parsed === 'object' && parsed.values && typeof parsed.values === 'object'
      ? parsed.values
      : parsed;
    if (!incoming || typeof incoming !== 'object') {
      flash('Import failed: no settings found in file', 'error', 'settings-result');
      return;
    }
    let applied = 0;
    let skipped = 0;
    for (const [key, raw] of Object.entries(incoming)) {
      const setting = findSetting(key);
      if (!setting) { skipped++; continue; }
      const val = coerceSettingValue(setting, raw);
      if (val === null) { skipped++; continue; }
      settingsValues[key] = val;
      applied++;
    }
    if (!applied) {
      flash('Import failed: no recognized settings in file', 'error', 'settings-result');
      return;
    }
    renderSettings();
    markSettingsDirty();
    const extra = skipped ? ` (${skipped} ignored)` : '';
    flash(`Imported ${applied} setting${applied === 1 ? '' : 's'}${extra} — review and Save`, 'success', 'settings-result');
  };
  reader.onerror = () => flash('Import failed: could not read file', 'error', 'settings-result');
  reader.readAsText(file);
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
document.getElementById('team-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeTeamModal();
});
// Dismiss the Discord-user typeahead when clicking elsewhere
document.addEventListener('click', e => {
  if (e.target.id !== 'coach-search' && !e.target.closest('#coach-search-results')) hideCoachResults();
});
// Dismiss the week-availability popover on an outside click, Escape, or any
// scroll/resize (its fixed-position anchor goes stale). Scrolling the popover's
// own list is exempt.
document.addEventListener('click', e => {
  if (availPopKey && !e.target.closest('#avail-pop') && !e.target.closest('.avail-btn')) closeAvailPop();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAvailPop(); });
window.addEventListener('scroll', e => {
  if (availPopKey && !(e.target instanceof Element && e.target.closest('#avail-pop'))) closeAvailPop();
}, true);
window.addEventListener('resize', () => closeAvailPop());

init();
