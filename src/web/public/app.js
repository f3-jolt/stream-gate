'use strict';

let currentUser = null;
let currentGuildId = null;
let allUsers = [];
let allLeagues = [];

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

  // Populate user chip from session (fetch /auth/me separately)
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
  renderUsers(allUsers);
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

function filterUsers() {
  const q = document.getElementById('user-search').value.toLowerCase();
  renderUsers(allUsers.filter(u =>
    u.discord_username.toLowerCase().includes(q) ||
    u.discord_id.includes(q) ||
    u.league_name.toLowerCase().includes(q) ||
    (u.team_name || '').toLowerCase().includes(q)
  ));
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
  // Populate league dropdown
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

// ── Streams ────────────────────────────────────────────────────────────────────

async function loadStreams() {
  const res = await fetch(`/api/guilds/${currentGuildId}/streams`);
  const streams = await res.json();
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

init();
