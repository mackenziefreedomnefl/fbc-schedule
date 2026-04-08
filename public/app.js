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
  const state = {
    me: { id: null },                     // current user (or { id: null })
    clubs: [],                            // [{ id, name }]
    tab: 'current',                       // 'current' | 'next'
    weekStart: null,                      // YYYY-MM-DD derived from tab (or nav)
    clubData: {},                         // clubId -> { schedule, employees, shifts }
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
  function canEditEmployee(employee) {
    if (!isLoggedIn()) return false;
    if (isOwner()) return true;
    if (state.me.role !== 'manager') return false;
    if (Number(state.me.club_id) !== Number(employee.club_id)) return false;
    if (state.me.team) return (employee.team || '') === state.me.team;
    return true;
  }
  function canEditTeam(clubId, team) {
    if (!isLoggedIn()) return false;
    if (isOwner()) return true;
    if (state.me.role !== 'manager') return false;
    if (Number(state.me.club_id) !== Number(clubId)) return false;
    if (state.me.team) return team === state.me.team;
    return true;
  }
  function canEditClub(clubId) {
    if (!isLoggedIn()) return false;
    if (isOwner()) return true;
    return state.me.role === 'manager' && Number(state.me.club_id) === Number(clubId);
  }

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
    if (tab === 'next') return addDays(thisWeek, 7);
    return thisWeek;
  }

  async function bootstrap() {
    try {
      const [me, clubs] = await Promise.all([api('/api/me'), api('/api/clubs')]);
      state.me = me || { id: null };
      state.clubs = clubs || [];
      state.weekStart = weekForTab(state.tab);
      await render();
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

  async function switchTab(tab) {
    state.tab = tab;
    state.weekStart = weekForTab(tab);
    await loadAllSchedules();
    renderBody();
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
    const results = await Promise.all(state.clubs.map(c =>
      api(`/api/clubs/${c.id}/schedule?week=${state.weekStart}`).then(data => ({ clubId: c.id, data }))
    ));
    state.clubData = {};
    for (const { clubId, data } of results) {
      state.clubData[clubId] = data;
    }
  }

  function renderBody() {
    const body = $('#main-body');
    body.innerHTML = '';

    if (!state.clubs.length) {
      body.appendChild(el('div', { class: 'muted' }, 'No clubs yet.'));
      return;
    }

    // Big bold label so there's no ambiguity about which week is on screen
    body.appendChild(el('div', { class: 'week-heading' },
      state.tab === 'next' ? 'Next work week' : 'Current work week'));

    // Week tabs: This week / Next week
    const tabs = el('div', { class: 'week-tabs' });
    tabs.appendChild(el('button', {
      class: 'week-tab' + (state.tab === 'current' ? ' active' : ''),
      onclick: () => switchTab('current'),
    }, 'This week'));
    tabs.appendChild(el('button', {
      class: 'week-tab' + (state.tab === 'next' ? ' active' : ''),
      onclick: () => switchTab('next'),
    }, 'Next week'));
    tabs.appendChild(el('div', { class: 'week-tabs-range muted' }, fmtWeek(state.weekStart)));

    // Filter input so dock staff can type their name and see only their row
    const filterInput = el('input', {
      type: 'search',
      class: 'name-filter',
      placeholder: 'Filter by name…',
      autocomplete: 'off',
    });
    filterInput.value = state.filter || '';
    filterInput.addEventListener('input', () => {
      state.filter = filterInput.value;
      applyNameFilter();
    });
    tabs.appendChild(filterInput);

    body.appendChild(tabs);

    for (const club of state.clubs) {
      body.appendChild(renderClubSection(club));
    }

    // Apply any existing filter after new rows are rendered
    applyNameFilter();
  }

  // Toggle row visibility based on state.filter. Runs against the live DOM
  // (no re-render) so the user keeps focus in the filter box while typing.
  function applyNameFilter() {
    const q = (state.filter || '').trim().toLowerCase();
    document.querySelectorAll('.schedule-table').forEach(table => {
      const rows = Array.from(table.querySelectorAll('tbody tr'));
      let anyVisibleInGroup = false;
      let lastDivider = null;
      const finalizeGroup = () => {
        if (lastDivider) lastDivider.style.display = anyVisibleInGroup ? '' : 'none';
      };
      for (const row of rows) {
        if (row.classList.contains('team-divider')) {
          finalizeGroup();
          lastDivider = row;
          anyVisibleInGroup = false;
          continue;
        }
        const name = (row.getAttribute('data-emp-name') || '').toLowerCase();
        if (!name) continue; // non-employee rows (shouldn't happen inside tbody but be safe)
        const match = !q || name.includes(q);
        row.style.display = match ? '' : 'none';
        if (match) anyVisibleInGroup = true;
      }
      finalizeGroup();
    });
  }

  function renderClubSection(club) {
    const data = state.clubData[club.id];
    const wrap = el('section', { class: 'club-section' });

    const header = el('div', { class: 'club-header' });
    header.appendChild(el('h2', {}, club.name));
    if (canEditClub(club.id) || (isLoggedIn() && state.me.club_id === club.id)) {
      header.appendChild(el('span', { class: 'edit-chip' },
        isOwner() ? 'Owner edit' : `Editing ${state.me.team || ''}`.trim()));
    }
    header.appendChild(el('div', { class: 'spacer' }));
    if (isLoggedIn() && (isOwner() || canEditClub(club.id))) {
      header.appendChild(el('button', { onclick: () => openRosterModal(club) }, 'Manage roster'));
    }
    wrap.appendChild(header);

    if (!data) {
      wrap.appendChild(el('div', { class: 'muted', style: 'padding:12px;' }, 'No schedule loaded.'));
      return wrap;
    }

    // Last updated marker (plain English summary of the most recent edit).
    // Sourced from the audit log via the schedule API response.
    if (data.last_update) {
      const lu = data.last_update;
      wrap.appendChild(el('div', { class: 'last-update' }, [
        el('span', { class: 'muted' }, 'Last updated '),
        el('span', {}, fmtRelative(lu.created_at)),
        el('span', { class: 'muted' }, ' by '),
        el('span', {}, lu.user_label || 'unknown'),
        el('span', { class: 'muted' }, ' — '),
        el('span', {}, describeAuditEntry({
          action: lu.action,
          details: lu.details || {},
          club_name: club.name,
          team: (lu.details || {}).team || null,
        })),
      ]));
    }

    wrap.appendChild(buildScheduleGrid(club, data));
    // Totals are a management-only view. Regular staff visiting without an
    // account just see the schedule and the notes; hide the totals table.
    if (isLoggedIn()) {
      wrap.appendChild(buildTotalsGrid(club, data));
    }

    const editableNotes = canEditClub(club.id);
    const notesWrap = el('div', { class: 'notes' });
    notesWrap.appendChild(el('label', {}, 'Notes'));
    const ta = el('textarea', {
      placeholder: editableNotes ? 'Notes for this week…' : '(read-only)',
    });
    ta.value = data.schedule.notes || '';
    ta.disabled = !editableNotes;
    if (editableNotes) {
      let notesTimer;
      ta.addEventListener('input', () => {
        clearTimeout(notesTimer);
        notesTimer = setTimeout(async () => {
          try {
            await api(`/api/schedules/${data.schedule.id}/notes`, { method: 'PATCH', body: { notes: ta.value } });
          } catch (e) { toast(e.message, 'err'); }
        }, 400);
      });
    }
    notesWrap.appendChild(ta);
    wrap.appendChild(notesWrap);

    return wrap;
  }

  function buildScheduleGrid(club, data) {
    const wrap = el('div', { class: 'schedule-wrap' });
    const table = el('table', { class: 'schedule-table' });

    const thead = el('thead');
    const headerRow = el('tr');
    headerRow.appendChild(el('th', {}, 'Employee'));
    DAYS.forEach((d, i) => {
      const date = new Date(state.weekStart + 'T00:00:00'); date.setDate(date.getDate() + i);
      headerRow.appendChild(el('th', {}, `${d} ${date.getMonth() + 1}/${date.getDate()}`));
    });
    thead.appendChild(headerRow);
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

    sortedKeys.forEach((teamName) => {
      if (showDividers && teamName) {
        const divider = el('tr', { class: 'team-divider' });
        divider.appendChild(el('td', { colspan: 8 }, teamName));
        tbody.appendChild(divider);
      }

      for (const emp of groups.get(teamName)) {
        const editable = canEditEmployee(emp);
        const row = el('tr', { class: teamClass(emp.team), 'data-emp-name': emp.name });
        row.appendChild(el('td', { class: 'name-cell' }, emp.name));
        for (let d = 0; d < 7; d++) {
          const td = el('td', { class: 'day-cell' });
          const cellVal = (data.shifts[emp.id] && data.shifts[emp.id][d]) || '';
          if (editable) {
            const input = el('input', { type: 'text', placeholder: '—' });
            input.value = cellVal;
            input.style.color = cellColorFor(cellVal);
            let t;
            input.addEventListener('input', () => {
              input.style.color = cellColorFor(input.value);
              clearTimeout(t);
              t = setTimeout(async () => {
                try {
                  await api(`/api/schedules/${data.schedule.id}/cell`, {
                    method: 'PATCH',
                    body: { employee_id: emp.id, day_index: d, shift_text: input.value },
                  });
                  data.shifts[emp.id] = data.shifts[emp.id] || {};
                  data.shifts[emp.id][d] = input.value;
                } catch (err) { toast(err.message, 'err'); }
              }, 350);
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
    const wrap = el('div', { class: 'totals-wrap' });
    wrap.appendChild(el('div', { class: 'totals-label' }, 'Staffing by location'));

    const table = el('table', { class: 'totals-table' });
    const thead = el('thead');
    const hrow = el('tr');
    hrow.appendChild(el('th', {}, 'Location'));
    DAYS.forEach((d, i) => {
      const date = new Date(state.weekStart + 'T00:00:00'); date.setDate(date.getDate() + i);
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
        const val = (data.totals && data.totals[loc] && data.totals[loc][d]) || '';
        if (editable) {
          const input = el('input', { type: 'text', placeholder: '—', inputmode: 'numeric' });
          input.value = val;
          let t;
          input.addEventListener('input', () => {
            clearTimeout(t);
            t = setTimeout(async () => {
              try {
                await api(`/api/schedules/${data.schedule.id}/total`, {
                  method: 'PATCH',
                  body: { location: loc, day_index: d, count_text: input.value },
                });
                data.totals = data.totals || {};
                data.totals[loc] = data.totals[loc] || {};
                data.totals[loc][d] = input.value;
              } catch (err) { toast(err.message, 'err'); }
            }, 350);
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
    let entries;
    try { entries = await api('/api/audit'); }
    catch (e) { container.appendChild(el('div', { class: 'error' }, e.message)); return; }

    if (!entries.length) {
      container.appendChild(el('div', { class: 'muted' }, 'No activity yet.'));
      return;
    }

    const list = el('div', { class: 'activity-list' });
    entries.forEach(e => {
      const row = el('div', { class: 'activity-row' });
      row.appendChild(el('div', { class: 'activity-when' }, fmtRelative(e.created_at)));
      row.appendChild(el('div', { class: 'activity-who muted' }, e.user_label));
      row.appendChild(el('div', { class: 'activity-what' }, describeAuditEntry(e)));
      list.appendChild(row);
    });
    container.appendChild(list);
  }

  function describeAuditEntry(e) {
    const d = e.details || {};
    const club = e.club_name || '';
    const team = e.team ? ` (${e.team})` : '';
    switch (e.action) {
      case 'cell_edit': {
        const oldV = d.old_value ? `"${d.old_value}"` : '(empty)';
        const newV = d.new_value ? `"${d.new_value}"` : '(empty)';
        const day = DAYS[d.day_index] || `day ${d.day_index}`;
        return `edited ${d.employee_name}'s ${day} (${d.week_start}) shift: ${oldV} → ${newV}${team ? ' ' + team : ''}`;
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
