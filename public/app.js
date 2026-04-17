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
    weekOffset: 0,      // 0 = normal view, -1 = one week back, -2 = two weeks back, etc.
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
    scheduleImages: {},  // { 'YYYY-MM-DD': { week_start, original_name, created_at } }
  };

  // -------- mobile detection --------
  // Use physical screen width, not layout viewport width. The virtual
  // viewport is 1100px on phones so matchMedia('max-width:768px') is
  // always false. screen.width gives the actual device width.
  function isMobileDevice() {
    return (window.screen && window.screen.width < 900) || 'ontouchstart' in window;
  }

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

  // Use local date math (not UTC) to avoid timezone shifts
  function localDateStr(d) {
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function mondayOf(d) {
    const date = new Date(d);
    const day = date.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    date.setDate(date.getDate() + diff);
    return localDateStr(date);
  }

  function addDays(dateStr, n) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return localDateStr(d);
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

  // Quick-pick shift options per club. "Req Off" and "Clear" are always added.
  function shiftOptionsForClub(clubName) {
    if (clubName === 'Jacksonville') return ['East', 'West', 'Beach'];
    if (clubName === 'St. Augustine') return ['Camachee', 'Shipyard'];
    return [];
  }

  // Map shift text keywords to totals location names.
  // Used for auto-counting staffing totals from shift entries.
  const SHIFT_TO_LOCATION = {
    'beach':    'Jacksonville Beach',
    'east':     'Creek East',
    'west':     'Creek West',
    'camachee': 'Camachee Cove',
    'shipyard': 'Shipyard',
  };

  function locationFromShiftText(text) {
    if (!text) return null;
    const lower = text.toLowerCase();
    if (lower.includes('req off')) return null;
    for (const [keyword, loc] of Object.entries(SHIFT_TO_LOCATION)) {
      if (lower.includes(keyword)) return loc;
    }
    return null;
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
  function canEditEmployee(/* employee */) { return isLoggedIn() && !isPastView(); }
  function canEditTeam(/* clubId, team */) { return isLoggedIn() && !isPastView(); }
  function canEditClub(/* clubId */) { return isLoggedIn() && !isPastView(); }

  // -------- draft / undo / redo --------
  function cellKey(scheduleId, empId, dayIndex) {
    return `${scheduleId}:${empId}:${dayIndex}`;
  }
  function totalKey(scheduleId, loc, dayIndex) {
    return `T:${scheduleId}:${loc}:${dayIndex}`;
  }

  // ids must include club_id so undo/redo/save scope per-club
  let lastCurrentWeekAlert = 0; // timestamp of last alert

  function recordEdit(key, ids, oldVal, newVal, serverVal) {
    // If the value is being set back to the server value, it's not really a change
    const isRealChange = newVal !== serverVal;

    // Alert when editing the current week schedule (not future weeks).
    // Only fire for real changes — clearing a cell back to its original
    // value shouldn't trigger the alert.
    if (isRealChange && state.tab === 'current' && (state.weekOffset || 0) === 0) {
      const now = Date.now();
      if (now - lastCurrentWeekAlert > 5 * 60 * 1000) { // 5 minutes
        lastCurrentWeekAlert = now;
        alert('You are making changes to the current week\u2019s schedule. Staff may already be working from this schedule.');
      }
    }

    state.undoStack.push({ key, ...ids, old_value: oldVal, new_value: newVal, server_value: serverVal });
    state.redoStack = state.redoStack.filter(e => Number(e.club_id) !== Number(ids.club_id));
    if (!isRealChange) {
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
      const rs = bar.getAttribute('data-review-status') || 'draft';
      const count = countForClub(clubId);
      const badge = bar.querySelector('.review-badge');
      const saveBtn = bar.querySelector('.draft-save');
      const undoBtn = bar.querySelector('.draft-undo');
      const redoBtn = bar.querySelector('.draft-redo');
      if (badge) {
        if (count) {
          badge.textContent = `${count} unsaved change${count === 1 ? '' : 's'}`;
          badge.className = 'review-badge draft';
        } else {
          // Restore the original review-status-based text
          let text, cls;
          if (rs === 'approved') {
            text = 'Approved'; cls = 'review-badge sent';
          } else if (rs === 'submitted') {
            text = isOwner() ? 'Changes awaiting your approval' : 'Sent for review — awaiting approval';
            cls = 'review-badge pending';
          } else if (rs === 'changes_pending') {
            text = isOwner() ? 'New changes since last approval' : 'Changes since last approval — send for review';
            cls = 'review-badge pending';
          } else {
            text = isOwner() ? 'Draft — not yet submitted' : 'Draft — not yet sent for review';
            cls = 'review-badge draft';
          }
          badge.textContent = text;
          badge.className = cls;
        }
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
    const offset = (state.weekOffset || 0) * 7;
    if (tab === 'week3') return addDays(thisWeek, 14 + offset);
    if (tab === 'next') return addDays(thisWeek, 7 + offset);
    return addDays(thisWeek, offset);
  }

  function isPastView() {
    return (state.weekOffset || 0) < 0;
  }

  async function bootstrap() {
    if (isMobileDevice()) document.body.classList.add('is-mobile');
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

  async function navigateWeek(direction) {
    state.weekOffset = (state.weekOffset || 0) + direction;
    state.weekStart = weekForTab(state.tab);
    await loadAllSchedules();
    renderBody();
  }

  async function jumpToCurrentWeek() {
    state.weekOffset = 0;
    state.tab = 'current';
    state.weekStart = weekForTab('current');
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

      // Club picker (owners only)
      if (isOwner()) {
        chip.appendChild(el('span', { class: 'muted', style: 'font-size:12px;' }, 'Viewing:'));
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

      // User menu dropdown
      const menuWrap = el('div', { class: 'topbar-menu-wrap' });
      const menuBtn = el('button', {
        class: 'ghost topbar-btn topbar-menu-btn',
        onclick: (e) => {
          e.stopPropagation();
          menuWrap.classList.toggle('open');
          const close = () => { menuWrap.classList.remove('open'); document.removeEventListener('click', close); };
          if (menuWrap.classList.contains('open')) {
            setTimeout(() => document.addEventListener('click', close), 0);
          }
        },
      }, `${label} \u25BE`);
      const menu = el('div', { class: 'topbar-dropdown' });

      menu.appendChild(el('div', { class: 'topbar-dropdown-label muted' }, `${label} · ${role}`));

      menu.appendChild(el('button', {
        onclick: () => { window.open('?view=staff', '_blank'); },
      }, 'Live Schedule'));

      if (isOwner()) {
        menu.appendChild(el('button', {
          onclick: () => { window.open('?view=manager', '_blank'); },
        }, 'View as Manager'));
        menu.appendChild(el('button', { onclick: openAdminPanel }, 'Add/Remove Managers'));
      }

      menu.appendChild(el('button', { onclick: openTimeOffPanel }, 'Time Off'));
      menu.appendChild(el('button', { onclick: openChangePasswordModal }, 'Account'));
      menu.appendChild(el('button', {
        onclick: async () => {
          try { await api('/api/logout', { method: 'POST' }); } catch (_) {}
          state.me = { id: null };
          await render();
          toast('Signed out');
        },
      }, 'Sign out'));

      menuWrap.appendChild(menuBtn);
      menuWrap.appendChild(menu);
      chip.appendChild(menuWrap);
    } else {
      chip.appendChild(el('button', { class: 'primary', onclick: openLoginModal }, 'Sign in'));
    }
  }

  async function loadScheduleImages() {
    try {
      const list = await api('/api/schedule-images');
      state.scheduleImages = {};
      for (const img of list) {
        state.scheduleImages[img.week_start] = img;
      }
    } catch (e) {
      console.warn('Failed to load schedule images', e);
    }
  }

  function hasScheduleImage(weekKey) {
    const ws = weekForTab(weekKey);
    return !!state.scheduleImages[ws];
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

    // Load schedule images list in parallel with schedule data
    const imgPromise = loadScheduleImages();

    for (const weekKey of weeksToLoad) {
      const weekStart = weekForTab(weekKey);
      const results = await Promise.all(state.clubs.map(c =>
        api(`/api/clubs/${c.id}/schedule?week=${weekStart}`).then(data => ({ clubId: c.id, data }))
      ));
      for (const { clubId, data } of results) {
        state.weekData[weekKey][clubId] = data;
      }
    }

    await imgPromise;
  }

  function renderBody() {
    const body = $('#main-body');
    body.innerHTML = '';

    if (!state.clubs.length) {
      body.appendChild(el('div', { class: 'muted' }, 'No clubs yet.'));
      return;
    }

    // Static notice — owners only (with edit button)
    if (isOwner()) {
      const notice = el('div', { class: 'shift-notice' });
      notice.appendChild(el('div', { class: 'shift-notice-text' }, NOTICE_TEXT));
      notice.appendChild(el('button', {
        class: 'ghost shift-notice-edit',
        onclick: openNoticeModal,
      }, 'Edit'));
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

      // Import Schedule button — owners only
      if (!isPastView() && isOwner()) {
        const importBar = el('div', { class: 'import-bar' });
        importBar.appendChild(el('button', {
          class: 'primary import-schedule-btn',
          onclick: () => openImportScheduleModal(),
        }, 'Import Schedule from Image'));
        importBar.appendChild(el('span', { class: 'muted', style: 'font-size:12px;' },
          'Upload a photo or PDF of your schedule — AI will read and fill the grid'));
        body.appendChild(importBar);
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
        btnWrap.appendChild(el('button', {
          class: 'location-picker-btn',
          onclick: async () => {
            state.staffClubId = 'all';
            await loadAllSchedules();
            renderBody();
          },
        }, 'View All'));
        picker.appendChild(btnWrap);
        body.appendChild(picker);
        return;
      }

      // Show selected club(s) with a switch button
      const viewingAll = state.staffClubId === 'all';
      const visibleClubs = viewingAll
        ? state.clubs
        : state.clubs.filter(c => c.id === state.staffClubId);

      const switchBar = el('div', { class: 'location-switch' });
      switchBar.appendChild(el('span', { class: 'muted' },
        viewingAll ? 'Viewing: All Locations' : `Viewing: ${visibleClubs[0] ? visibleClubs[0].name : ''}`));
      switchBar.appendChild(el('button', {
        class: 'ghost',
        onclick: () => { state.staffClubId = null; renderBody(); },
      }, 'Switch location'));
      body.appendChild(switchBar);

      visibleClubs.forEach(club => {
        body.appendChild(renderStaffHeader(club));

        const STAFF_WEEKS = ['current', 'next'];
        STAFF_WEEKS.forEach(weekKey => {
          const data = (state.weekData[weekKey] || {})[club.id];
          if (!data) return;
          const section = el('div', { class: 'staff-week-section' });
          const heading = el('div', { class: 'club-week-heading' });
          heading.appendChild(el('span', {}, WEEK_HEADINGS[weekKey] || 'Current Work Week'));
          if (data.recent_updates && data.recent_updates.length) {
            heading.appendChild(el('button', {
              class: 'ghost',
              style: 'font-size:12px;',
              onclick: () => openWeekActivityModal(club, data),
            }, 'View Recent Changes'));
          }
          section.appendChild(heading);

          const ws = weekForTab(weekKey);
          if (state.scheduleImages[ws]) {
            section.appendChild(buildScheduleImageView(ws, weekKey));
          }
          section.appendChild(buildScheduleGrid(club, data));
          body.appendChild(section);
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
    const wrap = el('section', { class: 'club-section' + (isPastView() ? ' past-view' : '') });

    const header = el('div', { class: 'club-header' });
    header.appendChild(el('h2', {}, club.name));

    // Week nav arrows + date range inline with club name
    if (isLoggedIn() && data) {
      const ws = weekForTab(weekKey);
      header.appendChild(el('button', {
        class: 'ghost week-nav-btn',
        onclick: () => navigateWeek(-1),
        title: 'Previous week',
      }, '\u25C0'));
      if (isPastView()) {
        header.appendChild(el('span', { class: 'past-week-badge' }, 'PAST'));
      }
      header.appendChild(el('span', { class: 'club-header-date' }, fmtWeek(ws)));
      header.appendChild(el('button', {
        class: 'ghost week-nav-btn',
        onclick: () => navigateWeek(1),
        title: 'Next week',
      }, '\u25B6'));
      if (isPastView()) {
        header.appendChild(el('button', {
          class: 'ghost',
          style: 'font-size:11px;',
          onclick: () => jumpToCurrentWeek(),
        }, 'Back to Current'));
      }
      header.appendChild(el('button', {
        class: 'ghost',
        style: 'font-size:11px;',
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
    // Hidden when viewing past weeks (read-only).
    if (isLoggedIn() && !isPastView()) {
      const rs = data ? (data.review_status || 'draft') : 'draft';
      const draftBar = el('div', {
        class: 'draft-toolbar',
        'data-club-id': club.id,
        'data-review-status': rs,
      });
      const clubCount = countForClub(club.id);
      const clubUndo = undoCountForClub(club.id);
      const clubRedo = redoCountForClub(club.id);

      let statusText, statusClass;
      const hasPendingCellChanges = data && (
        (data.pending_cells && data.pending_cells.length) ||
        (data.pending_totals && data.pending_totals.length));
      let statusClickable = false;
      if (clubCount) {
        statusText = `${clubCount} unsaved change${clubCount === 1 ? '' : 's'}`;
        statusClass = 'review-badge draft';
      } else if (rs === 'approved') {
        statusText = 'Approved';
        statusClass = 'review-badge sent';
      } else if (rs === 'submitted') {
        statusText = isOwner() ? 'Changes awaiting your approval' : 'Sent for review — awaiting approval';
        statusClass = 'review-badge pending';
        statusClickable = hasPendingCellChanges;
      } else if (rs === 'changes_pending') {
        statusText = isOwner() ? 'New changes since last approval' : 'Changes since last approval — send for review';
        statusClass = 'review-badge pending';
        statusClickable = hasPendingCellChanges;
      } else {
        statusText = isOwner() ? 'Draft — not yet submitted' : 'Draft — not yet sent for review';
        statusClass = 'review-badge draft';
      }
      const statusEl = el(statusClickable ? 'button' : 'span',
        { class: statusClass + (statusClickable ? ' review-badge-clickable' : '') },
        statusClickable ? statusText + '  \u2139' : statusText
      );
      if (statusClickable) {
        statusEl.addEventListener('click', () => openPendingChangesModal(club, data));
      }
      draftBar.appendChild(statusEl);
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

      // Recent Activity — quick access for undo
      draftBar.appendChild(el('button', {
        class: 'ghost',
        onclick: () => openRecentActivityPanel(),
      }, 'Recent Activity'));

      // Clear Schedule — pushed to far right
      draftBar.appendChild(el('div', { class: 'spacer' }));
      if (isOwner()) {
        draftBar.appendChild(el('button', {
          class: 'ghost danger',
          disabled: !data || !data.schedule,
          onclick: () => openClearScheduleModal(club, data),
        }, 'Clear Schedule'));
      }

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

    wrap.appendChild(buildScheduleGrid(club, data));
    // Totals are a management-only view. Regular staff visiting without an
    // account just see the schedule and the notes; hide the totals table.
    if (isLoggedIn()) {
      wrap.appendChild(buildTotalsGrid(club, data));
    }

    return wrap;
  }

  // Build a view-only display of an uploaded schedule image
  function buildScheduleImageView(weekStart, weekKey) {
    const imgInfo = state.scheduleImages[weekStart];
    if (!imgInfo) return el('div');

    const wrap = el('div', { class: 'schedule-image-view' });
    const isPdf = imgInfo.mime_type === 'application/pdf' ||
      (imgInfo.original_name && imgInfo.original_name.toLowerCase().endsWith('.pdf'));
    const src = `/api/schedule-images/${weekStart}`;

    if (isPdf) {
      const obj = el('object', {
        type: 'application/pdf',
        data: src,
        class: 'schedule-image-pdf',
      });
      obj.innerHTML = '<p>Unable to display PDF. <a href="' + src + '" target="_blank">Download instead</a>.</p>';
      wrap.appendChild(obj);
    } else {
      const img = el('img', {
        src: src,
        alt: 'Schedule for ' + (WEEK_HEADINGS[weekKey] || weekKey),
        class: 'schedule-image-img',
      });
      wrap.appendChild(img);
    }

    return wrap;
  }

  // Build upload/replace/delete controls for schedule images (logged-in only)
  function buildScheduleImageUpload(weekStart, weekKey) {
    const wrap = el('div', { class: 'schedule-image-controls' });
    const imgInfo = state.scheduleImages[weekStart];

    if (imgInfo) {
      wrap.appendChild(el('span', { class: 'muted', style: 'font-size:12px;' },
        'Schedule image uploaded: ' + imgInfo.original_name));
    }

    // Upload / Replace button
    const fileInput = el('input', {
      type: 'file',
      accept: 'image/*,application/pdf',
      style: 'display:none;',
    });
    const label = imgInfo ? 'Replace Image' : 'Upload Schedule Image';
    const uploadBtn = el('button', {
      class: 'ghost',
      style: 'font-size:12px;',
      onclick: () => fileInput.click(),
    }, label);

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      if (!file) return;
      const formData = new FormData();
      formData.append('image', file);
      formData.append('week_start', weekStart);
      uploadBtn.disabled = true;
      uploadBtn.textContent = 'Uploading...';
      try {
        const res = await fetch('/api/schedule-images', {
          method: 'POST',
          credentials: 'same-origin',
          body: formData,
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Upload failed');
        }
        toast('Schedule image uploaded');
        await loadScheduleImages();
        renderBody();
      } catch (e) {
        toast(e.message, 'err');
        uploadBtn.disabled = false;
        uploadBtn.textContent = label;
      }
    });

    wrap.appendChild(fileInput);
    wrap.appendChild(uploadBtn);

    // Delete button (owner only)
    if (imgInfo && isOwner()) {
      wrap.appendChild(el('button', {
        class: 'ghost danger',
        style: 'font-size:12px;',
        onclick: async () => {
          if (!confirm('Remove the schedule image for this week?')) return;
          try {
            await api(`/api/schedule-images/${weekStart}`, { method: 'DELETE' });
            toast('Image removed');
            await loadScheduleImages();
            renderBody();
          } catch (e) { toast(e.message, 'err'); }
        },
      }, 'Remove Image'));
    }

    return wrap;
  }

  // Shift picker popover — shows quick-pick buttons for common shifts
  function openShiftPicker(anchorTd, clubName, input, applyValue, opts = {}) {
    // Close any existing picker and backdrop
    document.querySelectorAll('.shift-picker, .shift-picker-backdrop').forEach(n => n.remove());

    const isMobile = isMobileDevice();

    // On mobile, add a dim backdrop behind the sheet
    let backdrop = null;
    if (isMobile) {
      backdrop = el('div', { class: 'shift-picker-backdrop' });
      backdrop.addEventListener('click', () => cleanup());
      document.body.appendChild(backdrop);
    }

    const picker = el('div', { class: 'shift-picker' + (isMobile ? ' mobile-picker' : '') });
    const options = shiftOptionsForClub(clubName);

    const cleanup = () => { picker.remove(); if (backdrop) backdrop.remove(); };
    const done = (val) => {
      applyValue(val);
      cleanup();
      if (!isMobile) input.focus();
    };

    // Pending time off approval — if this cell has a pending request,
    // show an "Approve Time Off" button at the top of the picker.
    if (opts.pendingTimeOffId) {
      picker.appendChild(el('div', { class: 'shift-pick-label' }, 'Time off request'));
      const approveRow = el('div', { class: 'shift-pick-row' });
      approveRow.appendChild(el('button', {
        class: 'shift-pick-btn',
        style: 'background:#22c55e; color:#fff; border-color:#16a34a; font-weight:600;',
        onclick: async (e) => {
          e.stopPropagation();
          try {
            const result = await api(`/api/time-off/${opts.pendingTimeOffId}/approve`, { method: 'POST' });
            toast(`Approved — filled ${result.days_filled} day${result.days_filled !== 1 ? 's' : ''} as Req Off`);
            cleanup();
            await loadAllSchedules();
            renderBody();
          } catch (err) { toast(err.message, 'err'); }
        },
      }, 'Approve Time Off'));
      approveRow.appendChild(el('button', {
        class: 'shift-pick-btn shift-pick-reqoff',
        onclick: async (e) => {
          e.stopPropagation();
          try {
            await api(`/api/time-off/${opts.pendingTimeOffId}/deny`, { method: 'POST' });
            toast('Denied');
            cleanup();
            await loadAllSchedules();
            renderBody();
          } catch (err) { toast(err.message, 'err'); }
        },
      }, 'Deny'));
      picker.appendChild(approveRow);
    }

    // Full-shift location buttons
    picker.appendChild(el('div', { class: 'shift-pick-label' }, 'Full shift'));
    const fullRow = el('div', { class: 'shift-pick-row' });
    options.forEach(opt => {
      fullRow.appendChild(el('button', {
        class: 'shift-pick-btn',
        onclick: (e) => { e.stopPropagation(); done(opt); },
      }, opt));
    });
    picker.appendChild(fullRow);

    // Partial shift — pick location then type time
    picker.appendChild(el('div', { class: 'shift-pick-label' }, 'Partial shift'));
    const partialRow = el('div', { class: 'shift-pick-row' });
    options.forEach(opt => {
      partialRow.appendChild(el('button', {
        class: 'shift-pick-btn shift-pick-partial',
        onclick: (e) => {
          e.stopPropagation();
          partialRow.style.display = 'none';
          timeWrap.style.display = 'flex';
          timeLoc.textContent = opt;
          timeWrap.dataset.loc = opt;
          timeInput.focus();
        },
      }, opt));
    });
    picker.appendChild(partialRow);

    const timeWrap = el('div', { class: 'shift-pick-other-wrap', style: 'display:none;' });
    const timeLoc = el('span', { class: 'shift-pick-loc-tag' });
    const timeInput = el('input', {
      type: 'text',
      class: 'shift-pick-other-input',
      placeholder: 'e.g. 12 - Close, Open - 4',
    });
    timeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const loc = timeWrap.dataset.loc || '';
        const time = timeInput.value.trim();
        done(time ? `${time} ${loc}` : loc);
      }
    });
    const timeOk = el('button', {
      class: 'shift-pick-btn',
      onclick: (e) => {
        e.stopPropagation();
        const loc = timeWrap.dataset.loc || '';
        const time = timeInput.value.trim();
        done(time ? `${time} ${loc}` : loc);
      },
    }, 'OK');
    timeWrap.appendChild(timeLoc);
    timeWrap.appendChild(timeInput);
    timeWrap.appendChild(timeOk);
    picker.appendChild(timeWrap);

    // Free text — type anything, no location required
    picker.appendChild(el('div', { class: 'shift-pick-label' }, 'Free text'));
    const freeWrap = el('div', { class: 'shift-pick-other-wrap' });
    const freeInput = el('input', {
      type: 'text',
      class: 'shift-pick-other-input',
      placeholder: 'Type anything\u2026',
    });
    freeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        done(freeInput.value.trim());
      }
    });
    const freeOk = el('button', {
      class: 'shift-pick-btn',
      onclick: (e) => { e.stopPropagation(); done(freeInput.value.trim()); },
    }, 'OK');
    freeWrap.appendChild(freeInput);
    freeWrap.appendChild(freeOk);
    picker.appendChild(freeWrap);

    // Req Off + Clear
    const bottomRow = el('div', { class: 'shift-pick-row' });
    bottomRow.appendChild(el('button', {
      class: 'shift-pick-btn shift-pick-reqoff',
      onclick: (e) => { e.stopPropagation(); done('Req Off'); },
    }, 'Req Off'));
    bottomRow.appendChild(el('button', {
      class: 'shift-pick-btn shift-pick-clear',
      onclick: (e) => { e.stopPropagation(); done(''); },
    }, 'Clear'));
    picker.appendChild(bottomRow);

    // Mount to body for both mobile and desktop so it's never clipped.
    // Mobile: bottom-sheet. Desktop: fixed near the cell.
    document.body.appendChild(picker);
    if (!isMobile) {
      const rect = anchorTd.getBoundingClientRect();
      const pickerH = 300;
      const spaceBelow = window.innerHeight - rect.bottom;
      if (spaceBelow < pickerH && rect.top > pickerH) {
        picker.style.position = 'fixed';
        picker.style.left = rect.left + 'px';
        picker.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
        picker.style.top = 'auto';
      } else {
        picker.style.position = 'fixed';
        picker.style.left = rect.left + 'px';
        picker.style.top = rect.bottom + 4 + 'px';
      }
      picker.style.zIndex = '200';
    }

    // Close on outside click (desktop only — backdrop handles this on mobile)
    if (!isMobile) {
      const close = (e) => {
        if (!picker.contains(e.target) && e.target !== anchorTd.querySelector('.shift-picker-btn')) {
          cleanup();
          document.removeEventListener('mousedown', close);
        }
      };
      setTimeout(() => document.addEventListener('mousedown', close), 0);
    }
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

    // Pending time off requests — show ghosted "Req Off" on affected cells
    // with an approve option in the picker.
    const pendingTimeOffByCell = new Map(); // "empId:dayIdx" → request_id
    if (data.pending_time_off) {
      data.pending_time_off.forEach(t => {
        pendingTimeOffByCell.set(`${t.employee_id}:${t.day_index}`, t.request_id);
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
      const th = el('th', { colspan: 8 });
      th.appendChild(el('span', {}, sortedKeys[0]));
      if (canEditTeam(club.id, sortedKeys[0])) {
        th.appendChild(el('button', {
          class: 'ghost team-edit-btn',
          onclick: () => openRosterModal(club),
        }, 'Edit Staff'));
      }
      divider.appendChild(th);
      thead.appendChild(divider);
    }
    thead.appendChild(buildHeaderRow('Employee'));
    // Single-team clubs (like St. Augustine) don't get dividers, so put
    // Edit Staff on the club name header instead.
    if (!showDividers && canEditClub(club.id)) {
      const editRow = el('tr', { class: 'team-divider' });
      const editTd = el('th', { colspan: 8 });
      editTd.appendChild(el('span', {}, club.name));
      editTd.appendChild(el('button', {
        class: 'ghost team-edit-btn',
        onclick: () => openRosterModal(club),
      }, 'Edit Staff'));
      editRow.appendChild(editTd);
      thead.insertBefore(editRow, thead.firstChild);
    }
    table.appendChild(thead);

    sortedKeys.forEach((teamName, idx) => {
      // Second+ teams get a divider + repeated date header in tbody
      if (showDividers && teamName && idx > 0) {
        const divider = el('tr', { class: 'team-divider' });
        const td = el('td', { colspan: 8 });
        td.appendChild(el('span', {}, teamName));
        if (canEditTeam(club.id, teamName)) {
          td.appendChild(el('button', {
            class: 'ghost team-edit-btn',
            onclick: () => openRosterModal(club),
          }, 'Edit Staff'));
        }
        divider.appendChild(td);
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
            const isMobile = isMobileDevice();
            const isPendingReview = pendingReviewCells.has(`${emp.id}:${d}`);
            const pendingTimeOffId = pendingTimeOffByCell.get(`${emp.id}:${d}`);
            const hasPendingTimeOff = !!pendingTimeOffId && !cellVal;

            // On mobile, use a div instead of an input — iOS won't zoom to a
            // div. Managers pick via the bottom-sheet picker only.
            let input;
            if (isMobile) {
              input = el('div', { class: 'day-cell-display', 'data-cell-key': key }, cellVal);
              input.style.color = cellColorFor(cellVal);
              Object.defineProperty(input, 'value', {
                get() { return input.textContent; },
                set(v) { input.textContent = v || ''; },
              });
            } else {
              input = el('input', { type: 'text', 'data-cell-key': key });
              input.value = cellVal;
              input.style.color = cellColorFor(cellVal);
            }
            if (pending || isPendingReview) input.classList.add('cell-dirty');

            // Ghost overlay for pending time off requests (when cell is empty)
            if (hasPendingTimeOff) {
              td.classList.add('cell-pending-timeoff');
              const ghost = el('div', { class: 'cell-ghost-timeoff' }, 'Req Off (pending)');
              td.appendChild(ghost);
              td.dataset.pendingTimeOffId = pendingTimeOffId;
            }

            const applyValue = (val) => {
              input.value = val;
              input.style.color = cellColorFor(val);
              const prevVal = state.pendingChanges.has(key)
                ? state.pendingChanges.get(key).shift_text : serverVal;
              recordEdit(key,
                { schedule_id: data.schedule.id, employee_id: emp.id, day_index: d, club_id: club.id },
                prevVal, val, serverVal);
              input.classList.toggle('cell-dirty',
                val !== serverVal || isPendingReview);
              refreshTotals(club, data);
            };

            if (!isMobile) {
              input.addEventListener('input', () => applyValue(input.value));
            }

            const openPicker = () => openShiftPicker(td, club.name, input, applyValue, {
              pendingTimeOffId: hasPendingTimeOff ? pendingTimeOffId : null,
            });

            // Tapping a cell opens the picker (mobile + desktop).
            input.addEventListener('click', (e) => {
              e.stopPropagation();
              openPicker();
            });
            // Clicking on the ghost overlay too
            td.addEventListener('click', (e) => {
              if (e.target.classList && e.target.classList.contains('cell-ghost-timeoff')) {
                e.stopPropagation();
                openPicker();
              }
            });

            // Shift picker trigger (always visible; desktop shows on hover)
            const pickerBtn = el('button', {
              class: 'shift-picker-btn',
              tabindex: '-1',
              onclick: (e) => {
                e.stopPropagation();
                openPicker();
              },
            }, '\u25BC');

            td.appendChild(input);
            td.appendChild(pickerBtn);
            // Show change badges + before/after info for cells that changed
            // since the last review.
            if (isPendingReview) {
              const info = pendingReviewInfo.get(`${emp.id}:${d}`) || {};
              const oldV = info.old_value || '';
              const newV = info.new_value || '';
              let changeKind = 'changed';
              if (!oldV && newV) changeKind = 'added';
              else if (oldV && !newV) changeKind = 'removed';
              td.classList.add('cell-change-' + changeKind);
              // Show the old value inline for removed/changed cells
              if (oldV && (!cellVal || changeKind === 'changed')) {
                const strike = el('div', { class: 'cell-removed' }, 'was: ' + oldV);
                td.appendChild(strike);
              }
              // Corner badge: + (added), - (removed), ~ (changed)
              const badgeChar = changeKind === 'added' ? '+'
                : changeKind === 'removed' ? '\u2212' : '~';
              const badge = el('div', { class: 'cell-change-badge cell-change-badge-' + changeKind }, badgeChar);
              td.appendChild(badge);
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

  // Refresh totals display in place after a cell edit
  function refreshTotals(club, data) {
    const existing = document.querySelector(`.totals-wrap[data-club-id="${club.id}"]`);
    if (!existing) return;
    const newTotals = buildTotalsGrid(club, data);
    existing.replaceWith(newTotals);
  }

  // Count staffing per location per day from shift data + pending changes
  function computeTotals(data) {
    const counts = {}; // { locationName: [day0, day1, ... day6] }
    const locations = data.locations || [];
    locations.forEach(loc => { counts[loc] = [0,0,0,0,0,0,0]; });

    for (const emp of data.employees) {
      for (let d = 0; d < 7; d++) {
        // Check pending changes first, fall back to server value
        const key = cellKey(data.schedule.id, emp.id, d);
        const pending = state.pendingChanges.get(key);
        const text = pending ? pending.shift_text
          : (data.shifts[emp.id] && data.shifts[emp.id][d]) || '';
        const loc = locationFromShiftText(text);
        if (loc && counts[loc] !== undefined) {
          counts[loc][d]++;
        }
      }
    }
    return counts;
  }

  function buildTotalsGrid(club, data) {
    const locations = data.locations || [];
    if (!locations.length) return el('div');

    const weekStart = data.schedule.week_start;
    const wrap = el('div', { class: 'totals-wrap', 'data-club-id': club.id });
    wrap.appendChild(el('div', { class: 'totals-label' }, 'Staffing by location'));

    const counts = computeTotals(data);

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
        const count = counts[loc] ? counts[loc][d] : 0;
        td.appendChild(el('div', { class: 'totals-count' }, count ? String(count) : '—'));
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  // -------- login modal --------
  // -------- Import Schedule from Image --------
  // -------- Time Off panel --------
  // -------- Recent Activity panel (managers + owners) --------
  async function openRecentActivityPanel() {
    const content = el('div');
    content.appendChild(el('h2', {}, 'Recent Activity'));
    content.appendChild(el('p', { class: 'muted', style: 'margin-top:-6px;' },
      'Last 30 days. Click Undo to revert a cell or totals change.'));

    const list = el('div', { class: 'activity-list' });
    content.appendChild(list);

    const footer = el('div', { style: 'margin-top:12px;' });
    content.appendChild(footer);

    content.appendChild(el('button', {
      class: 'ghost', style: 'margin-top:12px;',
      onclick: closeModal,
    }, 'Close'));

    openModal(content, { wide: true });

    const pageSize = 50;
    let offset = 0;

    async function loadPage() {
      footer.innerHTML = '';
      let result;
      try { result = await api(`/api/audit?limit=${pageSize}&offset=${offset}`); }
      catch (e) { footer.appendChild(el('div', { class: 'error' }, e.message)); return; }

      result.entries.forEach(e => {
        const isRevertable = e.action === 'cell_edit' || e.action === 'total_edit';
        const row = el('div', { class: 'activity-row' +
          (e.action === 'schedule_published' || e.action === 'schedule_submitted' ? ' activity-publish' : '') });
        row.appendChild(el('div', { class: 'activity-when' }, fmtRelative(e.created_at)));
        row.appendChild(el('div', { class: 'activity-who muted' }, e.user_label));
        row.appendChild(el('div', { class: 'activity-what' }, describeAuditEntry(e)));

        if (isRevertable) {
          const undoBtn = el('button', {
            class: 'ghost',
            style: 'font-size:11px; padding:2px 8px; margin-left:8px;',
            onclick: async () => {
              if (!confirm('Undo this change?')) return;
              try {
                await api(`/api/audit/${e.id}/revert`, { method: 'POST' });
                toast('Reverted');
                await loadAllSchedules();
                renderBody();
                list.innerHTML = '';
                offset = 0;
                loadPage();
              } catch (err) { toast(err.message, 'err'); }
            },
          }, 'Undo');
          row.appendChild(undoBtn);
        }

        list.appendChild(row);
      });

      offset += pageSize;
      if (offset < result.total) {
        footer.appendChild(el('button', {
          class: 'ghost', onclick: loadPage,
        }, `Load more (${result.total - offset} remaining)`));
      } else if (!result.entries.length && offset === pageSize) {
        list.appendChild(el('div', { class: 'muted' }, 'No activity yet.'));
      }
    }

    loadPage();
  }

  async function openTimeOffPanel() {
    const content = el('div');
    const titleRow = el('div', { style: 'display:flex; justify-content:space-between; align-items:center;' });
    titleRow.appendChild(el('h2', { style: 'margin:0;' }, 'Time Off Requests'));
    if (isOwner()) {
      titleRow.appendChild(el('button', {
        class: 'ghost',
        style: 'font-size:11px;',
        onclick: async () => {
          if (!confirm('Reset ALL approved requests back to pending? Auto-filled Req Off cells will be cleared.')) return;
          try {
            const result = await api('/api/time-off/reset-all-approved', { method: 'POST' });
            toast(`Reset ${result.reset_count} requests, cleared ${result.cells_cleared} cells`);
            refreshList();
            await loadAllSchedules();
            renderBody();
          } catch (err) { toast(err.message, 'err'); }
        },
      }, 'Reset All Approved'));
    }
    content.appendChild(titleRow);

    // Add new request form
    const addWrap = el('div', { class: 'timeoff-add' });
    addWrap.appendChild(el('div', { class: 'timeoff-add-label' }, 'Add Request'));

    const empSelect = el('select', { class: 'timeoff-select' });
    empSelect.appendChild(el('option', { value: '' }, 'Select employee...'));
    for (const club of state.clubs) {
      const weekKey = state.tab;
      const data = (state.weekData[weekKey] || {})[club.id];
      if (!data) continue;
      const optgroup = el('optgroup', { label: club.name });
      data.employees.forEach(e => {
        optgroup.appendChild(el('option', { value: e.id }, e.name));
      });
      empSelect.appendChild(optgroup);
    }

    const startInput = el('input', { type: 'date', class: 'timeoff-date' });
    const endInput = el('input', { type: 'date', class: 'timeoff-date' });
    const noteInput = el('input', { type: 'text', placeholder: 'Note (optional)', class: 'timeoff-note' });

    const addRow = el('div', { class: 'timeoff-add-row' });
    addRow.appendChild(empSelect);
    addRow.appendChild(el('span', { class: 'muted' }, 'From'));
    addRow.appendChild(startInput);
    addRow.appendChild(el('span', { class: 'muted' }, 'To'));
    addRow.appendChild(endInput);
    addRow.appendChild(noteInput);
    addRow.appendChild(el('button', {
      class: 'primary',
      onclick: async () => {
        if (!empSelect.value || !startInput.value || !endInput.value) {
          toast('Select employee and dates', 'err'); return;
        }
        try {
          await api('/api/time-off', {
            method: 'POST',
            body: {
              employee_id: Number(empSelect.value),
              start_date: startInput.value,
              end_date: endInput.value,
              note: noteInput.value,
            },
          });
          toast('Request added');
          empSelect.value = ''; startInput.value = ''; endInput.value = '';
          noteInput.value = '';
          refreshList();
        } catch (err) { toast(err.message, 'err'); }
      },
    }, 'Add'));
    addWrap.appendChild(addRow);
    content.appendChild(addWrap);

    const listWrap = el('div', { class: 'timeoff-list' });
    content.appendChild(listWrap);

    async function refreshList() {
      const requests = await api('/api/time-off');
      listWrap.innerHTML = '';
      if (!requests.length) {
        listWrap.appendChild(el('div', { class: 'muted', style: 'padding:12px;' }, 'No time off requests yet.'));
        return;
      }

      const groups = { pending: [], approved: [], denied: [] };
      requests.forEach(r => { (groups[r.status] || groups.pending).push(r); });

      for (const [status, items] of Object.entries(groups)) {
        if (!items.length) continue;
        const label = status === 'pending' ? 'Pending'
          : status === 'approved' ? 'Approved' : 'Denied';
        listWrap.appendChild(el('div', { class: 'timeoff-group-label timeoff-' + status }, label));

        items.forEach(r => {
          const row = el('div', { class: 'timeoff-row timeoff-' + r.status });

          row.appendChild(el('span', { class: 'timeoff-name' }, r.employee_name));
          row.appendChild(el('span', { class: 'timeoff-club muted' }, r.club_name));
          row.appendChild(el('span', { class: 'timeoff-dates' },
            r.start_date === r.end_date ? r.start_date : `${r.start_date} to ${r.end_date}`));
          if (r.note) row.appendChild(el('span', { class: 'timeoff-note-text muted' }, r.note));

          const actions = el('div', { class: 'timeoff-actions' });

          if (r.status === 'pending') {
            actions.appendChild(el('button', {
              class: 'primary',
              style: 'font-size:11px; padding:3px 10px;',
              onclick: async () => {
                try {
                  const result = await api(`/api/time-off/${r.id}/approve`, { method: 'POST' });
                  toast(`Approved \u2014 filled ${result.days_filled} day${result.days_filled !== 1 ? 's' : ''} as Req Off`);
                  refreshList();
                  await loadAllSchedules();
                  renderBody();
                } catch (err) { toast(err.message, 'err'); }
              },
            }, 'Approve'));
            actions.appendChild(el('button', {
              class: 'ghost danger',
              style: 'font-size:11px; padding:3px 10px;',
              onclick: async () => {
                try {
                  await api(`/api/time-off/${r.id}/deny`, { method: 'POST' });
                  toast('Denied');
                  refreshList();
                } catch (err) { toast(err.message, 'err'); }
              },
            }, 'Deny'));
          } else if (r.status === 'approved' || r.status === 'denied') {
            // Reset back to pending
            actions.appendChild(el('button', {
              class: 'ghost',
              style: 'font-size:11px; padding:3px 10px;',
              onclick: async () => {
                if (!confirm('Reset to Pending? If it was approved, the auto-filled Req Off cells will be cleared.')) return;
                try {
                  const result = await api(`/api/time-off/${r.id}/reset`, { method: 'POST' });
                  toast(`Reset to pending${result.cells_cleared ? ` \u2014 cleared ${result.cells_cleared} cell${result.cells_cleared !== 1 ? 's' : ''}` : ''}`);
                  refreshList();
                  await loadAllSchedules();
                  renderBody();
                } catch (err) { toast(err.message, 'err'); }
              },
            }, 'Reset to Pending'));
          }

          // Edit button
          actions.appendChild(el('button', {
            class: 'ghost',
            style: 'font-size:11px; padding:3px 8px;',
            onclick: () => openEditTimeOff(r, refreshList),
          }, 'Edit'));

          // Delete button
          actions.appendChild(el('button', {
            class: 'ghost danger',
            style: 'font-size:11px; padding:3px 8px;',
            onclick: async () => {
              if (!confirm(`Delete time off for ${r.employee_name} (${r.start_date})?`)) return;
              try {
                await api(`/api/time-off/${r.id}`, { method: 'DELETE' });
                toast('Deleted');
                refreshList();
              } catch (err) { toast(err.message, 'err'); }
            },
          }, 'Delete'));

          row.appendChild(actions);
          listWrap.appendChild(row);
        });
      }
    }

    content.appendChild(el('button', {
      class: 'ghost', style: 'margin-top:12px;',
      onclick: closeModal,
    }, 'Close'));

    openModal(content, { wide: true });
    refreshList();
  }

  function openEditTimeOff(r, onSave) {
    const content = el('div');
    content.appendChild(el('h2', {}, `Edit Time Off \u2014 ${r.employee_name}`));

    const startIn = el('input', { type: 'date', value: r.start_date });
    const endIn = el('input', { type: 'date', value: r.end_date });
    const noteIn = el('input', { type: 'text', value: r.note || '', placeholder: 'Note (optional)' });

    const form = el('div', { style: 'display:flex; flex-direction:column; gap:10px; margin:12px 0;' });
    const dateRow = el('div', { style: 'display:flex; gap:8px; align-items:center;' });
    dateRow.appendChild(el('span', {}, 'From'));
    dateRow.appendChild(startIn);
    dateRow.appendChild(el('span', {}, 'To'));
    dateRow.appendChild(endIn);
    form.appendChild(dateRow);
    form.appendChild(noteIn);
    content.appendChild(form);

    const btnRow = el('div', { style: 'display:flex; gap:8px;' });
    btnRow.appendChild(el('button', {
      class: 'primary',
      onclick: async () => {
        try {
          await api(`/api/time-off/${r.id}`, {
            method: 'PATCH',
            body: {
              start_date: startIn.value,
              end_date: endIn.value,
              note: noteIn.value,
            },
          });
          toast('Updated');
          closeModal();
          onSave();
          // Re-open the time off panel
          openTimeOffPanel();
        } catch (err) { toast(err.message, 'err'); }
      },
    }, 'Save'));
    btnRow.appendChild(el('button', {
      class: 'ghost',
      onclick: () => { closeModal(); openTimeOffPanel(); },
    }, 'Cancel'));
    content.appendChild(btnRow);

    openModal(content);
  }

  // -------- Import Schedule from Image --------
  function openImportScheduleModal() {
    const content = el('div');
    content.appendChild(el('h2', {}, 'Import Schedule from Image'));
    content.appendChild(el('p', { class: 'muted' },
      'Upload a photo or PDF of your schedule. AI will read it and fill in shifts for all clubs found in the image.'));

    const fileInput = el('input', { type: 'file', accept: 'image/*,application/pdf' });
    content.appendChild(fileInput);

    const statusDiv = el('div', { class: 'muted', style: 'margin-top:10px;' });
    content.appendChild(statusDiv);

    const previewDiv = el('div', { style: 'margin-top:12px; max-height:60vh; overflow-y:auto;' });
    content.appendChild(previewDiv);

    const btnRow = el('div', { style: 'margin-top:10px; display:flex; gap:8px;' });
    const parseBtn = el('button', {
      class: 'primary',
      disabled: true,
      onclick: async () => {
        const file = fileInput.files[0];
        if (!file) return;
        parseBtn.disabled = true;
        parseBtn.textContent = 'Reading schedule...';
        statusDiv.textContent = 'AI is reading your schedule — this may take 15-30 seconds...';
        previewDiv.innerHTML = '';

        const formData = new FormData();
        formData.append('image', file);

        try {
          const res = await fetch('/api/parse-schedule', {
            method: 'POST',
            credentials: 'same-origin',
            body: formData,
          });
          const result = await res.json();
          if (!res.ok) throw new Error(result.error || 'Parse failed');

          const clubCount = Object.keys(result.clubs || {}).length;
          let totalEmps = 0;
          for (const c of Object.values(result.clubs || {})) {
            totalEmps += Object.keys(c.shifts || {}).length;
          }
          statusDiv.textContent = `Found ${clubCount} club${clubCount !== 1 ? 's' : ''}, ${totalEmps} employees. Review below and click Apply All.`;
          showMultiClubPreview(previewDiv, result.clubs || {});
        } catch (err) {
          statusDiv.textContent = '';
          toast(err.message, 'err');
          parseBtn.disabled = false;
          parseBtn.textContent = 'Parse Schedule';
        }
      },
    }, 'Parse Schedule');

    fileInput.addEventListener('change', () => {
      parseBtn.disabled = !fileInput.files.length;
    });

    btnRow.appendChild(parseBtn);
    btnRow.appendChild(el('button', { class: 'ghost', onclick: closeModal }, 'Cancel'));
    content.appendChild(btnRow);

    openModal(content, { wide: true });
  }

  function showMultiClubPreview(container, parsedClubs) {
    container.innerHTML = '';

    // Detect new employees not in the roster
    const newEmployees = [];
    for (const [clubName, clubResult] of Object.entries(parsedClubs)) {
      const clubId = clubResult.club_id;
      if (!clubId) continue;
      const weekKey = state.tab;
      const data = (state.weekData[weekKey] || {})[clubId];
      if (!data) continue;
      const knownNames = new Set(data.employees.map(e => e.name.toLowerCase()));
      for (const name of Object.keys(clubResult.shifts || {})) {
        if (!knownNames.has(name.toLowerCase())) {
          newEmployees.push({ clubName, clubId, name });
        }
      }
    }

    // Show new employee banner if any found
    if (newEmployees.length) {
      const banner = el('div', { class: 'import-issues' });
      banner.appendChild(el('div', { class: 'import-issue-header' },
        `${newEmployees.length} new employee${newEmployees.length > 1 ? 's' : ''} found — not yet in the roster:`));
      newEmployees.forEach(ne => {
        const row = el('div', { class: 'import-issue-row' });
        row.appendChild(el('span', { class: 'import-new-badge' }, 'NEW'));
        row.appendChild(el('span', {}, `${ne.name} (${ne.clubName})`));
        const addBtn = el('button', {
          class: 'primary',
          style: 'font-size:11px; padding:3px 10px; margin-left:8px;',
          onclick: async () => {
            try {
              await api(`/api/clubs/${ne.clubId}/employees`, {
                method: 'POST',
                body: { name: ne.name },
              });
              addBtn.textContent = 'Added!';
              addBtn.disabled = true;
              addBtn.className = 'ghost';
              await loadAllSchedules();
            } catch (err) { toast(err.message, 'err'); }
          },
        }, 'Add to Roster');
        row.appendChild(addBtn);
        banner.appendChild(row);
      });
      banner.appendChild(el('div', { class: 'muted', style: 'font-size:11px; margin-top:6px;' },
        'Add new employees first, then click Apply All. Unadded employees will be skipped.'));
      container.appendChild(banner);
    }

    // Apply All button
    const applyAllBtn = el('button', {
      class: 'primary',
      style: 'margin:12px 0;',
      onclick: () => {
        applyAllParsedShifts(parsedClubs);
        closeModal();
      },
    }, 'Apply All to Schedule');
    container.appendChild(applyAllBtn);

    // Preview tables per club
    for (const [clubName, clubResult] of Object.entries(parsedClubs)) {
      const shifts = clubResult.shifts || {};
      const empNames = Object.keys(shifts);
      if (!empNames.length) continue;

      const clubId = clubResult.club_id;
      const weekKey = state.tab;
      const data = clubId ? (state.weekData[weekKey] || {})[clubId] : null;
      const knownNames = data
        ? new Set(data.employees.map(e => e.name.toLowerCase()))
        : new Set();

      container.appendChild(el('h3', { style: 'margin:16px 0 8px;' }, clubName));

      const table = el('table', { class: 'data-table', style: 'font-size:12px; margin-bottom:8px;' });
      const thead = el('thead');
      const hrow = el('tr');
      hrow.appendChild(el('th', {}, 'Employee'));
      DAYS.forEach(d => hrow.appendChild(el('th', {}, d)));
      thead.appendChild(hrow);
      table.appendChild(thead);

      const tbody = el('tbody');
      empNames.forEach(name => {
        const dayShifts = shifts[name] || [];
        const isNew = !knownNames.has(name.toLowerCase());
        const tr = el('tr');
        if (isNew) tr.style.background = 'rgba(245, 158, 11, 0.1)';
        const nameTd = el('td', { style: 'font-weight:600;' });
        nameTd.appendChild(document.createTextNode(name));
        if (isNew) {
          nameTd.appendChild(el('span', { class: 'import-new-badge', style: 'margin-left:6px;' }, 'NEW'));
        }
        tr.appendChild(nameTd);
        for (let d = 0; d < 7; d++) {
          const val = dayShifts[d] || '';
          const td = el('td');
          td.textContent = val || '\u2014';
          if (val) td.style.color = cellColorFor(val) || 'inherit';
          else td.style.color = 'var(--muted)';
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      container.appendChild(table);
    }
  }

  function applyAllParsedShifts(parsedClubs) {
    let totalApplied = 0;
    let allSkipped = [];

    for (const [clubName, clubResult] of Object.entries(parsedClubs)) {
      const clubId = clubResult.club_id;
      if (!clubId) { allSkipped.push(clubName + ' (unknown club)'); continue; }

      const club = state.clubs.find(c => c.id === clubId);
      if (!club) continue;

      const weekKey = state.tab;
      const data = (state.weekData[weekKey] || {})[clubId];
      if (!data) continue;

      const empByName = {};
      for (const emp of data.employees) {
        empByName[emp.name.toLowerCase()] = emp;
      }

      for (const [name, shifts] of Object.entries(clubResult.shifts || {})) {
        const emp = empByName[name.toLowerCase()];
        if (!emp) { allSkipped.push(name); continue; }
        for (let d = 0; d < 7; d++) {
          const val = (shifts[d] || '').trim();
          const key = cellKey(data.schedule.id, emp.id, d);
          const serverVal = (data.shifts[emp.id] && data.shifts[emp.id][d]) || '';
          if (val !== serverVal) {
            recordEdit(key,
              { schedule_id: data.schedule.id, employee_id: emp.id, day_index: d, club_id: clubId },
              serverVal, val, serverVal);
            totalApplied++;
          }
        }
      }
    }

    renderBody();
    if (allSkipped.length) {
      toast(`Applied ${totalApplied} shifts. Skipped: ${allSkipped.join(', ')}`, 'warn');
    } else {
      toast(`Applied ${totalApplied} shifts from image`);
    }
  }

  function openLoginModal() {
    const content = el('div');
    content.appendChild(el('h2', {}, 'Sign in'));
    content.appendChild(el('p', { class: 'muted' }, 'Enter your manager or owner credentials.'));

    const emailIn = el('input', { type: 'text', placeholder: 'email or username', autocomplete: 'username' });
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
    content.appendChild(el('h2', {}, 'Add/Remove Managers'));

    const tabBody = el('div');
    content.appendChild(tabBody);

    content.appendChild(el('div', { class: 'modal-actions' }, [
      el('button', { onclick: closeModal }, 'Close'),
      el('button', {
        class: 'ghost',
        onclick: () => { window.location.href = '/api/export/backup'; },
      }, 'Download full backup (JSON)'),
    ]));

    openModal(content, { wide: true });
    renderUsersTab(tabBody);
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

  function renderImportTab(container) {
    container.appendChild(el('p', { class: 'muted' },
      'Import schedule data from a JSON file. Shifts are matched to employees by name. Existing shifts for the target week will be overwritten.'));

    // Club picker
    const clubSelect = el('select');
    state.clubs.forEach(c => {
      clubSelect.appendChild(el('option', { value: c.id }, c.name));
    });

    // Week picker
    const weekInput = el('input', { type: 'date', value: mondayOf(new Date()) });

    // File input
    const fileInput = el('input', { type: 'file', accept: '.json' });
    fileInput.style.width = 'auto';

    // Preview area
    const preview = el('div', { style: 'margin-top:12px;' });

    // Result area
    const result = el('div', { style: 'margin-top:12px;' });

    container.appendChild(el('label', {}, ['Club', clubSelect]));
    container.appendChild(el('label', {}, ['Week starting (Monday)', weekInput]));
    container.appendChild(el('label', {}, ['JSON file', fileInput]));

    // Format help
    const helpText = el('details', { style: 'margin:12px 0;font-size:13px;' }, [
      el('summary', { style: 'cursor:pointer;color:var(--accent);' }, 'JSON format reference'),
      el('pre', { style: 'background:var(--panel);padding:10px;border-radius:6px;overflow-x:auto;font-size:12px;margin-top:6px;' },
`{
  "shifts": [
    { "employee_name": "John Smith", "day_index": 0, "shift_text": "East" },
    { "employee_name": "Jane Doe", "day_index": 1, "shift_text": "West" }
  ],
  "totals": [
    { "location": "Jacksonville Beach", "day_index": 0, "count_text": "3" }
  ],
  "notes": "Optional schedule notes"
}`),
      el('p', { class: 'muted', style: 'margin-top:6px;' },
        'day_index: 0=Mon, 1=Tue, 2=Wed, 3=Thu, 4=Fri, 5=Sat, 6=Sun. Employee names must match the roster exactly.'),
    ]);
    container.appendChild(helpText);

    container.appendChild(preview);

    // Parse and preview on file select
    let parsedData = null;
    fileInput.addEventListener('change', () => {
      preview.innerHTML = '';
      result.innerHTML = '';
      parsedData = null;
      const file = fileInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          parsedData = JSON.parse(reader.result);
          const shiftCount = Array.isArray(parsedData.shifts) ? parsedData.shifts.length : 0;
          const totalCount = Array.isArray(parsedData.totals) ? parsedData.totals.length : 0;
          const hasNotes = parsedData.notes ? 'yes' : 'no';
          preview.appendChild(el('div', { style: 'padding:10px;background:var(--panel);border-radius:6px;' }, [
            el('strong', {}, 'Preview: '),
            el('span', {}, `${shiftCount} shifts, ${totalCount} totals, notes: ${hasNotes}`),
          ]));
        } catch (e) {
          preview.appendChild(el('div', { class: 'error' }, `Invalid JSON: ${e.message}`));
        }
      };
      reader.readAsText(file);
    });

    const importBtn = el('button', {
      class: 'primary',
      style: 'margin-top:10px;',
      onclick: async () => {
        result.innerHTML = '';
        if (!parsedData) {
          result.appendChild(el('div', { class: 'error' }, 'Select a JSON file first'));
          return;
        }
        const clubId = clubSelect.value;
        const weekVal = weekInput.value;
        if (!weekVal) {
          result.appendChild(el('div', { class: 'error' }, 'Select a week'));
          return;
        }
        importBtn.disabled = true;
        importBtn.textContent = 'Importing...';
        try {
          const res = await api(`/api/clubs/${clubId}/import`, {
            method: 'POST',
            body: {
              week_start: weekVal,
              shifts: parsedData.shifts || [],
              totals: parsedData.totals || [],
              notes: parsedData.notes || null,
            },
          });
          let msg = `Imported ${res.imported} entries.`;
          if (res.skipped && res.skipped.length) {
            msg += ` Skipped (name not found): ${res.skipped.join(', ')}`;
          }
          result.appendChild(el('div', { class: 'ok', style: 'font-weight:600;' }, msg));
          toast('Import complete');
          await loadAllSchedules();
          renderBody();
        } catch (e) {
          result.appendChild(el('div', { class: 'error' }, e.message));
        } finally {
          importBtn.disabled = false;
          importBtn.textContent = 'Import Schedule';
        }
      },
    }, 'Import Schedule');
    container.appendChild(importBtn);
    container.appendChild(result);
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
      case 'schedule_cleared':
        return `cleared all shifts for ${club || d.club_name || 'club'} — week of ${d.week_start}`;
      case 'schedule_imported':
        return `imported ${d.imported_count || 0} entries for ${club || d.club_name || 'club'} — week of ${d.week_start}`;
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
  // Show what changed since the last approval/send-for-review.
  // Uses data.pending_cells and data.pending_totals which the server
  // already computed for us.
  function openPendingChangesModal(club, data) {
    const content = el('div');
    content.appendChild(el('h2', {}, `Pending Changes — ${club.name}`));
    content.appendChild(el('p', { class: 'muted', style: 'margin-top:-6px;' },
      `Cells changed since last ${data.review_status === 'submitted' ? 'send for review' : 'approval'}.`));

    const empById = {};
    for (const e of data.employees) empById[e.id] = e;

    const cells = (data.pending_cells || []).slice().sort((a, b) => {
      const na = empById[a.employee_id] ? empById[a.employee_id].name : '';
      const nb = empById[b.employee_id] ? empById[b.employee_id].name : '';
      if (na !== nb) return na.localeCompare(nb);
      return a.day_index - b.day_index;
    });
    const totals = data.pending_totals || [];

    if (!cells.length && !totals.length) {
      content.appendChild(el('div', { class: 'muted' }, 'No changes.'));
    }

    if (cells.length) {
      content.appendChild(el('h3', { style: 'margin-top:14px;' }, 'Shift changes'));
      const table = el('table', { class: 'data-table', style: 'font-size:13px;' });
      table.appendChild(el('thead', {}, el('tr', {}, [
        el('th', {}, 'Employee'),
        el('th', {}, 'Day'),
        el('th', {}, 'Before'),
        el('th', {}, 'After'),
      ])));
      const tbody = el('tbody');
      cells.forEach(c => {
        const empName = empById[c.employee_id] ? empById[c.employee_id].name : `(employee ${c.employee_id})`;
        const dayLabel = DAYS[c.day_index] || `Day ${c.day_index}`;
        const dt = new Date(data.schedule.week_start + 'T00:00:00');
        dt.setDate(dt.getDate() + c.day_index);
        const dateLabel = `${dayLabel} ${dt.getMonth()+1}/${dt.getDate()}`;
        const tr = el('tr');
        tr.appendChild(el('td', { style: 'font-weight:600;' }, empName));
        tr.appendChild(el('td', {}, dateLabel));
        const beforeTd = el('td', {});
        if (c.old_value) {
          beforeTd.textContent = c.old_value;
          beforeTd.style.color = cellColorFor(c.old_value) || 'inherit';
        } else {
          beforeTd.textContent = '(empty)';
          beforeTd.style.color = 'var(--muted)';
        }
        tr.appendChild(beforeTd);
        const afterTd = el('td', {});
        if (c.new_value) {
          afterTd.textContent = c.new_value;
          afterTd.style.color = cellColorFor(c.new_value) || 'inherit';
          afterTd.style.fontWeight = '600';
        } else {
          afterTd.textContent = '(cleared)';
          afterTd.style.color = 'var(--danger)';
          afterTd.style.fontWeight = '600';
        }
        tr.appendChild(afterTd);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      content.appendChild(table);
    }

    if (totals.length) {
      content.appendChild(el('h3', { style: 'margin-top:14px;' }, 'Staffing total changes'));
      const table = el('table', { class: 'data-table', style: 'font-size:13px;' });
      table.appendChild(el('thead', {}, el('tr', {}, [
        el('th', {}, 'Location'),
        el('th', {}, 'Day'),
      ])));
      const tbody = el('tbody');
      totals.forEach(t => {
        const dayLabel = DAYS[t.day_index] || `Day ${t.day_index}`;
        const dt = new Date(data.schedule.week_start + 'T00:00:00');
        dt.setDate(dt.getDate() + t.day_index);
        const dateLabel = `${dayLabel} ${dt.getMonth()+1}/${dt.getDate()}`;
        const tr = el('tr');
        tr.appendChild(el('td', {}, t.location));
        tr.appendChild(el('td', {}, dateLabel));
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      content.appendChild(table);
    }

    content.appendChild(el('button', {
      class: 'ghost', style: 'margin-top:12px;',
      onclick: closeModal,
    }, 'Close'));

    openModal(content, { wide: true });
  }

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

  // -------- clear schedule modal --------
  function openClearScheduleModal(club, data) {
    if (!data || !data.schedule) return;
    const content = el('div');
    content.appendChild(el('h2', {}, `Clear Schedule — ${club.name}`));
    content.appendChild(el('p', {},
      `This will delete all shifts, staffing totals, and notes for the week of ${data.schedule.week_start}.`));
    content.appendChild(el('p', { style: 'color:var(--danger);font-weight:600;' },
      'This action cannot be undone.'));
    const errDiv = el('div', { class: 'error' });
    content.appendChild(errDiv);
    content.appendChild(el('div', { class: 'modal-actions' }, [
      el('button', { onclick: closeModal }, 'Cancel'),
      el('button', {
        class: 'danger',
        onclick: async () => {
          errDiv.textContent = '';
          try {
            await api(`/api/schedules/${data.schedule.id}/clear`, { method: 'POST' });
            // Discard any pending changes for this club
            state.pendingChanges.forEach((v, k) => {
              if (Number(v.club_id) === club.id) state.pendingChanges.delete(k);
            });
            state.undoStack = state.undoStack.filter(e => Number(e.club_id) !== club.id);
            state.redoStack = state.redoStack.filter(e => Number(e.club_id) !== club.id);
            closeModal();
            toast('Schedule cleared');
            await loadAllSchedules();
            renderBody();
          } catch (e) { errDiv.textContent = e.message; }
        },
      }, 'Clear Everything'),
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
          }, e.archived ? 'Restore' : 'Remove'));
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
