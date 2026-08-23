const MODULES = [
  ['moderation', 'Cases', 'gavel', '/case  /reason  /history', true, null],
  ['moderation', 'Moderation', 'shield', '/ban  /kick  /timeout  /purge  /slowmode', true, null],
  ['security', 'Anti-nuke', 'shield-warning', '/antinuke  /maintenance', true, null],
  ['security', 'Anti-raid', 'shield-warning', '/antiraid', false, null],
  [
    'security',
    'Automod',
    'shield-warning',
    '/automod',
    true,
    ['A permission is missing', 'blocked'],
  ],
  ['security', 'Backup', 'archive', '/backup  /restore', false, null],
  ['security', 'Phishing links', 'fish', 'Configured here only', true, null],
  ['security', 'Verification', 'shield-check', '/verify', true, ['Not on this plan', 'degraded']],
  ['engagement', 'Leveling', 'trend-up', '/rank  /levels  /xp', true, null],
  ['engagement', 'Role menus', 'list-checks', '/rolemenu', true, null],
  ['engagement', 'Starboard', 'star', 'Configured here only', false, null],
  ['engagement', 'Suggestions', 'lightbulb', '/suggest', false, null],
  ['engagement', 'Welcome & goodbye', 'hand-waving', 'Configured here only', true, null],
  ['utility', 'Announcements', 'megaphone', '/announce', false, null],
  ['utility', 'Counter channels', 'hash', 'Configured here only', false, null],
  ['utility', 'Embeds', 'layout', '/embed', true, null],
  ['utility', 'Join Roles', 'user-plus', 'Configured here only', true, null],
  ['utility', 'Permissions', 'lock', '/permissions', true, null],
  ['utility', 'Reminders', 'alarm', '/remind', false, null],
  ['utility', 'Tags', 'tag', '/tag  /tags', true, null],
  ['utility', 'Temporary Voice Channels', 'speaker-high', 'Configured here only', false, null],
  [
    'utility',
    'Tickets',
    'ticket',
    '/ticket  /close',
    true,
    ['A privileged intent is off', 'blocked'],
  ],
  ['logging', 'Message logs', 'scroll', 'Configured here only', false, null],
  ['logging', 'Server Logs', 'scroll', 'Configured here only', true, null],
];

const CATEGORIES = [
  ['moderation', 'Moderation', 'shield-check'],
  ['security', 'Security', 'lock-key'],
  ['engagement', 'Engagement', 'trend-up'],
  ['utility', 'Utility', 'wrench'],
  ['logging', 'Logging', 'list-magnifying-glass'],
];

const GUILDS = ['NW', 'PT', 'DV', 'QA'];

const esc = (s) =>
  String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const icon = (name, weight) => `<i class="${weight === 'fill' ? 'ph-fill' : 'ph'} ph-${name}"></i>`;

function general() {
  const on = MODULES.filter((m) => m[4]).length;

  return `
    <div class="page-head"><div class="page-heading"><h1 class="page-title">General settings</h1></div></div>

    <div class="identity">
      <span class="identity-avatar">NW</span>
      <span class="identity-text">
        <span class="identity-name">Northwind</span>
        <span class="identity-meta">Owner · Proton joined 2026-03-14</span>
      </span>
    </div>

    <section class="form-section">
      <h2 class="form-section-title">This server</h2>
      <div class="fact-row">
        <span class="fact-row-label">Server ID</span>
        <span class="fact-row-value id">1450209710199279760</span>
      </div>
      <div class="fact-row">
        <span class="fact-row-label">Plan<span class="field-description">Sets the ceiling on how many entries each module’s lists may hold.</span></span>
        <span class="fact-row-value"><span class="chip">Free</span></span>
      </div>
      <div class="fact-row">
        <span class="fact-row-label">Modules<span class="field-description">Switch a module on from its page in the sidebar.</span></span>
        <span class="fact-row-value num">${on} of ${MODULES.length} on</span>
      </div>
      <div class="fact-row">
        <span class="fact-row-label">Language<span class="field-description">Discord reports this server as en-US. Proton replies in English only, so this is not a setting yet.</span></span>
        <span class="fact-row-value mono">en-US</span>
      </div>
    </section>

    <section class="form-section">
      <h2 class="form-section-title">Your data</h2>
      <div class="fact-row">
        <span class="fact-row-label">What Proton stores<span class="field-description">Moderation cases, module settings, and — only where an admin switches it on — message edit and deletion logs.</span></span>
        <span class="fact-row-value"><a class="button button-quiet" href="#picker">Read the policy ${icon('arrow-right')}</a></span>
      </div>
    </section>

    <p class="status">Everything else Proton does is configured per module. Proton has no other server-wide settings yet.</p>
  `;
}

function field(label, description, control, kind = 'string') {
  return `
    <label class="field field-${kind}">
      <span class="field-label">
        <span class="field-label-text">${esc(label)}</span>
        ${description ? `<span class="field-description">${esc(description)}</span>` : ''}
      </span>
      ${control}
    </label>`;
}

function modulePage() {
  return `
    <div class="page-head">
      <div class="page-heading">
        <a class="crumb" href="#general">${icon('arrow-left')}Security</a>
        <h1 class="page-title">Automod</h1>
      </div>
    </div>

    <nav class="tabs" aria-label="Automod views">
      <a class="tab" href="#module" aria-current="page">Settings</a>
      <a class="tab" href="#cases">Cases</a>
    </nav>

    <div class="gap-card">
      <div class="gap-body">
        <span class="gap-head">
          ${icon('warning-circle', 'fill')}<span class="gap-name">Not running</span>
        </span>
        <p class="gap-text">
          Automod needs Manage Server to push rules into Discord’s own AutoMod, and Proton’s role
          does not have it in this server.
        </p>
        <span class="where">${icon('arrow-elbow-down-right')}Server Settings → Roles → Proton</span>
      </div>
    </div>

    <div class="module-state" data-state="blocked">
      ${icon('shield-warning', 'fill')}
      <span class="module-state-text">
        Switched on, but Proton cannot run it yet.
        <span class="module-state-note">
          Switching it off also takes down the rules Proton pushed into Discord’s own AutoMod.
        </span>
      </span>
    </div>

    <div class="generated-form">
      <section class="form-group">
        <div class="section-head"><h2 class="section-title">General</h2></div>
        <div class="form-section">
          ${field('Alert channel', 'Where automod reports what it acted on. Leave empty to act silently.', `<span class="field-control"><span class="select"><select><option>#modlogs</option></select></span></span>`, 'channel-id')}
          ${field('Flood threshold', 'Messages from one member, in the window below, before Proton acts.', '<input type="number" value="6" />', 'number')}
          ${field('Flood window', 'A number followed by s, m, h, d or w.', '<input type="text" value="10s" />', 'duration')}
          ${field('On a hit', 'What Proton does the first time a member trips a rule.', '<span class="select"><select><option>Delete and time out</option></select></span>', 'enum')}
          ${field('Delete the offending messages', 'Off, Proton only records the case and times the member out.', '<input type="checkbox" role="switch" checked aria-label="Delete the offending messages" />', 'boolean')}
          ${field('Rehearse only', 'Proton records what it would have done without doing it.', '<input type="checkbox" role="switch" aria-label="Rehearse only" />', 'boolean')}
        </div>
      </section>

      <section class="form-group">
        <div class="section-head"><h2 class="section-title">Exemptions</h2></div>
        <div class="form-section">
          ${field('Exempt role', 'Members holding this role are never actioned by automod.', `<span class="field-control"><span class="select"><span class="select-dot" style="--role-color:#3ba55d"></span><select><option>@Moderators</option></select></span></span>`, 'role-id')}
          <div class="field field-array">
            <span class="field-label">
              <span class="field-label-text">Blocked domains</span>
              <span class="field-description">Matched against every link posted, including redirects Proton can resolve.</span>
            </span>
            <div class="field-array-items">
              <div class="field-array-item">
                <label class="field field-string"><span class="field-label"><span class="field-label-text">Blocked domains 1</span></span><input type="text" value="grabify.link" /></label>
                <button type="button" class="button button-ghost">${icon('x')}</button>
              </div>
              <div class="field-array-item">
                <label class="field field-string"><span class="field-label"><span class="field-label-text">Blocked domains 2</span></span><input type="text" value="discord-nitro.gift" /></label>
                <button type="button" class="button button-ghost">${icon('x')}</button>
              </div>
              <button type="button" class="button button-quiet">${icon('plus')}Add Blocked domain</button>
            </div>
          </div>
          <div class="field field-array">
            <span class="field-label">
              <span class="field-label-text">Exempt channels</span>
              <span class="field-description">Nothing posted in these channels is screened.</span>
            </span>
            <div class="field-array-items">
              <p class="field-empty">None yet.</p>
              <button type="button" class="button button-quiet">${icon('plus')}Add Exempt channel</button>
            </div>
          </div>
          ${field('Exempt bots', 'Leave other applications’ messages alone.', '<input type="checkbox" role="switch" checked aria-label="Exempt bots" />', 'boolean')}
        </div>
      </section>
    </div>

    <div class="save-bar">
      <div class="save-bar-inner">
        <span class="save-bar-text">You have unsaved changes.</span>
        <button type="button" class="button button-ghost">Reset</button>
        <button type="button" class="button">Save changes</button>
      </div>
    </div>`;
}

const CASES = [
  [
    412,
    'prohibit',
    'Banned',
    'danger',
    '1902…4471',
    '2401…8830',
    'Raid account — matched join burst',
    '2026-08-21 14:02',
    '<span class="chip">active</span>',
  ],
  [
    411,
    'clock-user',
    'Timed out',
    'warn',
    '3310…9921',
    null,
    'Flood: 9 messages in 10s',
    '2026-08-21 13:47',
    '<span class="chip">expires <span class="mono">2026-08-21 14:47</span></span>',
  ],
  [
    410,
    'eraser',
    'Purged',
    'accent',
    '—',
    '2401…8830',
    '40 messages in #general',
    '2026-08-21 11:20',
    '<span class="chip">active</span>',
  ],
  [
    409,
    'warning',
    'Warned',
    'warn',
    '8820…1043',
    '2401…8830',
    'Second reminder about link spam',
    '2026-08-20 22:15',
    '<span class="chip chip-warn">Rehearsal</span>',
  ],
  [
    408,
    'sign-out',
    'Kicked',
    'warn',
    '5567…2290',
    '7781…0034',
    'Advertising in DMs',
    '2026-08-20 19:03',
    '<span class="chip chip-ok">reverted <span class="mono">2026-08-20 19:40</span></span>',
  ],
  [
    407,
    'lightning-slash',
    'Locked down',
    'danger',
    '—',
    null,
    '#announcements during the raid',
    '2026-08-20 18:58',
    '<span class="chip">active</span>',
  ],
];

function casesPage() {
  return `
    <div class="page-head">
      <div class="page-heading">
        <a class="crumb" href="#home">${icon('arrow-left')}Moderation</a>
        <h1 class="page-title">Cases</h1>
      </div>
    </div>

    <nav class="tabs" aria-label="Cases views">
      <a class="tab" href="#module">Settings</a>
      <a class="tab" href="#cases" aria-current="page">Cases</a>
    </nav>

    <div class="panel-wide">
      <div class="filters">
        <label class="filter"><span>Action</span><span class="select"><select><option>Any</option></select></span></label>
        <label class="filter"><span>Moderator ID</span><input type="text" placeholder="Any" /></label>
        <label class="filter"><span>Target ID</span><input type="text" placeholder="Any" /></label>
        <label class="filter"><span>From</span><input type="date" /></label>
        <label class="filter"><span>To</span><input type="date" /></label>
        <label class="filter"><span>Per page</span><input type="number" value="25" /></label>
      </div>

      <div class="table-card">
        <div class="table-scroll">
        <table class="cases-table">
          <thead>
            <tr>
              <th data-column="caseNumber"><button class="sort-button" type="button">#<span class="sort-caret">${icon('caret-down', 'fill')}</span></button></th>
              <th data-column="type">Action</th><th data-column="targetId">Target</th><th data-column="actorId">Moderator</th><th data-column="reason">Reason</th>
              <th data-column="createdAt"><button class="sort-button" type="button">When (UTC)</button></th><th data-column="state">State</th>
            </tr>
          </thead>
          <tbody style="height:${CASES.length * 56}px">
            ${CASES.map(
              ([n, ic, verb, tone, target, actor, reason, when, state], i) => `
              <tr style="position:absolute;top:0;left:0;width:100%;height:56px;transform:translateY(${i * 56}px)">
                <td data-column="caseNumber">#${n}</td>
                <td><span class="case-kind"><span class="tile tile-sm tile-${tone === 'accent' ? 'accent' : tone === 'danger' ? 'blocked' : tone}">${icon(ic, 'fill')}</span><span class="case-kind-name">${verb}</span></span></td>
                <td data-column="targetId"><span class="id">${target}</span></td>
                <td data-column="actorId">${actor ? `<span class="id">${actor}</span>` : `<span class="chip chip-system">${icon('lightning', 'fill')}Proton</span>`}</td>
                <td data-column="reason">${esc(reason)}</td>
                <td data-column="createdAt"><span class="stamp">${when}</span></td>
                <td data-column="state">${state}</td>
              </tr>`,
            ).join('')}
          </tbody>
        </table>
        </div>
      </div>

      <nav class="pager">
        <button type="button" class="button button-quiet" disabled>Previous</button>
        <span class="status">1–6 of 6</span>
        <button type="button" class="button button-quiet" disabled>Next</button>
      </nav>
    </div>`;
}

function emptyPage() {
  return `
    <div class="page-head">
      <div class="page-heading">
        <a class="crumb" href="#home">${icon('arrow-left')}Engagement</a>
        <h1 class="page-title">Leveling</h1>
      </div>
    </div>
    <nav class="tabs"><a class="tab" href="#module">Settings</a><a class="tab" href="#empty" aria-current="page">Leaderboard</a></nav>
    <div class="panel-wide">
      <p class="page-lede">
        Members are listed by ID. Proton does not resolve names, because Discord’s rate limits do not
        allow fetching a whole member list.
      </p>
      <div class="table-card">
        <div class="empty-state">
          <span class="tile">${icon('chart-bar')}</span>
          <span class="empty-state-title">Nobody has earned XP yet.</span>
          <p class="status">Members appear here once Leveling is switched on and somebody talks.</p>
        </div>
      </div>
    </div>`;
}

function moduleNavItem([, name, ic, , on, warn], openModule) {
  const open = name === openModule;
  const state = warn ? warn[1] : on ? 'running' : 'off';

  return `
    <div class="nav-module" data-state="${state}" ${open ? 'data-open="true"' : ''}>
      <a class="nav-item" href="#module" ${open ? 'aria-current="page"' : ''}>
        ${icon(ic, open ? 'fill' : 'regular')}<span class="nav-item-label">${esc(name)}</span>
      </a>
      ${open ? `<input type="checkbox" role="switch" class="nav-switch" ${on ? 'checked' : ''} aria-label="Switch ${name}" />` : ''}
    </div>`;
}

function shell(inner, page, openModule) {
  return `
    <a class="skip-link" href="#main">Skip to content</a>
    <div class="shell">
      <nav class="rail" aria-label="Servers">
        <a class="rail-home" href="#picker"><img src="../public/proton-mark.png" alt="Proton" width="28" height="28" style="display:block" /></a>
        <span class="rail-sep"></span>
        ${GUILDS.map((g, i) => `<a class="rail-guild" href="#home" ${i === 0 ? 'aria-current="page"' : ''}>${g}</a>`).join('')}
        <span class="rail-spacer"></span>
        <button type="button" class="rail-user">FR</button>
      </nav>

      <header class="topbar">
        <button type="button" class="icon-button">${icon('list')}</button>
        <span class="topbar-name">Northwind</span>
        <button type="button" class="icon-button">${icon('magnifying-glass')}</button>
        <button type="button" class="icon-button">${icon('user-circle')}</button>
      </header>

      <aside class="sidebar">
        <div class="sidebar-head">
          <div class="sidebar-name">Northwind</div>
          <div class="sidebar-meta">Owner</div>
        </div>
        <button type="button" class="search-trigger">
          ${icon('magnifying-glass')}Search settings<span class="kbd">⌘K</span>
        </button>
        <nav class="sidebar-nav" aria-label="Proton">
          <div class="nav-group">
            <a class="nav-item" href="#general" ${page === 'general' ? 'aria-current="page"' : ''}>
              ${icon('sliders-horizontal', page === 'general' ? 'fill' : 'regular')}<span class="nav-item-label">General settings</span>
            </a>
          </div>
          <div class="nav-group">
            <span class="nav-group-label">Browse</span>
            <a class="nav-item" href="#cases" ${page === 'cases' ? 'aria-current="page"' : ''}>${icon('scales')}<span class="nav-item-label">Cases</span></a>
            <a class="nav-item" href="#empty">${icon('ranking')}<span class="nav-item-label">Leaderboard</span></a>
            <a class="nav-item" href="#cases">${icon('tag')}<span class="nav-item-label">Tags</span></a>
          </div>
          ${CATEGORIES.map(([key, label]) => {
            const owned = MODULES.filter((m) => m[0] === key);
            return `
              <div class="nav-group">
                <span class="nav-group-label">${label}</span>
                ${owned.map((m) => moduleNavItem(m, openModule)).join('')}
              </div>`;
          }).join('')}
        </nav>
      </aside>

      <main class="main" id="main"><div class="page">${inner}</div></main>
    </div>`;
}

function door() {
  return `
    <div class="door">
      <div class="door-inner">
        <div class="door-mark">
          <img src="../public/proton-mark.png" alt="Proton" width="30" height="30" style="display:block" />
          <span class="door-wordmark">Proton</span>
        </div>
        <div class="door-copy">
          <h1 class="door-title">Moderation your team can audit.</h1>
          <p class="door-sub">
            Every action Proton takes becomes a numbered case with the moderator, the reason and the
            time. Configure it here; run it from Discord.
          </p>
        </div>
        <ul class="door-facts">
          <li><b>Moderation</b>Bans, kicks, timeouts and purges, each recorded as a case you can search and reverse.</li>
          <li><b>Security</b>Discord’s own AutoMod for what it can block at the edge; Proton for the rest.</li>
          <li><b>Engagement</b>Levels, role menus, tickets and scheduled announcements.</li>
        </ul>
        <a class="button button-discord door-button" href="#home">${icon('discord-logo', 'fill')}Continue with Discord</a>
        <p class="door-fineprint">
          Proton stores moderation cases, server settings and — only where a server admin switches it
          on — message edit and deletion logs.
        </p>
        <div class="door-links"><a class="door-link" href="#picker">Your servers</a><a class="door-link" href="#picker">Privacy policy</a></div>
      </div>
      <div class="door-art" aria-hidden="true"><img src="../public/proton-mark.png" alt="" /></div>
    </div>`;
}

function picker() {
  const rows = [
    ['Northwind', 'Owner', 'NW'],
    ['Protocol Test', 'Manage Server', 'PT'],
    ['Devcord', 'Manage Server', 'DV'],
    ['QA Sandbox', 'Owner', 'QA'],
  ];
  return `
    <div class="plain-page">
      <div class="page">
        <a class="back-link" href="#door">${icon('arrow-left')}Proton</a>
        <div class="page-head"><div class="page-heading"><h1 class="page-title">Your servers</h1></div></div>
        <p class="page-lede">
          These are the servers you own or hold Manage Server in. Proton only ever acts on the ones it
          has been invited to.
        </p>
        <ul class="guild-list">
          ${rows
            .map(
              ([name, role, initials]) => `
            <li><div class="guild-row">
              <span class="guild-avatar">${initials}</span>
              <span class="guild-row-text"><span class="guild-row-name">${name}</span><span class="guild-row-role">${role}</span></span>
              <a class="button button-quiet" href="#home">Open ${icon('arrow-right')}</a>
            </div></li>`,
            )
            .join('')}
        </ul>
      </div>
    </div>`;
}

function palette() {
  const items = [
    ['shield-warning', 'Automod', 'Modules / Security'],
    ['clock-user', 'Flood window', 'Automod / settings'],
    ['hash', 'Log channel', 'Automod / settings'],
    ['gavel', 'Cases', 'Modules / Moderation'],
    ['trend-up', 'Leveling', 'Modules / Engagement'],
  ];
  return `${shell(home())}
    <div class="palette-scrim">
      <div class="palette-backdrop"></div>
      <div class="palette" role="dialog" aria-modal="true" aria-label="Search Proton">
        <div class="palette-head">
          ${icon('magnifying-glass')}
          <input type="text" value="auto" aria-label="Search" />
          <button type="button" class="palette-esc">ESC</button>
        </div>
        <div class="palette-results" role="listbox">
          ${items
            .map(
              ([ic, label, trail], i) => `
            <div class="palette-item" role="option" data-selected="${i === 0}">
              ${icon(ic, i === 0 ? 'fill' : 'regular')}
              <span class="palette-item-text"><span class="palette-item-label">${label}</span><span class="palette-item-path">${trail}</span></span>
              ${i === 0 ? '<span class="kbd">ENTER</span>' : ''}
            </div>`,
            )
            .join('')}
        </div>
      </div>
    </div>`;
}

const VIEWS = {
  general: () => shell(general(), 'general'),
  module: () => shell(modulePage(), 'module', 'Automod'),
  cases: () => shell(casesPage(), 'cases'),
  empty: () => shell(emptyPage(), 'empty'),
  palette,
  door,
  picker,
};

function render() {
  const key = location.hash.slice(1) || 'general';
  document.getElementById('root').innerHTML = (VIEWS[key] ?? VIEWS.general)();
}

addEventListener('hashchange', render);
render();
