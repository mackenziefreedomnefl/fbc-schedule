/* Schedule Dashboard — frontend SPA
 *
 * UX model:
 * - Unauthenticated: see ALL clubs stacked in a read-only combined view
 * - Sign in (per club, with a password) → edit that club's schedule and roster
 * - Everyone can navigate weeks and view any club's data at any time
 */
(function () {
  'use strict';

  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const state = {
    me: { club_id: null, name: null },   // current auth state
    clubs: [],                            // [{ id, name, has_password }]
    weekStart: null,                      // YYYY-MM-DD
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
    if (clubName === 'Jacksonville') return ['Julington Creek', 'Jacksonville Beach', 'Shared'];
    return ['Main', 'Shared'];
  }

  function canEdit(clubId) {
    return state.me.club_id && Number(state.me.club_id) === Number(clubId);
  }

  // -------- modal --------
  function openModal(content) {
    const root = $('#modal-root');
    root.innerHTML = '';
    const backdrop = el('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) closeModal(); } });
    const modal = el('div', { class: 'modal' });
    modal.appendChild(content);
    backdrop.appendChild(modal);
    root.appendChild(backdrop);
  }
  function closeModal() { $('#modal-root').innerHTML = ''; }

  // -------- bootstrap --------
  async function bootstrap() {
    try {
      const [me, clubs] = await Promise.all([api('/api/me'), api('/api/clubs')]);
      state.me = me || { club_id: null };
      state.clubs = clubs || [];
      if (!state.weekStart) state.weekStart = mondayOf(new Date());
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

  // -------- render --------
  async function render() {
    renderTopbar();
    await loadAllSchedules();
    renderBody();
  }

  function renderTopbar() {
    const chip = $('#user-chip');
    chip.innerHTML = '';
    if (state.me.club_id) {
      chip.appendChild(el('span', { class: 'muted' }, `Signed in: ${state.me.name}`));
      chip.appendChild(el('button', { class: 'ghost', onclick: openChangePasswordModal }, 'Change password'));
      chip.appendChild(el('button', {
        class: 'ghost',
        onclick: async () => {
          try { await api('/api/logout', { method: 'POST' }); } catch (_) {}
          state.me = { club_id: null };
          state.clubData = {};
          await render();
          toast('Signed out');
        },
      }, 'Sign out'));
    } else {
      chip.appendChild(el('button', { class: 'primary', onclick: openLoginModal }, 'Manager sign in'));
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

    // Week navigator (applies to all clubs)
    const toolbar = el('div', { class: 'toolbar' });
    toolbar.appendChild(el('button', {
      onclick: async () => { state.weekStart = addDays(state.weekStart, -7); await loadAllSchedules(); renderBody(); },
    }, '← Prev week'));
    toolbar.appendChild(el('div', { class: 'muted', style: 'font-weight:600;' }, fmtWeek(state.weekStart)));
    toolbar.appendChild(el('button', {
      onclick: async () => { state.weekStart = addDays(state.weekStart, 7); await loadAllSchedules(); renderBody(); },
    }, 'Next week →'));
    toolbar.appendChild(el('button', {
      class: 'ghost',
      onclick: async () => { state.weekStart = mondayOf(new Date()); await loadAllSchedules(); renderBody(); },
    }, 'This week'));
    body.appendChild(toolbar);

    // Render each club stacked
    for (const club of state.clubs) {
      body.appendChild(renderClubSection(club));
    }
  }

  function renderClubSection(club) {
    const data = state.clubData[club.id];
    const wrap = el('section', { class: 'club-section' });

    // Header with club name and edit/roster controls
    const header = el('div', { class: 'club-header' });
    header.appendChild(el('h2', {}, club.name));
    const editable = canEdit(club.id);
    if (editable) {
      header.appendChild(el('span', { class: 'edit-chip' }, 'Editing'));
      header.appendChild(el('div', { class: 'spacer' }));
      header.appendChild(el('button', {
        onclick: () => openRosterModal(club),
      }, 'Manage roster'));
    } else {
      header.appendChild(el('div', { class: 'spacer' }));
      if (state.me.club_id == null) {
        header.appendChild(el('button', {
          class: 'ghost',
          onclick: () => openLoginModal(club.id),
        }, `Sign in to edit ${club.name}`));
      }
    }
    wrap.appendChild(header);

    if (!data) {
      wrap.appendChild(el('div', { class: 'muted', style: 'padding:12px;' }, 'No schedule loaded.'));
      return wrap;
    }

    wrap.appendChild(buildScheduleGrid(club, data, editable));

    // Notes
    const notesWrap = el('div', { class: 'notes' });
    notesWrap.appendChild(el('label', {}, 'Notes'));
    const ta = el('textarea', {
      placeholder: editable ? 'Notes for this week…' : '(sign in to edit)',
    });
    ta.value = data.schedule.notes || '';
    ta.disabled = !editable;
    if (editable) {
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

  function buildScheduleGrid(club, data, editable) {
    const wrap = el('div', { class: 'schedule-wrap' });
    const table = el('table', { class: 'schedule-table' });

    // header row
    const thead = el('thead');
    const headerRow = el('tr');
    headerRow.appendChild(el('th', {}, 'Employee'));
    DAYS.forEach((d, i) => {
      const date = new Date(state.weekStart + 'T00:00:00'); date.setDate(date.getDate() + i);
      headerRow.appendChild(el('th', {}, `${d} ${date.getMonth() + 1}/${date.getDate()}`));
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // group by team preserving sort_order
    const tbody = el('tbody');
    const groups = new Map();
    for (const e of data.employees) {
      const key = e.team || 'Main';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }
    const order = ['Julington Creek', 'Main', 'Jacksonville Beach', 'Team 2', 'Shared'];
    const sortedKeys = Array.from(groups.keys()).sort((a, b) => {
      const ai = order.indexOf(a); const bi = order.indexOf(b);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    sortedKeys.forEach((teamName) => {
      const divider = el('tr', { class: 'team-divider' });
      divider.appendChild(el('td', { colspan: 8 }, teamName));
      tbody.appendChild(divider);

      for (const emp of groups.get(teamName)) {
        const row = el('tr', { class: teamClass(emp.team) });
        row.appendChild(el('td', { class: 'name-cell' }, emp.name));
        for (let d = 0; d < 7; d++) {
          const td = el('td', { class: 'day-cell' });
          const cellVal = (data.shifts[emp.id] && data.shifts[emp.id][d]) || '';
          if (editable) {
            const input = el('input', { type: 'text', placeholder: '—' });
            input.value = cellVal;
            let t;
            input.addEventListener('input', () => {
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
            td.appendChild(el('div', { class: 'day-readonly' }, cellVal || '—'));
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

  // -------- login modal --------
  function openLoginModal(preselectClubId) {
    const content = el('div');
    content.appendChild(el('h2', {}, 'Manager sign in'));
    content.appendChild(el('p', { class: 'muted' }, 'Pick your club and enter its password to edit the schedule.'));

    const clubSel = el('select');
    state.clubs.forEach(c => {
      const opt = el('option', { value: c.id }, c.name + (c.has_password ? '' : ' (no password set)'));
      if (preselectClubId && Number(c.id) === Number(preselectClubId)) opt.setAttribute('selected', 'selected');
      clubSel.appendChild(opt);
    });
    const passIn = el('input', { type: 'password', placeholder: 'password', autocomplete: 'current-password' });
    const errDiv = el('div', { class: 'error' });

    const submit = async () => {
      errDiv.textContent = '';
      try {
        const me = await api('/api/login', {
          method: 'POST',
          body: { club_id: Number(clubSel.value), password: passIn.value },
        });
        state.me = me;
        closeModal();
        await render();
        toast(`Signed in to ${me.name}`);
      } catch (e) { errDiv.textContent = e.message; }
    };
    passIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

    content.appendChild(el('label', {}, ['Club', clubSel]));
    content.appendChild(el('label', {}, ['Password', passIn]));
    content.appendChild(errDiv);
    content.appendChild(el('div', { class: 'modal-actions' }, [
      el('button', { onclick: closeModal }, 'Cancel'),
      el('button', { class: 'primary', onclick: submit }, 'Sign in'),
    ]));
    openModal(content);
    setTimeout(() => passIn.focus(), 50);
  }

  function openChangePasswordModal() {
    const content = el('div');
    content.appendChild(el('h2', {}, 'Change password'));
    content.appendChild(el('p', { class: 'muted' }, `Club: ${state.me.name}`));
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
            await api(`/api/clubs/${state.me.club_id}/password`, {
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
        const tr = el('tr');
        const nameInput = el('input', { value: e.name });
        const teamSelect = el('select');
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
        tr.appendChild(actions);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      list.appendChild(table);
    }

    const list = el('div');
    content.appendChild(list);

    const addWrap = el('div', { class: 'toolbar', style: 'margin-top:14px;' });
    const nameIn = el('input', { placeholder: 'New employee name' });
    const teamIn = el('select');
    teamsForClub(club.name).forEach(t => teamIn.appendChild(el('option', { value: t }, t)));
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

    content.appendChild(el('div', { class: 'modal-actions' }, [
      el('button', {
        onclick: async () => { closeModal(); await loadAllSchedules(); renderBody(); },
      }, 'Close'),
    ]));

    openModal(content);
    refresh();
  }

  // kickoff
  document.addEventListener('DOMContentLoaded', bootstrap);
})();
