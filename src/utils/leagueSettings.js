'use strict';

// League gameplay settings (sliders / toggles / dropdowns), grouped into the
// same sections the in-game menus use. This module is the single source of
// truth: the API serves SECTIONS to the admin portal for rendering, uses the
// derived defaults to fill unset values, and sanitises anything saved back.
//
// Setting shapes:
//   { key, label, type: 'range',  min, max, default, unit? }
//   { key, label, type: 'toggle', default }                     // 'ON' | 'OFF'
//   { key, label, type: 'enum',   options: [...], default }
//
// Only overrides are persisted (as JSON in leagues.settings); resolveSettings()
// merges them over the defaults so new settings added here appear automatically.

const OFF_ON = ['OFF', 'ON'];

// A 1–100 slider defaulting to 50 — by far the most common shape.
// `short` is an optional compact label used only in the narrow Discord embed
// columns; the admin UI always shows the full `label`.
const scale = (key, label, short) => ({
  key, label, type: 'range', min: 1, max: 100, default: 50, ...(short ? { short } : {}),
});

// A position XP slider: 0–300, defaulting to 100 (in-game "normal").
const xp = (key, label) => ({ key, label, type: 'range', min: 0, max: 300, default: 100 });

// A "NONE or 1..max" dropdown defaulting to NONE (e.g. Play Cooldown/Call Limit).
const noneOrCount = (key, label, max) => ({
  key, label, type: 'enum',
  options: ['NONE', ...Array.from({ length: max }, (_, i) => String(i + 1))],
  default: 'NONE',
});

const SECTIONS = [
  {
    title: 'League Settings',
    settings: [
      { key: 'skill_level', label: 'Skill Level', type: 'enum', options: ['FRESHMAN', 'VARSITY', 'ALL-AMERICAN', 'HEISMAN'], default: 'ALL-AMERICAN' },
      { key: 'coach_firing', label: 'Coach Firing', type: 'enum', options: ['OFF', 'ON', 'CPU ONLY'], default: 'ON' },
      { key: 'coach_xp', label: 'Coach XP Setting', type: 'enum', options: ['CAREER', 'SIMULATION', 'CASUAL'], default: 'CASUAL' },
      { key: 'injury', label: 'Injury', type: 'toggle', default: 'ON' },
      { key: 'manual_progression_xp_penalty', label: 'Manual Progression XP Penalty', short: 'Manual XP Penalty', type: 'range', min: 1, max: 100, default: 25, unit: '%' },
      noneOrCount('play_call_limit', 'Play Call Limit', 20),
      noneOrCount('play_cooldown', 'Play Cooldown', 10),
      { key: 'preorder_membership_bonuses', label: 'Pre-Order & Membership Bonuses', short: 'Pre-Order Bonuses', type: 'toggle', default: 'OFF' },
      { key: 'recruit_flipping', label: 'Recruit Flipping', type: 'toggle', default: 'ON' },
      { key: 'verbal_commit_influence', label: 'Verbal Commit Influence', short: 'Verbal Commit Infl.', type: 'range', min: 1, max: 100, default: 25, unit: '%' },
    ],
  },
  {
    title: 'Clock Management Settings',
    short: 'Clock Management',
    settings: [
      { key: 'quarter_length', label: 'Quarter Length', type: 'range', min: 1, max: 15, default: 9, unit: 'min' },
      { key: 'accelerated_clock', label: 'Accelerated Clock', type: 'toggle', default: 'ON' },
      { key: 'min_play_clock_time', label: 'Minimum Play Clock Time', short: 'Min Play Clock', type: 'enum', options: ['OFF', '10', '15', '20', '25', '30', '35', '40'], default: '15' },
    ],
  },
  {
    title: 'Transfer Portal',
    settings: [
      { key: 'max_transfers_per_team', label: 'Max Transfers Per Team', short: 'Max Transfers/Team', type: 'range', min: 0, max: 20, default: 10 },
      { key: 'user_player_transfer_chance', label: 'User Player Transfer Chance', short: 'User Transfer Chance', type: 'range', min: 0, max: 100, default: 35 },
      { key: 'cpu_player_transfer_chance', label: 'CPU Player Transfer Chance', short: 'CPU Transfer Chance', type: 'range', min: 0, max: 100, default: 35 },
    ],
  },
  {
    title: 'Game Options',
    settings: [
      { key: 'game_injuries', label: 'Injuries', type: 'range', min: 1, max: 100, default: 10 },
      { key: 'game_fatigue', label: 'Fatigue', type: 'range', min: 1, max: 100, default: 50 },
      { key: 'game_min_player_speed_threshold', label: 'Min Player Speed Threshold', short: 'Min Speed Threshold', type: 'range', min: 1, max: 100, default: 50 },
    ],
  },
  {
    title: 'Precipitation Options',
    short: 'Precipitation',
    settings: [
      scale('precip_catch_chance', 'Catch Chance Scale', 'Catch Chance'),
      scale('precip_pass_accuracy', 'Pass Accuracy Scale', 'Pass Accuracy'),
      scale('precip_pass_strength', 'Pass Strength Scale', 'Pass Strength'),
      scale('precip_broken_tackle', 'Broken Tackle Scale', 'Broken Tackle'),
      scale('precip_kicking_accuracy', 'Kicking Accuracy Scale', 'Kicking Accuracy'),
      scale('precip_kicking_strength', 'Kicking Strength Scale', 'Kicking Strength'),
      scale('precip_slip', 'Slip Scale', 'Slip'),
      scale('precip_movement_penalties', 'Movement Penalties', 'Movement'),
    ],
  },
  {
    title: 'Wear and Tear Options',
    short: 'Wear & Tear',
    settings: [
      { key: 'wear_and_tear', label: 'Wear and Tear', type: 'toggle', default: 'ON' },
      scale('wt_normal_tackle_impact', 'Normal Tackle Impact', 'Normal Tackle'),
      scale('wt_catch_tackle_impact', 'Catch Tackle Impact', 'Catch Tackle'),
      scale('wt_hit_stick_impact', 'Hit Stick Impact', 'Hit Stick'),
      scale('wt_cut_stick_impact', 'Cut Stick Impact', 'Cut Stick'),
      scale('wt_defender_tackle_advantage_impact', 'Defender Tackle Advantage Impact', 'Def. Tackle Adv.'),
      scale('wt_sack_impact', 'Sack Impact', 'Sack'),
      scale('wt_block_impact', 'Block Impact', 'Block'),
      scale('wt_impact_block_impact', 'Impact Block Impact', 'Impact Block'),
      scale('wt_per_play_recovery', 'Per-Play Recovery', 'Per-Play Rec.'),
      scale('wt_per_timeout_recovery', 'Per-Timeout Recovery', 'Per-Timeout Rec.'),
      scale('wt_between_quarter_recovery', 'Between-Quarter Recovery', 'Between-Qtr Rec.'),
      scale('wt_halftime_recovery', 'Halftime Recovery', 'Halftime Rec.'),
      scale('wt_ingame_healing_reserve_pool', 'In-Game Healing Reserve Pool', 'Healing Reserve'),
    ],
  },
  {
    title: 'Player Skill',
    settings: [
      scale('player_qb_accuracy', 'QB Accuracy'),
      scale('player_pass_blocking', 'Pass Blocking'),
      scale('player_wr_catching', 'WR Catching'),
      scale('player_run_blocking', 'Run Blocking'),
      scale('player_ball_security', 'Ball Security'),
      scale('player_interceptions', 'Interceptions'),
      scale('player_pass_coverage', 'Pass Coverage'),
      scale('player_tackling', 'Tackling'),
    ],
  },
  {
    title: 'CPU Skill',
    settings: [
      scale('cpu_qb_accuracy', 'QB Accuracy'),
      scale('cpu_pass_blocking', 'Pass Blocking'),
      scale('cpu_wr_catching', 'WR Catching'),
      scale('cpu_run_blocking', 'Run Blocking'),
      scale('cpu_ball_security', 'Ball Security'),
      scale('cpu_interceptions', 'Interceptions'),
      scale('cpu_pass_coverage', 'Pass Coverage'),
      scale('cpu_tackling', 'Tackling'),
    ],
  },
  {
    title: 'Special Teams',
    settings: [
      scale('st_fg_power', 'FG Power'),
      scale('st_fg_accuracy', 'FG Accuracy'),
      scale('st_punt_power', 'Punt Power'),
      scale('st_punt_accuracy', 'Punt Accuracy'),
      scale('st_kickoff_power', 'Kickoff Power'),
    ],
  },
  {
    title: 'Penalties',
    settings: [
      scale('pen_offside', 'Offside'),
      scale('pen_false_start', 'False Start'),
      scale('pen_holding', 'Holding'),
      scale('pen_face_mask', 'Face Mask'),
      scale('pen_defensive_pass_interference', 'Defensive Pass Interference', 'Def. Pass Interference'),
      { key: 'pen_offensive_pass_interference', label: 'Offensive Pass Interference', short: 'Off. Pass Interference', type: 'toggle', default: 'ON' },
      { key: 'pen_kick_catch_interference', label: 'Kick Catch Interference', short: 'Kick Catch Int.', type: 'toggle', default: 'ON' },
      scale('pen_illegal_block_in_the_back', 'Illegal Block In The Back', 'Illegal Block Back'),
      { key: 'pen_intentional_grounding', label: 'Intentional Grounding', short: 'Int. Grounding', type: 'toggle', default: 'ON' },
      scale('pen_roughing_passer', 'Roughing Passer'),
      { key: 'pen_roughing_kicker', label: 'Roughing Kicker', type: 'toggle', default: 'ON' },
      { key: 'pen_running_into_the_kicker', label: 'Running Into The Kicker', short: 'Into The Kicker', type: 'toggle', default: 'ON' },
      { key: 'pen_illegal_contact', label: 'Illegal Contact', type: 'toggle', default: 'ON' },
    ],
  },
  {
    title: 'Offensive XP',
    settings: [
      xp('xp_off_quarterbacks', 'Quarterbacks'),
      xp('xp_off_halfbacks', 'Halfbacks'),
      xp('xp_off_tight_ends', 'Tight Ends'),
      xp('xp_off_wide_receivers', 'Wide Receivers'),
      xp('xp_off_full_backs', 'Full Backs'),
      xp('xp_off_tackles', 'Tackles'),
      xp('xp_off_guards', 'Guards'),
      xp('xp_off_centers', 'Centers'),
    ],
  },
  {
    title: 'Defensive XP',
    settings: [
      xp('xp_def_edge_defenders', 'EDGE Defenders'),
      xp('xp_def_defensive_tackles', 'Defensive Tackles'),
      xp('xp_def_middle_linebackers', 'Middle Linebackers'),
      xp('xp_def_outside_linebackers', 'Outside Linebackers'),
      xp('xp_def_cornerbacks', 'Cornerbacks'),
      xp('xp_def_free_safeties', 'Free Safeties'),
      xp('xp_def_strong_safeties', 'Strong Safeties'),
    ],
  },
  {
    title: 'Special Teams XP',
    settings: [
      xp('xp_st_kickers', 'Kickers'),
      xp('xp_st_punters', 'Punters'),
    ],
  },
];

// Flat map of key -> setting definition, and key -> default value.
const ALL_SETTINGS = SECTIONS.flatMap(s => s.settings);
const SETTINGS_BY_KEY = Object.fromEntries(ALL_SETTINGS.map(s => [s.key, s]));
const DEFAULTS = Object.fromEntries(ALL_SETTINGS.map(s => [s.key, s.default]));

// Coerce one incoming value to a valid value for its setting, or null if it
// can't be salvaged (caller falls back to the default).
function coerce(setting, value) {
  if (value === undefined || value === null) return null;
  if (setting.type === 'range') {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return null;
    return Math.min(setting.max, Math.max(setting.min, n));
  }
  if (setting.type === 'toggle') {
    const v = String(value).toUpperCase();
    return OFF_ON.includes(v) ? v : null;
  }
  if (setting.type === 'enum') {
    const v = String(value);
    return setting.options.includes(v) ? v : null;
  }
  return null;
}

// Full settings object with every key present: stored overrides on top of
// defaults. Unknown/invalid stored values are dropped in favour of the default.
function resolveSettings(stored) {
  const out = { ...DEFAULTS };
  if (stored && typeof stored === 'object') {
    for (const [key, val] of Object.entries(stored)) {
      const setting = SETTINGS_BY_KEY[key];
      if (!setting) continue;
      const c = coerce(setting, val);
      if (c !== null) out[key] = c;
    }
  }
  return out;
}

// Reduce an incoming values object to a clean, minimal override map: only known
// keys, only values that differ from the default, all validated.
function sanitizeSettings(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const setting of ALL_SETTINGS) {
    const c = coerce(setting, input[setting.key]);
    if (c !== null && c !== setting.default) out[setting.key] = c;
  }
  return out;
}

module.exports = { SECTIONS, DEFAULTS, resolveSettings, sanitizeSettings };
