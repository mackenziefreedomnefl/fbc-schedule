/* Schedule Dashboard — frontend SPA
 *
 * Auth model:
 * - Anonymous visitors see ALL clubs stacked in read-only mode
 * - Owners log in with email + password and get full edit access plus an
 *   Admin panel (Users + Activity log)
 * - Managers log in with email + password and can only edit cells, notes,
 *   and roster for employees in their assigned team
 */
(function () {
  'use strict';

  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  // Default shift notice shown before the custom one has loaded or if it's
  // blank. Owners can edit the stored text via the UI.
  const DEFAULT_NOTICE_TEXT =
    'All shifts are intended to be open to close unless otherwise posted. All shifts are subject to reservations and operational needs. Shift start times are posted the evening before the shift in dock slack channels.';
  let NOTICE_TEXT = DEFAULT_NOTICE_TEXT;
  // Managers can plan up to three weeks in advance: this week, next week,
  // and the week after next. These keys are used in state.tab and as the
  // keys in state.weekData.
  const WEEK_KEYS = ['current', 'next', 'week3'];
  const WEEK_LABELS = {
    current: 'This week',
    next: 'Next week',
    week3: 'Week after next',
  };
  const WEEK_HEADINGS = {
    current: 'Current Work Week',
    next: 'Next Work Week',
    week3: 'Week After Next',
  };

  const state = {
    me: { id: null },
    clubs: [],
    tab: 'current',
    weekStart: null,
    weekData: { current: {}, next: {}, week3: {} },
    // Draft / undo-redo state. pendingChanges is a Map keyed by
    // "scheduleId:empId:dayIndex" (or "T:scheduleId:loc:dayIndex" for totals).
    // Each value = { schedule_id, employee_id|null, location|null, day_index,
    //               shift_text, server_value }
    pendingChanges: new Map(),
    undoStack: [],   // [ { key, old_value, new_value, server_value, ...ids } ]
    redoStack: [],
  };

  // -------- dom helpers --------
  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, props = {}, children = []) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null) n.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
      if (c == null) continue;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return n;
  };

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      const text = await res.text().catch(() => '');
      try {
        const parsed = JSON.parse(text);
        if (parsed && parsed.error) msg = parsed.error;
      } catch (_) {
        if (text) msg += `: ${text.slice(0, 200)}`;
      }
      throw new Error(msg);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  function toast(msg, kind = 'ok') {
    const t = el('div', { class: `toast ${kind}` }, msg);
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2200);
  }

  function mondayOf(d) {
    const date = new Date(d);
    const day = date.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    date.setDate(date.getDate() + diff);
    return date.toISOString().slice(0, 10);
  }

  function addDays(dateStr, n) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  }

  function fmtWeek(weekStart) {
    const start = new Date(weekStart + 'T00:00:00');
    const end = new Date(start); end.setDate(end.getDate() + 6);
    const fmt = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `${fmt(start)} — ${fmt(end)}, ${end.getFullYear()}`;
  }

  function fmtRelative(iso) {
    const d = new Date(iso);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function teamClass(team) {
    if (!team) return 'row-team-main';
    const t = team.toLowerCase();
    if (t === 'main' || t === 'julington creek') return 'row-team-main';
    if (t === 'team 2' || t === 'jacksonville beach') return 'row-team-2';
    if (t === 'shared') return 'row-team-shared';
    return 'row-team-main';
  }
  function teamBadgeClass(team) {
    if (!team) return 'team-main';
    const t = team.toLowerCase();
    if (t === 'main' || t === 'julington creek') return 'team-main';
    if (t === 'team 2' || t === 'jacksonville beach') return 'team-2';
    if (t === 'shared') return 'team-shared';
    return 'team-main';
  }
  function teamsForClub(clubName) {
    if (clubName === 'Jacksonville') return ['Julington Creek', 'Jacksonville Beach'];
    return []; // St. Augustine (and anything else) has no sub-teams
  }

  // Cell text coloring rules: managers type keywords and the text re-colors
  // to give a quick visual read of the grid.
  function cellColorFor(text) {
    if (!text) return '';
    const s = text.toLowerCase();
    if (s.includes('req off')) return 'var(--danger)';
    if (s.includes('west')) return 'var(--accent)';
    if (s.includes('shipyard')) return 'var(--accent)';
    return '';
  }

  // -------- permission helpers --------
  function isOwner() { return state.me && (state.me.role === 'owner' || state.me.role === 'admin'); }
  function isLoggedIn() { return state.me && state.me.id != null; }
  // Any signed-in user (owner or manager) can edit every club and every
  // team. Per-location restrictions were removed on request.
  function canEditEmployee(/* employee */) { return isLoggedIn(); }
  function canEditTeam(/* clubId, team */) { return isLoggedIn(); }
  function canEditClub(/* clubId */) { return isLoggedIn(); }

  // -------- draft / undo / redo --------
  function cellKey(scheduleId, empId, dayIndex) {
    return `${scheduleId}:${empId}:${dayIndex}`;
  }
  function totalKey(scheduleId, loc, dayIndex) {
    return `T:${scheduleId}:${loc}:${dayIndex}`;
  }

  function recordEdit(key, ids, oldVal, newVal, serverVal) {
    state.undoStack.push({ key, ...ids, old_value: oldVal, new_value: newVal, server_value: serverVal });
    state.redoStack = [];
    if (newVal === serverVal) {
      state.pendingChanges.delete(key);
    } else {
      state.pendingChanges.set(key, { ...ids, shift_text: newVal, server_value: serverVal });
    }
    updateDraftToolbar();
  }

  function applyUndoRedo(entry, valueToSet) {
    const inp = document.querySelector(`[data-cell-key="${entry.key}"]`);
    if (inp) {
      inp.value = valueToSet;
      inp.style.color = cellColorFor(valueToSet);
    }
    if (valueToSet === entry.server_value) {
      state.pendingChanges.delete(entry.key);
    } else {
      state.pendingChanges.set(entry.key, {
        schedule_id: entry.schedule_id,
        employee_id: entry.employee_id || null,
        location: entry.location || null,
        day_index: entry.day_index,
        shift_text: valueToSet,
        server_value: entry.server_value,
      });
    }
    updateDraftToolbar();
  }

  function undo() {
    if (!state.undoStack.length) return;
    const entry = state.undoStack.pop();
    state.redoStack.push(entry);
    applyUndoRedo(entry, entry.old_value);
  }

  function redo() {
    if (!state.redoStack.length) return;
    const entry = state.redoStack.pop();
    state.undoStack.push(entry);
    applyUndoRedo(entry, entry.new_value);
  }

  async function saveDraft() {
    if (!state.pendingChanges.size) return;
    const changes = Array.from(state.pendingChanges.values());
    state.pendingChanges.clear();
    state.undoStack = [];
    state.redoStack = [];

    let ok = 0;
    let failed = 0;
    for (const c of changes) {
      try {
        if (c.location) {
          await api(`/api/schedules/${c.schedule_id}/total`, {
            method: 'PATCH',
            body: { location: c.location, day_index: c.day_index, count_text: c.shift_text },
          });
        } else {
          await api(`/api/schedules/${c.schedule_id}/cell`, {
            method: 'PATCH',
            body: { employee_id: c.employee_id, day_index: c.day_index, shift_text: c.shift_text },
          });
        }
        ok++;
      } catch (err) {
        failed++;
        toast(err.message, 'err');
      }
    }
    if (ok) toast(`Saved ${ok} change${ok === 1 ? '' : 's'}`);
    if (failed) toast(`${failed} change${failed === 1 ? '' : 's'} failed`, 'err');
    updateDraftToolbar();
    // Reload data so server state matches what we just saved
    await loadAllSchedules();
    renderBody();
  }

  function updateDraftToolbar() {
    const bar = document.querySelector('.draft-toolbar');
    if (!bar) return;
    const count = state.pendingChanges.size;
    const label = bar.querySelector('.draft-count');
    const saveBtn = bar.querySelector('.draft-save');
    const undoBtn = bar.querySelector('.draft-undo');
    const redoBtn = bar.querySelector('.draft-redo');
    if (label) label.textContent = count ? `${count} unsaved change${count === 1 ? '' : 's'}` : 'No changes';
    if (saveBtn) saveBtn.disabled = !count;
    if (undoBtn) undoBtn.disabled = !state.undoStack.length;
    if (redoBtn) redoBtn.disabled = !state.redoStack.length;
  }

  // Keyboard shortcuts: Ctrl+Z = undo, Ctrl+Shift+Z / Ctrl+Y = redo, Ctrl+S = save
  document.addEventListener('keydown', (e) => {
    if (!isLoggedIn()) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (mod && (e.key === 'Z' || e.key === 'y')) { e.preventDefault(); redo(); }
    else if (mod && e.key === 's') { e.preventDefault(); saveDraft(); }
  });

  // Warn if leaving the page with unsaved changes
  window.addEventListener('beforeunload', (e) => {
    if (state.pendingChanges.size) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // -------- modal --------
  function openModal(content, opts = {}) {
    const root = $('#modal-root');
    root.innerHTML = '';
    const backdrop = el('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) closeModal(); } });
    const modal = el('div', { class: 'modal' + (opts.wide ? ' modal-wide' : '') });
    modal.appendChild(content);
    backdrop.appendChild(modal);
    root.appendChild(backdrop);
  }
  function closeModal() { $('#modal-root').innerHTML = ''; }

  // -------- bootstrap --------
  function weekForTab(tab) {
    const thisWeek = mondayOf(new Date());
    if (tab === 'week3') return addDays(thisWeek, 14);
    if (tab === 'next') return addDays(thisWeek, 7);
    return thisWeek;
  }

  async function bootstrap() {
    try {
      const [me, clubs, notice] = await Promise.all([
        api('/api/me'),
        api('/api/clubs'),
        api('/api/notice').catch(() => ({ text: '' })),
      ]);
      state.me = me || { id: null };
      state.clubs = clubs || [];
      if (notice && notice.text) NOTICE_TEXT = notice.text;
      state.weekStart = weekForTab(state.tab);
      await render();
      if (isLoggedIn()) {
        loadNotifications().catch(() => {});
      }
    } catch (err) {
      const body = $('#main-body');
      if (body) {
        body.innerHTML = '';
        body.appendChild(el('div', { class: 'error', style: 'padding:20px;' },
          `Failed to load: ${err && err.message ? err.message : err}`));
      }
      console.error('[bootstrap] failed', err);
    }
  }

  // Fetch schedule_published notifications and show a banner for anything
  // newer than the id stored in localStorage. Dismiss clears the banner and
  // updates the stored id so the same notifications don't reappear.
  async function loadNotifications() {
    let entries;
    try { entries = await api('/api/notifications'); }
    catch (_) { return; }
    if (!entries || !entries.length) return;

    const lastSeen = Number(localStorage.getItem('fbc-last-publish-seen') || 0);
    const unseen = entries.filter(e => Number(e.id) > lastSeen);
    if (!unseen.length) return;

    const body = $('#main-body');
    if (!body) return;
    const banner = el('div', { class: 'publish-banner' });
    banner.appendChild(el('div', { class: 'publish-banner-title' },
      `${unseen.length} new published schedule${unseen.length === 1 ? '' : 's'}`));
    const list = el('div', { class: 'publish-banner-list' });
    unseen.slice(0, 5).forEach(e => {
      const d = e.details || {};
      const team = d.team ? ` (${d.team})` : '';
      const msg = d.message ? ` — "${d.message}"` : '';
      const line = `${fmtRelative(e.created_at)} — ${e.user_label} published ${e.club_name || ''}${team} for week of ${d.week_start}${msg}`;
      list.appendChild(el('div', {}, line));
    });
    banner.appendChild(list);
    banner.appendChild(el('button', {
      class: 'ghost',
      onclick: () => {
        const newest = unseen.reduce((m, e) => Math.max(m, Number(e.id)), 0);
        localStorage.setItem('fbc-last-publish-seen', String(newest));
        banner.remove();
      },
    }, 'Dismiss'));
    body.insertBefore(banner, body.firstChild);
  }

  async function switchTab(tab) {
    state.tab = tab;
    state.weekStart = weekForTab(tab);
    await loadAllSchedules();
    renderBody();
  }

  // Builds a This week / Next week tab strip bound to the shared state.tab.
  // Used both in the top-level tab row and inside each club header so the
  // user can flip weeks from anywhere. Every tab strip on the page always
  // reflects the same week because switchTab re-renders the whole body.
  function buildWeekTabs() {
    const tabs = el('div', { class: 'week-tabs' });
    WEEK_KEYS.forEach(key => {
      tabs.appendChild(el('button', {
        class: 'week-tab' + (state.tab === key ? ' active' : ''),
        onclick: () => switchTab(key),
      }, WEEK_LABELS[key]));
    });
    tabs.appendChild(el('div', { class: 'week-tabs-range muted' }, fmtWeek(state.weekStart)));
    return tabs;
  }

  async function render() {
    renderTopbar();
    await loadAllSchedules();
    renderBody();
  }

  function renderTopbar() {
    const chip = $('#user-chip');
    chip.innerHTML = '';
    if (isLoggedIn()) {
      const label = state.me.name || state.me.email;
      const role = isOwner() ? 'Owner' : `Manager · ${state.me.team || '—'}`;
      chip.appendChild(el('span', { class: 'muted' }, `${label} · ${role}`));
      if (isOwner()) {
        chip.appendChild(el('button', { class: 'ghost', onclick: openAdminPanel }, 'Admin'));
      }
      chip.appendChild(el('button', { class: 'ghost', onclick: openChangePasswordModal }, 'Change password'));
      chip.appendChild(el('button', {
        class: 'ghost',
        onclick: async () => {
          try { await api('/api/logout', { method: 'POST' }); } catch (_) {}
          state.me = { id: null };
          await render();
          toast('Signed out');
        },
      }, 'Sign out'));
    } else {
      chip.appendChild(el('button', { class: 'primary', onclick: openLoginModal }, 'Sign in'));
    }
  }

  async function loadAllSchedules() {
    // Anonymous staff see every configured week stacked, so we fetch all of
    // them. Signed-in managers/owners use tabs so we only fetch the active
    // week to keep the request count down.
    const weeksToLoad = isLoggedIn() ? [state.tab] : WEEK_KEYS.slice();
    const empty = {};
    WEEK_KEYS.forEach(k => { empty[k] = {}; });
    state.weekData = empty;
    for (const weekKey of weeksToLoad) {
      const weekStart = weekForTab(weekKey);
      const results = await Promise.all(state.clubs.map(c =>
        api(`/api/clubs/${c.id}/schedule?week=${weekStart}`).then(data => ({ clubId: c.id, data }))
      ));
      for (const { clubId, data } of results) {
        state.weekData[weekKey][clubId] = data;
      }
    }
  }

  function renderBody() {
    const body = $('#main-body');
    body.innerHTML = '';

    if (!state.clubs.length) {
      body.appendChild(el('div', { class: 'muted' }, 'No clubs yet.'));
      return;
    }

    // Static notice that applies to every schedule
    const notice = el('div', { class: 'shift-notice' });
    notice.appendChild(el('div', { class: 'shift-notice-text' }, NOTICE_TEXT));
    if (isOwner()) {
      notice.appendChild(el('button', {
        class: 'ghost shift-notice-edit',
        onclick: openNoticeModal,
      }, 'Edit'));
    }
    body.appendChild(notice);

    if (isLoggedIn()) {
      // Manager / owner view: tabs flip the whole page between current
      // and next week, one week visible at a time.
      body.appendChild(buildWeekTabs());
      state.clubs.forEach((club, idx) => {
        // Only the first club in the week group shows the week heading,
        // so Jacksonville gets "Current/Next Work Week" and St. Augustine
        // sits right below it without a duplicate label.
        body.appendChild(renderClubSection(club, state.tab, idx === 0));
      });
    } else {
      // Anonymous staff view: no tabs. Every week stacked in order — this
      // week's clubs first, then next week's, then week after next's.
      WEEK_KEYS.forEach(weekKey => {
        state.clubs.forEach((club, idx) => {
          body.appendChild(renderClubSection(club, weekKey, idx === 0));
        });
      });
    }

    // Apply any existing filter after new rows are rendered
    applyNameFilter();
  }

  // Toggle row visibility based on state.filter. Runs against the live DOM
  // (no re-render) so the user keeps focus in the filter box while typing.
  // Operates on every schedule table (Jacksonville, St. Augustine, etc).
  function applyNameFilter() {
    const q = (state.filter || '').trim().toLowerCase();

    // Pass 1: show/hide every employee row across every schedule table.
    document.querySelectorAll('.schedule-table tbody tr').forEach(row => {
      if (row.classList.contains('team-divider')) return;
      if (row.classList.contains('repeat-header')) return;
      const name = (row.dataset.empName || row.getAttribute('data-emp-name') || '').toLowerCase();
      if (!name) return;
      const match = !q || name.includes(q);
      row.style.display = match ? '' : 'none';
    });

    // Pass 2: hide team dividers (and the date header that follows them) if
    // none of the rows in their group are visible.
    document.querySelectorAll('.schedule-table tbody tr.team-divider').forEach(divider => {
      let anyVisible = false;
      let cursor = divider.nextElementSibling;
      while (cursor && !cursor.classList.contains('team-divider')) {
        const isEmp = cursor.dataset.empName || cursor.getAttribute('data-emp-name');
        if (isEmp && cursor.style.display !== 'none') {
          anyVisible = true;
          break;
        }
        cursor = cursor.nextElementSibling;
      }
      divider.style.display = anyVisible ? '' : 'none';
      const next = divider.nextElementSibling;
      if (next && next.classList.contains('repeat-header')) {
        next.style.display = anyVisible ? '' : 'none';
      }
    });
  }

  function renderClubSection(club, weekKey, showWeekHeading) {
    weekKey = weekKey || 'current';
    const data = (state.weekData[weekKey] || {})[club.id];
    const wrap = el('section', { class: 'club-section' });

    // Show the Current/Next Work Week label only above the first club in
    // a week group (Jacksonville). St. Augustine sits right below without a
    // duplicate heading.
    if (showWeekHeading) {
      wrap.appendChild(el('div', { class: 'club-week-heading' },
        WEEK_HEADINGS[weekKey] || 'Current Work Week'));
    }

    const header = el('div', { class: 'club-header' });
    header.appendChild(el('h2', {}, club.name));
    if (canEditClub(club.id) || (isLoggedIn() && state.me.club_id === club.id)) {
      header.appendChild(el('span', { class: 'edit-chip' },
        isOwner() ? 'Owner edit' : `Editing ${state.me.team || ''}`.trim()));
    }

    // Per-club Staff Search input. Both clubs share the same state.filter,
    // so typing in either box filters every employee across both clubs.
    const filterWrap = el('div', { class: 'name-filter-wrap' });
    filterWrap.appendChild(el('label', { class: 'name-filter-label' }, 'Staff Search'));
    const filterInput = el('input', {
      type: 'search',
      class: 'name-filter',
      autocomplete: 'off',
    });
    filterInput.value = state.filter || '';
    filterInput.addEventListener('input', () => {
      state.filter = filterInput.value;
      // Mirror the value into every other staff search input on the page
      document.querySelectorAll('.name-filter').forEach(other => {
        if (other !== filterInput) other.value = state.filter;
      });
      applyNameFilter();
    });
    filterWrap.appendChild(filterInput);
    header.appendChild(filterWrap);

    if (isLoggedIn() && (isOwner() || canEditClub(club.id))) {
      header.appendChild(el('button', { onclick: () => openRosterModal(club) }, 'Manage roster'));
      header.appendChild(el('button', {
        class: 'primary',
        onclick: () => openPublishModal(club, data),
      }, 'Publish changes'));
    }
    wrap.appendChild(header);

    if (!data) {
      wrap.appendChild(el('div', { class: 'muted', style: 'padding:12px;' }, 'No schedule loaded.'));
      return wrap;
    }

    // Recent changes panel — visible to everyone including anonymous staff.
    // Shows the single most recent change inline, with a View more button
    // that expands to reveal the rest on click.
    const updates = data.recent_updates || (data.last_update ? [data.last_update] : []);
    if (updates.length) {
      const panel = el('div', { class: 'recent-updates' });
      panel.appendChild(el('div', { class: 'recent-updates-title muted' },
        `Recent changes (${updates.length})`));

      const listEl = el('div', { class: 'recent-updates-list' });
      const renderRow = (u) => {
        const row = el('div', { class: 'recent-updates-row' + (u.action === 'schedule_published' ? ' recent-publish' : '') });
        row.appendChild(el('span', { class: 'muted' }, fmtRelative(u.created_at)));
        row.appendChild(el('span', { class: 'recent-who' }, u.user_label || 'unknown'));
        row.appendChild(el('span', {}, describeAuditEntry({
          action: u.action,
          details: u.details || {},
          club_name: club.name,
          team: (u.details || {}).team || null,
        })));
        return row;
      };

      listEl.appendChild(renderRow(updates[0]));
      panel.appendChild(listEl);

      if (updates.length > 1) {
        const toggle = el('button', {
          class: 'ghost recent-updates-toggle',
        });
        let expanded = false;
        toggle.textContent = `View more (${updates.length - 1})`;
        toggle.addEventListener('click', () => {
          expanded = !expanded;
          if (expanded) {
            updates.slice(1).forEach(u => listEl.appendChild(renderRow(u)));
            toggle.textContent = 'Hide';
          } else {
            while (listEl.children.length > 1) listEl.removeChild(listEl.lastChild);
            toggle.textContent = `View more (${updates.length - 1})`;
          }
        });
        panel.appendChild(toggle);
      }

      wrap.appendChild(panel);
    }

    // Draft toolbar (Undo / Redo / Save Draft) — only shown under the
    // first club (Jacksonville) so it's not duplicated on the page.
    if (isLoggedIn() && showWeekHeading) {
      const draftBar = el('div', { class: 'draft-toolbar' });
      const count = state.pendingChanges.size;
      draftBar.appendChild(el('span', { class: 'draft-count muted' },
        count ? `${count} unsaved change${count === 1 ? '' : 's'}` : 'No changes'));
      draftBar.appendChild(el('button', {
        class: 'draft-undo', disabled: !state.undoStack.length,
        onclick: undo,
      }, 'Undo'));
      draftBar.appendChild(el('button', {
        class: 'draft-redo', disabled: !state.redoStack.length,
        onclick: redo,
      }, 'Redo'));
      draftBar.appendChild(el('button', {
        class: 'primary draft-save', disabled: !count,
        onclick: saveDraft,
      }, 'Save Draft'));
      wrap.appendChild(draftBar);
    }

    wrap.appendChild(buildScheduleGrid(club, data));
    // Totals are a management-only view. Regular staff visiting without an
    // account just see the schedule and the notes; hide the totals table.
    if (isLoggedIn()) {
      wrap.appendChild(buildTotalsGrid(club, data));
    }

    return wrap;
  }

  function buildScheduleGrid(club, data) {
    const wrap = el('div', { class: 'schedule-wrap' });
    const table = el('table', { class: 'schedule-table' });
    const weekStart = data.schedule.week_start;

    // Helper to build a header row (used both in thead and repeated between
    // team groups so the date columns stay labeled for Jacksonville Beach).
    const buildHeaderRow = (labelText) => {
      const row = el('tr');
      row.appendChild(el('th', {}, labelText || 'Employee'));
      DAYS.forEach((d, i) => {
        const date = new Date(weekStart + 'T00:00:00'); date.setDate(date.getDate() + i);
        row.appendChild(el('th', {}, `${d} ${date.getMonth() + 1}/${date.getDate()}`));
      });
      return row;
    };

    const thead = el('thead');
    thead.appendChild(buildHeaderRow('Employee'));
    table.appendChild(thead);

    const tbody = el('tbody');
    const groups = new Map();
    for (const e of data.employees) {
      // Use the literal team value (including null/empty) so single-group
      // clubs collapse into one unnamed bucket.
      const key = e.team || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }
    const order = ['Julington Creek', 'Jacksonville Beach'];
    const sortedKeys = Array.from(groups.keys()).sort((a, b) => {
      const ai = order.indexOf(a); const bi = order.indexOf(b);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    // Only draw team divider rows when there is more than one group.
    const showDividers = sortedKeys.length > 1;

    sortedKeys.forEach((teamName, idx) => {
      if (showDividers && teamName) {
        const divider = el('tr', { class: 'team-divider' });
        divider.appendChild(el('td', { colspan: 8 }, teamName));
        tbody.appendChild(divider);
        // Between team groups, repeat the date header row so the columns
        // stay labeled when a team (e.g. Jacksonville Beach) starts partway
        // down the table
        if (idx > 0) {
          const repeatHeader = buildHeaderRow('');
          repeatHeader.classList.add('repeat-header');
          tbody.appendChild(repeatHeader);
        }
      }

      for (const emp of groups.get(teamName)) {
        const editable = canEditEmployee(emp);
        const row = el('tr', { class: teamClass(emp.team), 'data-emp-name': emp.name });
        row.dataset.empName = emp.name;
        row.appendChild(el('td', { class: 'name-cell' }, emp.name));
        for (let d = 0; d < 7; d++) {
          const td = el('td', { class: 'day-cell' });
          const key = cellKey(data.schedule.id, emp.id, d);
          const serverVal = (data.shifts[emp.id] && data.shifts[emp.id][d]) || '';
          const pending = state.pendingChanges.get(key);
          const cellVal = pending ? pending.shift_text : serverVal;
          if (editable) {
            const input = el('input', { type: 'text', 'data-cell-key': key });
            input.value = cellVal;
            input.style.color = cellColorFor(cellVal);
            if (pending) input.classList.add('cell-dirty');
            input.addEventListener('input', () => {
              input.style.color = cellColorFor(input.value);
              const prevVal = state.pendingChanges.has(key)
                ? state.pendingChanges.get(key).shift_text : serverVal;
              recordEdit(key,
                { schedule_id: data.schedule.id, employee_id: emp.id, day_index: d },
                prevVal, input.value, serverVal);
              input.classList.toggle('cell-dirty', input.value !== serverVal);
            });
            td.appendChild(input);
          } else {
            const div = el('div', { class: 'day-readonly' }, cellVal || '—');
            div.style.color = cellColorFor(cellVal);
            td.appendChild(div);
          }
          row.appendChild(td);
        }
        tbody.appendChild(row);
      }
    });

    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  function buildTotalsGrid(club, data) {
    const locations = data.locations || [];
    if (!locations.length) return el('div');

    const editable = canEditClub(club.id);
    const weekStart = data.schedule.week_start;
    const wrap = el('div', { class: 'totals-wrap' });
    wrap.appendChild(el('div', { class: 'totals-label' }, 'Staffing by location'));

    const table = el('table', { class: 'totals-table' });
    const thead = el('thead');
    const hrow = el('tr');
    hrow.appendChild(el('th', {}, 'Location'));
    DAYS.forEach((d, i) => {
      const date = new Date(weekStart + 'T00:00:00'); date.setDate(date.getDate() + i);
      hrow.appendChild(el('th', {}, `${d} ${date.getMonth() + 1}/${date.getDate()}`));
    });
    thead.appendChild(hrow);
    table.appendChild(thead);

    const tbody = el('tbody');
    locations.forEach(loc => {
      const tr = el('tr');
      tr.appendChild(el('td', { class: 'totals-loc' }, loc));
      for (let d = 0; d < 7; d++) {
        const td = el('td', { class: 'totals-cell' });
        const tKey = totalKey(data.schedule.id, loc, d);
        const serverVal = (data.totals && data.totals[loc] && data.totals[loc][d]) || '';
        const pending = state.pendingChanges.get(tKey);
        const val = pending ? pending.shift_text : serverVal;
        if (editable) {
          const input = el('input', { type: 'text', inputmode: 'numeric', 'data-cell-key': tKey });
          input.value = val;
          if (pending) input.classList.add('cell-dirty');
          input.addEventListener('input', () => {
            const prevVal = state.pendingChanges.has(tKey)
              ? state.pendingChanges.get(tKey).shift_text : serverVal;
            recordEdit(tKey,
              { schedule_id: data.schedule.id, location: loc, day_index: d },
              prevVal, input.value, serverVal);
            input.classList.toggle('cell-dirty', input.value !== serverVal);
          });
          td.appendChild(input);
        } else {
          td.appendChild(el('div', { class: 'day-readonly' }, val || '—'));
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  // -------- login modal --------
  function openLoginModal() {
    const content = el('div');
    content.appendChild(el('h2', {}, 'Sign in'));
    content.appendChild(el('p', { class: 'muted' }, 'Enter your manager or owner credentials.'));

    const emailIn = el('input', { type: 'email', placeholder: 'email', autocomplete: 'email' });
    const passIn = el('input', { type: 'password', placeholder: 'password', autocomplete: 'current-password' });
    const errDiv = el('div', { class: 'error' });

    const submit = async () => {
      errDiv.textContent = '';
      try {
        const me = await api('/api/login', {
          method: 'POST',
          body: { email: emailIn.value.trim(), password: passIn.value },
        });
        state.me = me;
        closeModal();
        await render();
        toast(`Signed in as ${me.name || me.email}`);
      } catch (e) { errDiv.textContent = e.message; }
    };
    passIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    emailIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') passIn.focus(); });

    content.appendChild(el('label', {}, ['Email', emailIn]));
    content.appendChild(el('label', {}, ['Password', passIn]));
    content.appendChild(errDiv);
    content.appendChild(el('div', { class: 'modal-actions' }, [
      el('button', { onclick: closeModal }, 'Cancel'),
      el('button', { class: 'primary', onclick: submit }, 'Sign in'),
    ]));
    openModal(content);
    setTimeout(() => emailIn.focus(), 50);
  }

  function openChangePasswordModal() {
    const content = el('div');
    content.appendChild(el('h2', {}, 'Change password'));
    content.appendChild(el('p', { class: 'muted' }, state.me.email));
    const curIn = el('input', { type: 'password', placeholder: 'current password' });
    const newIn = el('input', { type: 'password', placeholder: 'new password (min 4)' });
    const errDiv = el('div', { class: 'error' });
    content.appendChild(el('label', {}, ['Current password', curIn]));
    content.appendChild(el('label', {}, ['New password', newIn]));
    content.appendChild(errDiv);
    content.appendChild(el('div', { class: 'modal-actions' }, [
      el('button', { onclick: closeModal }, 'Cancel'),
      el('button', {
        class: 'primary',
        onclick: async () => {
          errDiv.textContent = '';
          try {
            await api('/api/me/password', {
              method: 'POST',
              body: { current_password: curIn.value, new_password: newIn.value },
            });
            closeModal();
            toast('Password updated');
          } catch (e) { errDiv.textContent = e.message; }
        },
      }, 'Update'),
    ]));
    openModal(content);
  }

  function openNoticeModal() {
    const content = el('div');
    content.appendChild(el('h2', {}, 'Edit shift notice'));
    content.appendChild(el('p', { class: 'muted' },
      'This message is shown at the top of the schedule for everyone, including dock staff.'));
    const ta = el('textarea', {});
    ta.style.minHeight = '130px';
    ta.value = NOTICE_TEXT || '';
    const errDiv = el('div', { class: 'error' });
    content.appendChild(el('label', {}, ['Message', ta]));
    content.appendChild(errDiv);
    content.appendChild(el('div', { class: 'modal-actions' }, [
      el('button', { onclick: closeModal }, 'Cancel'),
      el('button', {
        class: 'primary',
        onclick: async () => {
          errDiv.textContent = '';
          try {
            const result = await api('/api/notice', {
              method: 'PUT',
              body: { text: ta.value },
            });
            NOTICE_TEXT = (result && result.text) || ta.value;
            closeModal();
            renderBody();
            toast('Notice updated');
          } catch (e) { errDiv.textContent = e.message; }
        },
      }, 'Save'),
    ]));
    openModal(content);
  }

  // -------- admin panel --------
  let adminTab = 'users';
  async function openAdminPanel() {
    const content = el('div');
    content.appendChild(el('h2', {}, 'Admin'));

    const tabs = el('div', { class: 'tabs', style: 'margin-bottom:14px;' });
    const usersTab = el('button', {
      class: adminTab === 'users' ? 'active' : '',
      onclick: () => { adminTab = 'users'; renderTab(); },
    }, 'Users');
    const activityTab = el('button', {
      class: adminTab === 'activity' ? 'active' : '',
      onclick: () => { adminTab = 'activity'; renderTab(); },
    }, 'Activity');
    tabs.appendChild(usersTab);
    tabs.appendChild(activityTab);
    content.appendChild(tabs);

    const tabBody = el('div');
    content.appendChild(tabBody);

    content.appendChild(el('div', { class: 'modal-actions' }, [
      el('button', { onclick: closeModal }, 'Close'),
    ]));

    function renderTab() {
      usersTab.className = adminTab === 'users' ? 'active' : '';
      activityTab.className = adminTab === 'activity' ? 'active' : '';
      tabBody.innerHTML = '';
      if (adminTab === 'users') renderUsersTab(tabBody);
      else renderActivityTab(tabBody);
    }

    openModal(content, { wide: true });
    renderTab();
  }

  async function renderUsersTab(container) {
    container.appendChild(el('div', { class: 'muted', style: 'margin-bottom:10px;' },
      'Owners can edit everything. Managers can only edit one team.'));

    const list = el('div');
    container.appendChild(list);

    async function refresh() {
      list.innerHTML = '';
      let users;
      try { users = await api('/api/users'); }
      catch (e) { list.appendChild(el('div', { class: 'error' }, e.message)); return; }

      const table = el('table', { class: 'data-table' });
      table.appendChild(el('thead', {}, el('tr', {}, [
        el('th', {}, 'Email'),
        el('th', {}, 'Name'),
        el('th', {}, 'Role'),
        el('th', {}, 'Club'),
        el('th', {}, 'Team'),
        el('th', {}, 'Actions'),
      ])));
      const tbody = el('tbody');
      users.forEach(u => {
        const tr = el('tr');
        tr.appendChild(el('td', {}, u.email));
        tr.appendChild(el('td', {}, u.name || '—'));
        tr.appendChild(el('td', {}, u.role));
        tr.appendChild(el('td', {}, u.club_name || '—'));
        tr.appendChild(el('td', {}, u.team || '—'));
        const actions = el('td');
        actions.appendChild(el('button', {
          onclick: async () => {
            const pw = prompt(`New password for ${u.email}:`);
            if (!pw) return;
            try {
              await api(`/api/users/${u.id}`, { method: 'PATCH', body: { password: pw } });
              toast('Password reset');
            } catch (e) { toast(e.message, 'err'); }
          },
        }, 'Reset password'));
        if (u.id !== state.me.id) {
          actions.appendChild(document.createTextNode(' '));
          actions.appendChild(el('button', {
            class: 'danger',
            onclick: async () => {
              if (!confirm(`Delete ${u.email}?`)) return;
              try {
                await api(`/api/users/${u.id}`, { method: 'DELETE' });
                refresh();
              } catch (e) { toast(e.message, 'err'); }
            },
          }, 'Delete'));
        }
        tr.appendChild(actions);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      list.appendChild(table);
    }

    container.appendChild(el('button', {
      class: 'primary',
      style: 'margin-top:14px;',
      onclick: () => openCreateUserModal(refresh),
    }, '+ Create manager'));

    refresh();
  }

  function openCreateUserModal(onCreated) {
    const content = el('div');
    content.appendChild(el('h2', {}, 'Create manager'));
    const emailIn = el('input', { type: 'email', placeholder: 'manager@example.com' });
    const nameIn = el('input', { type: 'text', placeholder: 'Display name (optional)' });
    const passIn = el('input', { type: 'text', placeholder: 'temporary password' });
    const clubSel = el('select');
    state.clubs.forEach(c => clubSel.appendChild(el('option', { value: c.id }, c.name)));
    const teamSel = el('select');
    const teamLabel = el('label', {}, ['Team', teamSel]);
    function refreshTeams() {
      teamSel.innerHTML = '';
      const club = state.clubs.find(c => c.id === Number(clubSel.value));
      const teams = teamsForClub(club ? club.name : '');
      if (teams.length === 0) {
        teamLabel.style.display = 'none';
      } else {
        teamLabel.style.display = '';
        teams.forEach(t => teamSel.appendChild(el('option', { value: t }, t)));
      }
    }
    clubSel.addEventListener('change', refreshTeams);

    const errDiv = el('div', { class: 'error' });

    content.appendChild(el('label', {}, ['Email', emailIn]));
    content.appendChild(el('label', {}, ['Name', nameIn]));
    content.appendChild(el('label', {}, ['Temporary password', passIn]));
    content.appendChild(el('label', {}, ['Club', clubSel]));
    content.appendChild(teamLabel);
    content.appendChild(errDiv);
    refreshTeams();
    content.appendChild(el('div', { class: 'modal-actions' }, [
      el('button', { onclick: closeModal }, 'Cancel'),
      el('button', {
        class: 'primary',
        onclick: async () => {
          errDiv.textContent = '';
          try {
            const club = state.clubs.find(c => c.id === Number(clubSel.value));
            const teams = teamsForClub(club ? club.name : '');
            await api('/api/users', {
              method: 'POST',
              body: {
                email: emailIn.value.trim(),
                name: nameIn.value.trim(),
                password: passIn.value,
                role: 'manager',
                club_id: Number(clubSel.value),
                team: teams.length ? teamSel.value : null,
              },
            });
            closeModal();
            toast('Manager created');
            if (onCreated) onCreated();
          } catch (e) { errDiv.textContent = e.message; }
        },
      }, 'Create'),
    ]));
    openModal(content);
  }

  async function renderActivityTab(container) {
    container.appendChild(el('div', { class: 'muted', style: 'margin-bottom:10px;' },
      'Showing edits from the last 30 days. Newest first.'));

    const list = el('div', { class: 'activity-list' });
    container.appendChild(list);

    const footer = el('div', { class: 'activity-footer', style: 'margin-top:12px;' });
    container.appendChild(footer);

    const pageSize = 50;
    let offset = 0;

    const appendEntries = (entries) => {
      entries.forEach(e => {
        const row = el('div', { class: 'activity-row' + (e.action === 'schedule_published' ? ' activity-publish' : '') });
        row.appendChild(el('div', { class: 'activity-when' }, fmtRelative(e.created_at)));
        row.appendChild(el('div', { class: 'activity-who muted' }, e.user_label));
        row.appendChild(el('div', { class: 'activity-what' }, describeAuditEntry(e)));
        list.appendChild(row);
      });
    };

    const loadPage = async () => {
      footer.innerHTML = '';
      let result;
      try { result = await api(`/api/audit?limit=${pageSize}&offset=${offset}`); }
      catch (e) { footer.appendChild(el('div', { class: 'error' }, e.message)); return; }

      const entries = Array.isArray(result) ? result : (result.entries || []);
      const total = Array.isArray(result) ? entries.length : (result.total || entries.length);
      if (offset === 0 && !entries.length) {
        list.appendChild(el('div', { class: 'muted' }, 'No activity yet.'));
        return;
      }
      appendEntries(entries);
      offset += entries.length;
      if (offset < total) {
        footer.appendChild(el('button', {
          onclick: loadPage,
        }, `Load older activity (${total - offset} remaining)`));
      } else if (offset > 0) {
        footer.appendChild(el('div', { class: 'muted' }, `End of activity (${offset} total)`));
      }
    };

    loadPage();
  }

  function describeAuditEntry(e) {
    const d = e.details || {};
    const club = e.club_name || d.club_name || '';
    const team = e.team ? ` (${e.team})` : '';
    switch (e.action) {
      case 'cell_edit': {
        const day = DAYS[d.day_index] || `day ${d.day_index}`;
        const week = d.week_start ? ` (week of ${d.week_start})` : '';
        if (!d.new_value && d.old_value) {
          return `removed ${d.employee_name}'s ${day}${week} shift "${d.old_value}"${team}`;
        }
        if (d.new_value && !d.old_value) {
          return `set ${d.employee_name}'s ${day}${week} shift to "${d.new_value}"${team}`;
        }
        return `changed ${d.employee_name}'s ${day}${week} shift: "${d.old_value || ''}" → "${d.new_value || ''}"${team}`;
      }
      case 'notes_edit':
        return `updated ${club} notes for week of ${d.week_start}`;
      case 'total_edit': {
        const day = DAYS[d.day_index] || `day ${d.day_index}`;
        return `set ${d.location} ${day} count to "${d.count_text || '(empty)'}" (week of ${d.week_start})`;
      }
      case 'employee_add':
        return `added ${d.employee_name} to ${club}${team}`;
      case 'employee_update':
        return `updated ${d.employee_name} in ${club}${team}`;
      case 'employee_archive':
        return `archived ${d.employee_name} from ${club}${team}`;
      case 'schedule_published': {
        const msg = d.message ? ` — "${d.message}"` : '';
        return `published the ${club || d.club_name || 'club'}${team} schedule for week of ${d.week_start}${msg}`;
      }
      case 'user_create':
        return `created user ${d.email} (${d.role}${d.team ? ', ' + d.team : ''})`;
      case 'user_update':
        return `updated user #${d.target_user_id}`;
      case 'user_delete':
        return `deleted user #${d.deleted_user_id}`;
      default:
        return e.action;
    }
  }

  // -------- publish modal --------
  function openPublishModal(club, data) {
    const content = el('div');
    content.appendChild(el('h2', {}, `Publish changes — ${club.name}`));
    content.appendChild(el('p', { class: 'muted' },
      `This will notify the owners that your schedule for the week of ${data.schedule.week_start} is ready.`));
    const msgIn = el('textarea', { placeholder: 'Optional note to the owners (e.g. "all shifts confirmed")' });
    msgIn.style.minHeight = '70px';
    const errDiv = el('div', { class: 'error' });
    content.appendChild(el('label', {}, ['Note (optional)', msgIn]));
    content.appendChild(errDiv);
    content.appendChild(el('div', { class: 'modal-actions' }, [
      el('button', { onclick: closeModal }, 'Cancel'),
      el('button', {
        class: 'primary',
        onclick: async () => {
          errDiv.textContent = '';
          try {
            await api(`/api/clubs/${club.id}/publish`, {
              method: 'POST',
              body: { week_start: data.schedule.week_start, message: msgIn.value.trim() },
            });
            closeModal();
            toast('Published — owners will be notified');
            await loadAllSchedules();
            renderBody();
          } catch (e) { errDiv.textContent = e.message; }
        },
      }, 'Publish'),
    ]));
    openModal(content);
  }

  // -------- roster modal --------
  async function openRosterModal(club) {
    const content = el('div');
    content.appendChild(el('h2', {}, `Manage roster — ${club.name}`));

    async function refresh() {
      const emps = await api(`/api/clubs/${club.id}/employees`);
      list.innerHTML = '';
      const table = el('table', { class: 'data-table' });
      table.appendChild(el('thead', {}, el('tr', {}, [
        el('th', {}, 'Name'), el('th', {}, 'Team'), el('th', {}, 'Status'), el('th', {}, 'Actions'),
      ])));
      const tbody = el('tbody');
      emps.forEach(e => {
        const editable = canEditEmployee(e);
        const tr = el('tr');
        const nameInput = el('input', { value: e.name });
        nameInput.disabled = !editable;
        const teamSelect = el('select');
        teamSelect.disabled = !editable;
        const teamOpts = [...teamsForClub(club.name), ''];
        if (e.team && !teamOpts.includes(e.team)) teamOpts.unshift(e.team);
        teamOpts.forEach(opt => {
          const o = el('option', { value: opt }, opt || '(none)');
          if ((e.team || '') === opt) o.setAttribute('selected', 'selected');
          teamSelect.appendChild(o);
        });
        tr.appendChild(el('td', {}, nameInput));
        tr.appendChild(el('td', {}, teamSelect));
        tr.appendChild(el('td', {}, e.archived ? el('span', { class: 'badge' }, 'archived') : el('span', { class: `badge ${teamBadgeClass(e.team)}` }, 'active')));
        const actions = el('td');
        if (editable) {
          actions.appendChild(el('button', {
            onclick: async () => {
              try {
                await api(`/api/employees/${e.id}`, { method: 'PATCH', body: { name: nameInput.value, team: teamSelect.value } });
                toast('Saved');
                refresh();
              } catch (err) { toast(err.message, 'err'); }
            },
          }, 'Save'));
          actions.appendChild(document.createTextNode(' '));
          actions.appendChild(el('button', {
            class: 'ghost',
            onclick: async () => {
              try {
                if (e.archived) {
                  await api(`/api/employees/${e.id}`, { method: 'PATCH', body: { archived: false } });
                } else {
                  await api(`/api/employees/${e.id}`, { method: 'DELETE' });
                }
                refresh();
              } catch (err) { toast(err.message, 'err'); }
            },
          }, e.archived ? 'Unarchive' : 'Archive'));
        } else {
          actions.appendChild(el('span', { class: 'muted' }, '(not your team)'));
        }
        tr.appendChild(actions);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      list.appendChild(table);
    }

    const list = el('div');
    content.appendChild(list);

    // Add new — only show teams the user can edit
    const editableTeams = teamsForClub(club.name).filter(t => canEditTeam(club.id, t));
    if (editableTeams.length) {
      const addWrap = el('div', { class: 'toolbar', style: 'margin-top:14px;' });
      const nameIn = el('input', { placeholder: 'New employee name' });
      const teamIn = el('select');
      editableTeams.forEach(t => teamIn.appendChild(el('option', { value: t }, t)));
      addWrap.appendChild(nameIn);
      addWrap.appendChild(teamIn);
      addWrap.appendChild(el('button', {
        class: 'primary',
        onclick: async () => {
          if (!nameIn.value.trim()) return;
          try {
            await api(`/api/clubs/${club.id}/employees`, { method: 'POST', body: { name: nameIn.value.trim(), team: teamIn.value } });
            nameIn.value = '';
            refresh();
          } catch (err) { toast(err.message, 'err'); }
        },
      }, 'Add'));
      content.appendChild(addWrap);
    }

    content.appendChild(el('div', { class: 'modal-actions' }, [
      el('button', {
        onclick: async () => { closeModal(); await loadAllSchedules(); renderBody(); },
      }, 'Close'),
    ]));

    openModal(content, { wide: true });
    refresh();
  }

  document.addEventListener('DOMContentLoaded', bootstrap);
})();
