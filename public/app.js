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
    staffClubId: null,  // anonymous staff: which club they selected to view
    adminClubId: null,  // owner: which club to view (null = all)
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
      else if (v === false) n.removeAttribute(k); // boolean false = don't set
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
  const _viewParam = new URLSearchParams(window.location.search).get('view');
  const STAFF_VIEW_MODE = _viewParam === 'staff';
  const MANAGER_VIEW_MODE = _viewParam === 'manager';
  function isLoggedIn() {
    if (STAFF_VIEW_MODE) return false;
    return state.me && state.me.id != null;
  }
  function isOwner() {
    if (MANAGER_VIEW_MODE) return false; // force manager view
    return state.me && (state.me.role === 'owner' || state.me.role === 'admin');
  }
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

  // ids must include club_id so undo/redo/save scope per-club
  function recordEdit(key, ids, oldVal, newVal, serverVal) {
    state.undoStack.push({ key, ...ids, old_value: oldVal, new_value: newVal, server_value: serverVal });
    state.redoStack = state.redoStack.filter(e => Number(e.club_id) !== Number(ids.club_id));
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
        club_id: entry.club_id,
        shift_text: valueToSet,
        server_value: entry.server_value,
      });
    }
    updateDraftToolbar();
  }

  function undoForClub(clubId) {
    const cid = Number(clubId);
    for (let i = state.undoStack.length - 1; i >= 0; i--) {
      if (Number(state.undoStack[i].club_id) === cid) {
        const entry = state.undoStack.splice(i, 1)[0];
        state.redoStack.push(entry);
        applyUndoRedo(entry, entry.old_value);
        return;
      }
    }
  }

  function redoForClub(clubId) {
    const cid = Number(clubId);
    for (let i = state.redoStack.length - 1; i >= 0; i--) {
      if (Number(state.redoStack[i].club_id) === cid) {
        const entry = state.redoStack.splice(i, 1)[0];
        state.undoStack.push(entry);
        applyUndoRedo(entry, entry.new_value);
        return;
      }
    }
  }

  function countForClub(clubId) {
    const cid = Number(clubId);
    let n = 0;
    state.pendingChanges.forEach(v => { if (Number(v.club_id) === cid) n++; });
    return n;
  }
  function undoCountForClub(clubId) {
    const cid = Number(clubId);
    return state.undoStack.filter(e => Number(e.club_id) === cid).length;
  }
  function redoCountForClub(clubId) {
    const cid = Number(clubId);
    return state.redoStack.filter(e => Number(e.club_id) === cid).length;
  }

  async function saveDraftForClub(clubId) {
    const cid = Number(clubId);
    const changes = [];
    state.pendingChanges.forEach((v, k) => {
      if (Number(v.club_id) === cid) changes.push({ key: k, ...v });
    });
    if (!changes.length) {
      // Debug: show what's in the pending map
      const total = state.pendingChanges.size;
      if (total) {
        const clubIds = new Set();
        state.pendingChanges.forEach(v => clubIds.add(v.club_id));
        toast(`No changes for club ${cid}. ${total} total pending for clubs: ${[...clubIds].join(', ')}`, 'err');
      }
      return;
    }
    changes.forEach(c => state.pendingChanges.delete(c.key));
    state.undoStack = state.undoStack.filter(e => Number(e.club_id) !== cid);
    state.redoStack = state.redoStack.filter(e => Number(e.club_id) !== cid);

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
    if (ok) {
      toast(`Saved ${ok} change${ok === 1 ? '' : 's'}`);
      if (!isOwner()) {
        // Remind managers to send for review after saving
        setTimeout(() => toast('Don\'t forget to Send for Review when you\'re done'), 1500);
      }
    }
    if (failed) toast(`${failed} change${failed === 1 ? '' : 's'} failed`, 'err');
    updateDraftToolbar();
    // Reload data so server state matches what we just saved
    await loadAllSchedules();
    renderBody();
  }

  function updateDraftToolbar() {
    document.querySelectorAll('.draft-toolbar').forEach(bar => {
      const clubId = Number(bar.getAttribute('data-club-id'));
      const count = countForClub(clubId);
      const badge = bar.querySelector('.review-badge');
      const saveBtn = bar.querySelector('.draft-save');
      const undoBtn = bar.querySelector('.draft-undo');
      const redoBtn = bar.querySelector('.draft-redo');
      if (badge && count) {
        badge.textContent = `${count} unsaved change${count === 1 ? '' : 's'}`;
        badge.className = 'review-badge draft';
      }
      if (saveBtn) saveBtn.disabled = !count;
      if (undoBtn) undoBtn.disabled = !undoCountForClub(clubId);
      if (redoBtn) redoBtn.disabled = !redoCountForClub(clubId);
    });
  }

  // Keyboard shortcuts: Ctrl+Z = undo, Ctrl+Shift+Z / Ctrl+Y = redo, Ctrl+S = save
  document.addEventListener('keydown', (e) => {
    if (!isLoggedIn()) return;
    const mod = e.ctrlKey || e.metaKey;
    // Find the club_id of the focused cell (if any) for per-club undo/redo
    const focusedBar = document.activeElement?.closest('.club-section')?.querySelector('.draft-toolbar');
    const focusedClubId = focusedBar ? Number(focusedBar.getAttribute('data-club-id')) : null;
    // Fall back to the first visible club
    const firstBar = document.querySelector('.draft-toolbar');
    const clubId = focusedClubId || (firstBar ? Number(firstBar.getAttribute('data-club-id')) : null);
    if (!clubId) return;
    if (mod && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undoForClub(clubId); }
    else if (mod && (e.key === 'Z' || e.key === 'y')) { e.preventDefault(); redoForClub(clubId); }
    else if (mod && e.key === 's') { e.preventDefault(); saveDraftForClub(clubId); }
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
      `${unseen.length} schedule${unseen.length === 1 ? '' : 's'} sent for review`));
    const list = el('div', { class: 'publish-banner-list' });
    unseen.slice(0, 5).forEach(e => {
      const d = e.details || {};
      const team = d.team ? ` (${d.team})` : '';
      const msg = d.message ? ` — "${d.message}"` : '';
      const line = `${fmtRelative(e.created_at)} — ${e.user_label} sent ${e.club_name || ''}${team} for review — week of ${d.week_start}${msg}`;
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
      const role = isOwner() ? 'Owner' : 'Manager';
      chip.appendChild(el('span', { class: 'muted topbar-label' }, `${label} · ${role}`));

      // Club picker (owners only)
      if (isOwner()) {
        chip.appendChild(el('span', { class: 'muted' }, 'Viewing:'));
        chip.appendChild(el('button', {
          class: 'ghost topbar-btn' + (!state.adminClubId ? ' active' : ''),
          onclick: () => { state.adminClubId = null; renderBody(); },
        }, 'All'));
        state.clubs.forEach(c => {
          chip.appendChild(el('button', {
            class: 'ghost topbar-btn' + (state.adminClubId === c.id ? ' active' : ''),
            onclick: () => { state.adminClubId = c.id; renderBody(); },
          }, c.name));
        });
      }

      // Staff Search
      const filterInput = el('input', {
        type: 'search',
        class: 'name-filter topbar-filter',
        placeholder: 'Staff Search',
        autocomplete: 'off',
      });
      filterInput.value = state.filter || '';
      filterInput.addEventListener('input', () => {
        state.filter = filterInput.value;
        document.querySelectorAll('.name-filter').forEach(other => {
          if (other !== filterInput) other.value = state.filter;
        });
        applyNameFilter();
      });
      chip.appendChild(filterInput);

      // View Live Schedule
      chip.appendChild(el('a', {
        href: '?view=staff',
        target: '_blank',
        class: 'ghost topbar-btn',
        style: 'text-decoration:none;',
      }, 'Live Schedule'));

      // View as Manager (owners only)
      if (isOwner()) {
        chip.appendChild(el('a', {
          href: '?view=manager',
          target: '_blank',
          class: 'ghost topbar-btn',
          style: 'text-decoration:none;',
        }, 'View as Manager'));
      }

      if (isOwner()) {
        chip.appendChild(el('button', { class: 'ghost topbar-btn', onclick: openAdminPanel }, 'Admin'));
      }
      chip.appendChild(el('button', { class: 'ghost topbar-btn', onclick: openChangePasswordModal }, 'Account'));
      chip.appendChild(el('button', {
        class: 'ghost topbar-btn',
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
    // Staff see current + next only; managers/owners load only the active tab
    const weeksToLoad = isLoggedIn() ? [state.tab] : ['current', 'next'];
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

    // Static notice — only for anonymous staff and owners (managers skip it)
    if (!isLoggedIn() || isOwner()) {
      const notice = el('div', { class: 'shift-notice' });
      notice.appendChild(el('div', { class: 'shift-notice-text' }, NOTICE_TEXT));
      if (isOwner()) {
        notice.appendChild(el('button', {
          class: 'ghost shift-notice-edit',
          onclick: openNoticeModal,
        }, 'Edit'));
      }
      body.appendChild(notice);
    }

    if (isLoggedIn()) {
      // Club picker + staff search + manage roster + live schedule all
      // moved to the topbar. Just render the schedule sections here.
      let visibleClubs;
      if (!isOwner() && state.me.club_id) {
        visibleClubs = state.clubs.filter(c => Number(c.id) === Number(state.me.club_id));
      } else if (isOwner() && state.adminClubId) {
        visibleClubs = state.clubs.filter(c => Number(c.id) === Number(state.adminClubId));
      } else {
        visibleClubs = state.clubs;
      }

      visibleClubs.forEach((club, idx) => {
        body.appendChild(renderClubSection(club, state.tab, idx === 0));
      });
    } else {
      // Anonymous staff view: pick a location first, then show that club only.
      if (!state.staffClubId) {
        // Location picker
        const picker = el('div', { class: 'location-picker' });
        picker.appendChild(el('h2', {}, 'Select your location'));
        const btnWrap = el('div', { class: 'location-picker-buttons' });
        state.clubs.forEach(c => {
          btnWrap.appendChild(el('button', {
            class: 'primary location-picker-btn',
            onclick: async () => {
              state.staffClubId = c.id;
              await loadAllSchedules();
              renderBody();
            },
          }, c.name));
        });
        picker.appendChild(btnWrap);
        body.appendChild(picker);
        return;
      }

      // Show selected club only, with a switch button
      const selectedClub = state.clubs.find(c => c.id === state.staffClubId);
      if (selectedClub) {
        const switchBar = el('div', { class: 'location-switch' });
        switchBar.appendChild(el('span', { class: 'muted' }, `Viewing: ${selectedClub.name}`));
        switchBar.appendChild(el('button', {
          class: 'ghost',
          onclick: () => { state.staffClubId = null; renderBody(); },
        }, 'Switch location'));
        body.appendChild(switchBar);

        // Club header + staff search shown ONCE
        body.appendChild(renderStaffHeader(selectedClub));

        // Staff only see current + next week (not week after next)
        const STAFF_WEEKS = ['current', 'next'];
        STAFF_WEEKS.forEach(weekKey => {
          const data = (state.weekData[weekKey] || {})[selectedClub.id];
          if (!data) return;
          const section = el('div', { class: 'staff-week-section' });
          const heading = el('div', { class: 'club-week-heading' });
          heading.appendChild(el('span', {}, WEEK_HEADINGS[weekKey] || 'Current Work Week'));
          if (data.recent_updates && data.recent_updates.length) {
            heading.appendChild(el('button', {
              class: 'ghost',
              style: 'font-size:12px;',
              onclick: () => openWeekActivityModal(selectedClub, data),
            }, 'View Recent Changes'));
          }
          section.appendChild(heading);
          section.appendChild(buildScheduleGrid(selectedClub, data));
          body.appendChild(section);
        });
      }
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

    const header = el('div', { class: 'club-header' });
    header.appendChild(el('h2', {}, club.name));

    if (isLoggedIn() && data) {
      header.appendChild(el('button', {
        class: 'ghost',
        onclick: () => { window.location.href = `/api/export/pdf?week=${data.schedule.week_start}`; },
      }, 'PDF'));
    }

    wrap.appendChild(header);

    if (!data) {
      wrap.appendChild(el('div', { class: 'muted', style: 'padding:12px;' }, 'No schedule loaded.'));
      return wrap;
    }



    // Draft toolbar (Undo / Redo / Save Draft) — shown under every club
    // so the user doesn't have to scroll back up to save.
    if (isLoggedIn()) {
      const draftBar = el('div', { class: 'draft-toolbar', 'data-club-id': club.id });
      const clubCount = countForClub(club.id);
      const clubUndo = undoCountForClub(club.id);
      const clubRedo = redoCountForClub(club.id);
      const rs = data ? (data.review_status || 'draft') : 'draft';

      let statusText, statusClass;
      if (clubCount) {
        statusText = `${clubCount} unsaved change${clubCount === 1 ? '' : 's'}`;
        statusClass = 'review-badge draft';
      } else if (rs === 'approved') {
        statusText = isOwner() ? 'Approved' : 'Approved';
        statusClass = 'review-badge sent';
      } else if (rs === 'submitted') {
        statusText = isOwner() ? 'Changes awaiting your approval' : 'Sent for review — awaiting approval';
        statusClass = 'review-badge pending';
      } else if (rs === 'changes_pending') {
        statusText = isOwner() ? 'New changes since last approval' : 'Changes since last approval — send for review';
        statusClass = 'review-badge pending';
      } else {
        statusText = isOwner() ? 'Draft — not yet submitted' : 'Draft — not yet sent for review';
        statusClass = 'review-badge draft';
      }
      draftBar.appendChild(el('span', { class: statusClass }, statusText));
      draftBar.appendChild(el('button', {
        class: 'draft-undo', disabled: !clubUndo,
        onclick: () => undoForClub(club.id),
      }, 'Undo'));
      draftBar.appendChild(el('button', {
        class: 'draft-redo', disabled: !clubRedo,
        onclick: () => redoForClub(club.id),
      }, 'Redo'));
      draftBar.appendChild(el('button', {
        class: 'primary draft-save', disabled: !clubCount,
        onclick: () => saveDraftForClub(club.id),
      }, 'Save Draft'));

      // Add/Remove Staff — pushed to far right
      draftBar.appendChild(el('div', { class: 'spacer' }));
      draftBar.appendChild(el('button', {
        class: 'ghost',
        onclick: () => openRosterModal(club),
      }, 'Add/Remove Staff'));

      // Publish (owner) / Send for Review (manager)
      // Green = first time sending. Orange = resend (changes after previous send).
      // Disabled/faded while unsaved changes exist.
      const firstSend = !clubCount && rs === 'draft';
      const resend = !clubCount && rs === 'changes_pending';
      const alreadySent = !clubCount && (rs === 'submitted' || rs === 'approved');
      let btnClass = 'primary';
      if (firstSend) btnClass = 'btn-review-ready';        // green
      else if (resend) btnClass = 'btn-review-resend';      // orange
      if (isOwner()) {
        let ownerClass = 'primary';
        if (firstSend || resend) ownerClass = 'btn-approve-ready';
        draftBar.appendChild(el('button', {
          class: ownerClass,
          disabled: clubCount > 0,
          onclick: async () => {
            try {
              await api(`/api/clubs/${club.id}/approve`, {
                method: 'POST',
                body: { week_start: data.schedule.week_start },
              });
              toast('Published');
              await loadAllSchedules();
              renderBody();
            } catch (e) { toast(e.message, 'err'); }
          },
        }, 'Publish'));
      } else {
        let label = 'Send for Review';
        if (resend) label = 'Resend for Review';
        if (alreadySent) label = 'Sent for Review ✓';
        draftBar.appendChild(el('button', {
          class: btnClass,
          disabled: clubCount > 0,
          onclick: () => openPublishModal(club, data),
        }, label));
      }

      wrap.appendChild(draftBar);
    }

    // Week heading with inline tabs (signed-in) or plain label (staff)
    const weekHeading = el('div', { class: 'club-week-heading' });
    weekHeading.appendChild(el('span', {},
      WEEK_HEADINGS[weekKey] || 'Current Work Week'));
    if (isLoggedIn()) {
      WEEK_KEYS.forEach(key => {
        weekHeading.appendChild(el('button', {
          class: 'week-tab-inline' + (state.tab === key ? ' active' : ''),
          onclick: () => switchTab(key),
        }, WEEK_LABELS[key]));
      });
      // Recent activity button — shows activity for this specific week
      if (data && data.recent_updates && data.recent_updates.length) {
        weekHeading.appendChild(el('button', {
          class: 'ghost',
          style: 'font-size:12px;',
          onclick: () => openWeekActivityModal(club, data),
        }, `Activity (${data.recent_updates.length})`));
      }
    }
    wrap.appendChild(weekHeading);

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

    // Build maps of cells edited since the last review.
    // pendingReviewCells: Set for quick lookup
    // pendingReviewInfo: Map with old_value/new_value for strikethrough on removals
    const pendingReviewCells = new Set();
    const pendingReviewInfo = new Map();
    if (data.pending_cells) {
      data.pending_cells.forEach(c => {
        const key = `${c.employee_id}:${c.day_index}`;
        pendingReviewCells.add(key);
        pendingReviewInfo.set(key, { old_value: c.old_value || '', new_value: c.new_value || '' });
      });
    }

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
    const tbody = el('tbody');
    const groups = new Map();
    for (const e of data.employees) {
      const key = e.team || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }
    const order = ['Julington Creek', 'Jacksonville Beach'];
    const sortedKeys = Array.from(groups.keys()).sort((a, b) => {
      const ai = order.indexOf(a); const bi = order.indexOf(b);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    const showDividers = sortedKeys.length > 1;

    // First team's divider goes in thead ABOVE the date row
    if (showDividers && sortedKeys[0]) {
      const divider = el('tr', { class: 'team-divider' });
      divider.appendChild(el('th', { colspan: 8 }, sortedKeys[0]));
      thead.appendChild(divider);
    }
    thead.appendChild(buildHeaderRow('Employee'));
    table.appendChild(thead);

    sortedKeys.forEach((teamName, idx) => {
      // Second+ teams get a divider + repeated date header in tbody
      if (showDividers && teamName && idx > 0) {
        const divider = el('tr', { class: 'team-divider' });
        divider.appendChild(el('td', { colspan: 8 }, teamName));
        tbody.appendChild(divider);
        const repeatHeader = buildHeaderRow('');
        repeatHeader.classList.add('repeat-header');
        tbody.appendChild(repeatHeader);
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
            // Amber if locally edited OR edited since last review
            const isPendingReview = pendingReviewCells.has(`${emp.id}:${d}`);
            if (pending || isPendingReview) input.classList.add('cell-dirty');
            input.addEventListener('input', () => {
              input.style.color = cellColorFor(input.value);
              const prevVal = state.pendingChanges.has(key)
                ? state.pendingChanges.get(key).shift_text : serverVal;
              recordEdit(key,
                { schedule_id: data.schedule.id, employee_id: emp.id, day_index: d, club_id: club.id },
                prevVal, input.value, serverVal);
              input.classList.toggle('cell-dirty',
                input.value !== serverVal || isPendingReview);
            });
            td.appendChild(input);
            // If a shift was removed (old had text, current is empty), show
            // strikethrough of the old value so owners can see what was deleted.
            // Only visible to signed-in users, not staff.
            if (isPendingReview && !cellVal) {
              const info = pendingReviewInfo.get(`${emp.id}:${d}`);
              if (info && info.old_value) {
                const strike = el('div', { class: 'cell-removed' }, info.old_value);
                td.appendChild(strike);
              }
            }
            // Owner-only: small approve button on amber cells.
            // When approved, the strikethrough (removed shift) disappears.
            if (isOwner() && isPendingReview) {
              const approveBtn = el('button', {
                class: 'cell-approve-btn',
                title: 'Approve this shift',
                onclick: async (e) => {
                  e.stopPropagation();
                  try {
                    await api(`/api/schedules/${data.schedule.id}/approve-cell`, {
                      method: 'POST',
                      body: { employee_id: emp.id, day_index: d },
                    });
                    input.classList.remove('cell-dirty');
                    const strike = td.querySelector('.cell-removed');
                    if (strike) strike.remove();
                    approveBtn.remove();
                  } catch (err) { toast(err.message, 'err'); }
                },
              }, '\u2713');
              td.appendChild(approveBtn);
            }
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

    const pendingReviewTotals = new Set();
    if (data.pending_totals) {
      data.pending_totals.forEach(t => pendingReviewTotals.add(`${t.location}:${t.day_index}`));
    }

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
          const isTotalPending = pendingReviewTotals.has(`${loc}:${d}`);
          if (pending || isTotalPending) input.classList.add('cell-dirty');
          input.addEventListener('input', () => {
            const prevVal = state.pendingChanges.has(tKey)
              ? state.pendingChanges.get(tKey).shift_text : serverVal;
            recordEdit(tKey,
              { schedule_id: data.schedule.id, location: loc, day_index: d, club_id: club.id },
              prevVal, input.value, serverVal);
            input.classList.toggle('cell-dirty',
              input.value !== serverVal || isTotalPending);
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
      el('button', {
        class: 'ghost',
        onclick: () => { window.location.href = '/api/export/backup'; },
      }, 'Download full backup (JSON)'),
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
          onclick: () => openEditUserModal(u, refresh),
        }, 'Edit'));
        actions.appendChild(document.createTextNode(' '));
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

  function openEditUserModal(u, onSaved) {
    const content = el('div');
    content.appendChild(el('h2', {}, `Edit user — ${u.email}`));
    const nameIn = el('input', { type: 'text', value: u.name || '' });
    const emailIn = el('input', { type: 'email', value: u.email });
    const roleSel = el('select');
    ['manager', 'owner'].forEach(r => {
      const opt = el('option', { value: r }, r);
      if (r === u.role) opt.setAttribute('selected', 'selected');
      roleSel.appendChild(opt);
    });
    const clubSel = el('select');
    state.clubs.forEach(c => {
      const opt = el('option', { value: c.id }, c.name);
      if (Number(c.id) === Number(u.club_id)) opt.setAttribute('selected', 'selected');
      clubSel.appendChild(opt);
    });
    const teamSel = el('select');
    const clubLabel = el('label', {}, ['Club', clubSel]);
    const teamLabel = el('label', {}, ['Team', teamSel]);
    function refreshTeams() {
      teamSel.innerHTML = '';
      const club = state.clubs.find(c => c.id === Number(clubSel.value));
      const teams = teamsForClub(club ? club.name : '');
      if (teams.length === 0) {
        teamLabel.style.display = 'none';
      } else {
        teamLabel.style.display = '';
        teams.forEach(t => {
          const opt = el('option', { value: t }, t);
          if (t === u.team) opt.setAttribute('selected', 'selected');
          teamSel.appendChild(opt);
        });
      }
    }
    clubSel.addEventListener('change', refreshTeams);
    function updateClubFields() {
      const show = roleSel.value === 'manager';
      clubLabel.style.display = show ? '' : 'none';
      teamLabel.style.display = show ? '' : 'none';
      if (show) refreshTeams();
    }
    roleSel.addEventListener('change', updateClubFields);

    const errDiv = el('div', { class: 'error' });
    content.appendChild(el('label', {}, ['Name', nameIn]));
    content.appendChild(el('label', {}, ['Email', emailIn]));
    content.appendChild(el('label', {}, ['Role', roleSel]));
    content.appendChild(clubLabel);
    content.appendChild(teamLabel);
    content.appendChild(errDiv);
    updateClubFields();

    content.appendChild(el('div', { class: 'modal-actions' }, [
      el('button', { onclick: closeModal }, 'Cancel'),
      el('button', {
        class: 'primary',
        onclick: async () => {
          errDiv.textContent = '';
          try {
            const club = state.clubs.find(c => c.id === Number(clubSel.value));
            const teams = teamsForClub(club ? club.name : '');
            const body = {
              name: nameIn.value.trim(),
              email: emailIn.value.trim(),
              role: roleSel.value,
            };
            if (roleSel.value === 'manager') {
              body.club_id = Number(clubSel.value);
              body.team = teams.length ? teamSel.value : null;
            } else {
              body.club_id = null;
              body.team = null;
            }
            await api(`/api/users/${u.id}`, { method: 'PATCH', body });
            closeModal();
            toast('User updated');
            if (onSaved) onSaved();
          } catch (e) { errDiv.textContent = e.message; }
        },
      }, 'Save'),
    ]));
    openModal(content);
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
        const row = el('div', { class: 'activity-row' + (e.action === 'schedule_published' || e.action === 'schedule_submitted' ? ' activity-publish' : '') });
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
      case 'schedule_submitted': {
        const msg = d.message ? ` — "${d.message}"` : '';
        return `sent ${club || d.club_name || 'club'}${team} schedule for review — week of ${d.week_start}${msg}`;
      }
      case 'schedule_published': {
        return `approved ${club || d.club_name || 'club'}${team} schedule — week of ${d.week_start}`;
      }
      case 'time_off_applied':
        return `applied time-off for ${d.employee_name} (${(d.dates || []).join(', ')}) from Slack`;
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

  // Renders a single club header for the staff view — shown once above
  // all the stacked week grids instead of repeating per-week.
  function renderStaffHeader(club) {
    const wrap = el('div', { class: 'staff-header-section' });

    const header = el('div', { class: 'club-header' });
    header.appendChild(el('h2', {}, club.name));

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
      document.querySelectorAll('.name-filter').forEach(other => {
        if (other !== filterInput) other.value = state.filter;
      });
      applyNameFilter();
    });
    filterWrap.appendChild(filterInput);
    header.appendChild(filterWrap);
    wrap.appendChild(header);

    return wrap;
  }

  // -------- week activity modal --------
  function openWeekActivityModal(club, data) {
    const updates = data.recent_updates || [];
    const content = el('div');
    content.appendChild(el('h2', {}, `Activity — ${club.name} — week of ${data.schedule.week_start}`));

    if (!updates.length) {
      content.appendChild(el('div', { class: 'muted' }, 'No activity for this week.'));
    } else {
      const list = el('div', { class: 'activity-list' });
      updates.forEach(u => {
        const row = el('div', { class: 'activity-row' + (u.action === 'schedule_published' || u.action === 'schedule_submitted' ? ' activity-publish' : '') });
        row.appendChild(el('div', { class: 'activity-when' }, fmtRelative(u.created_at)));
        row.appendChild(el('div', { class: 'activity-who muted' }, u.user_label || 'unknown'));
        row.appendChild(el('div', { class: 'activity-what' }, describeAuditEntry({
          action: u.action,
          details: u.details || {},
          club_name: club.name,
          team: (u.details || {}).team || null,
        })));
        list.appendChild(row);
      });
      content.appendChild(list);
    }

    content.appendChild(el('div', { class: 'modal-actions' }, [
      el('button', { onclick: closeModal }, 'Close'),
    ]));
    openModal(content, { wide: true });
  }

  // -------- publish modal --------
  function openPublishModal(club, data) {
    const content = el('div');
    content.appendChild(el('h2', {}, `Send for Review — ${club.name}`));
    content.appendChild(el('p', { class: 'muted' },
      `This will notify the owners that your schedule for the week of ${data.schedule.week_start} is ready for review.`));
    const msgIn = el('textarea', { placeholder: 'Optional note (e.g. "all shifts confirmed")' });
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
            toast('Sent for review');
            await loadAllSchedules();
            renderBody();
          } catch (e) { errDiv.textContent = e.message; }
        },
      }, 'Send'),
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
