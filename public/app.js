/* Schedule Dashboard — frontend SPA */
(function () {
  'use strict';

  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const state = {
    clubs: [],
    currentClubId: null,
    weekStart: null,
    schedule: null,
    employees: [],
    shifts: {},
  };

  // -------- utils --------
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
  function teamsForCurrentClub() {
    const club = state.clubs.find(c => c.id === state.currentClubId);
    if (club && club.name === 'Jacksonville') return ['Julington Creek', 'Jacksonville Beach', 'Shared'];
    return ['Main', 'Shared'];
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
      state.clubs = await api('/api/clubs');
      if (!state.currentClubId && state.clubs.length) state.currentClubId = state.clubs[0].id;
      if (!state.weekStart) state.weekStart = mondayOf(new Date());
      await renderScheduleTab();
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

  // -------- schedule tab --------
  async function renderScheduleTab() {
    const body = $('#main-body');
    body.innerHTML = '';

    if (!state.clubs.length) {
      body.appendChild(el('div', { class: 'muted' }, 'No clubs yet.'));
      return;
    }

    const toolbar = el('div', { class: 'toolbar' });
    // Club picker
    const select = el('select', {
      onchange: async (e) => { state.currentClubId = Number(e.target.value); await loadSchedule(); renderScheduleTab(); },
    });
    state.clubs.forEach(c => {
      const opt = el('option', { value: c.id }, c.name);
      if (c.id === state.currentClubId) opt.setAttribute('selected', 'selected');
      select.appendChild(opt);
    });
    toolbar.appendChild(el('label', {}, ['Club', select]));

    // Week nav
    toolbar.appendChild(el('button', { onclick: async () => { state.weekStart = addDays(state.weekStart, -7); await loadSchedule(); renderScheduleTab(); } }, '← Prev week'));
    toolbar.appendChild(el('div', { class: 'muted' }, state.weekStart ? fmtWeek(state.weekStart) : ''));
    toolbar.appendChild(el('button', { onclick: async () => { state.weekStart = addDays(state.weekStart, 7); await loadSchedule(); renderScheduleTab(); } }, 'Next week →'));
    toolbar.appendChild(el('button', { class: 'ghost', onclick: async () => { state.weekStart = mondayOf(new Date()); await loadSchedule(); renderScheduleTab(); } }, 'This week'));

    toolbar.appendChild(el('div', { class: 'spacer' }));

    // Manage roster button
    toolbar.appendChild(el('button', { onclick: openRosterModal }, 'Manage roster'));

    body.appendChild(toolbar);

    // Load data if needed
    if (!state.schedule || state.schedule.club_id !== state.currentClubId || state.schedule.week_start !== state.weekStart) {
      await loadSchedule();
    }

    // Status bar
    const statusBar = el('div', { class: 'toolbar' });
    statusBar.appendChild(el('span', { class: `status-pill ${state.schedule.status}` }, state.schedule.status.toUpperCase()));
    statusBar.appendChild(el('div', { class: 'spacer' }));

    if (state.schedule.status === 'draft') {
      statusBar.appendChild(el('button', { class: 'primary', onclick: () => transition('submit') }, 'Submit for review'));
      statusBar.appendChild(el('button', { onclick: () => transition('post') }, 'Post'));
    } else if (state.schedule.status === 'submitted') {
      statusBar.appendChild(el('button', { class: 'primary', onclick: () => transition('post') }, 'Approve & Post'));
      statusBar.appendChild(el('button', { onclick: () => transition('recall') }, 'Recall'));
    } else if (state.schedule.status === 'posted') {
      statusBar.appendChild(el('button', { onclick: () => transition('return') }, 'Return to draft'));
    }
    body.appendChild(statusBar);

    // Grid
    body.appendChild(buildScheduleGrid(true));

    // Notes
    const notesWrap = el('div', { class: 'notes' });
    notesWrap.appendChild(el('label', {}, 'Notes'));
    const ta = el('textarea', {
      placeholder: 'Notes for this week…',
    });
    ta.value = state.schedule.notes || '';
    let notesTimer;
    ta.addEventListener('input', () => {
      clearTimeout(notesTimer);
      notesTimer = setTimeout(async () => {
        try {
          await api(`/api/schedules/${state.schedule.id}/notes`, { method: 'PATCH', body: { notes: ta.value } });
        } catch (e) { toast(e.message, 'err'); }
      }, 400);
    });
    notesWrap.appendChild(ta);
    body.appendChild(notesWrap);
  }

  async function loadSchedule() {
    const data = await api(`/api/clubs/${state.currentClubId}/schedule?week=${state.weekStart}`);
    state.schedule = data.schedule;
    state.employees = data.employees;
    state.shifts = data.shifts || {};
  }

  function buildScheduleGrid(editable) {
    const wrap = el('div', { class: 'schedule-wrap' });
    const table = el('table', { class: 'schedule-table' });

    // header
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
    for (const e of state.employees) {
      const key = e.team || 'Main';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }
    // team ordering
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
          const input = el('input', { type: 'text', placeholder: '—' });
          input.value = (state.shifts[emp.id] && state.shifts[emp.id][d]) || '';
          input.disabled = !editable;
          let t;
          input.addEventListener('input', () => {
            clearTimeout(t);
            t = setTimeout(async () => {
              try {
                await api(`/api/schedules/${state.schedule.id}/cell`, {
                  method: 'PATCH',
                  body: { employee_id: emp.id, day_index: d, shift_text: input.value },
                });
                state.shifts[emp.id] = state.shifts[emp.id] || {};
                state.shifts[emp.id][d] = input.value;
              } catch (err) { toast(err.message, 'err'); }
            }, 350);
          });
          td.appendChild(input);
          row.appendChild(td);
        }
        tbody.appendChild(row);
      }
    });

    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  async function transition(kind) {
    try {
      await api(`/api/schedules/${state.schedule.id}/${kind}`, { method: 'POST' });
      await loadSchedule();
      renderScheduleTab();
      toast('Updated');
    } catch (e) { toast(e.message, 'err'); }
  }

  // -------- roster modal --------
  async function openRosterModal() {
    const content = el('div');
    content.appendChild(el('h2', {}, 'Manage roster'));

    async function refresh() {
      const emps = await api(`/api/clubs/${state.currentClubId}/employees`);
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
        const teamOpts = [...teamsForCurrentClub(), ''];
        // Ensure the employee's current team is always in the list
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
        const saveBtn = el('button', {
          onclick: async () => {
            try {
              await api(`/api/employees/${e.id}`, { method: 'PATCH', body: { name: nameInput.value, team: teamSelect.value } });
              toast('Saved');
              refresh();
            } catch (err) { toast(err.message, 'err'); }
          },
        }, 'Save');
        const archiveBtn = el('button', {
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
        }, e.archived ? 'Unarchive' : 'Archive');
        actions.appendChild(saveBtn);
        actions.appendChild(document.createTextNode(' '));
        actions.appendChild(archiveBtn);
        tr.appendChild(actions);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      list.appendChild(table);
    }

    const list = el('div');
    content.appendChild(list);

    // Add new
    const addWrap = el('div', { class: 'toolbar', style: 'margin-top:14px;' });
    const nameIn = el('input', { placeholder: 'New employee name' });
    const teamIn = el('select');
    teamsForCurrentClub().forEach(t => teamIn.appendChild(el('option', { value: t }, t)));
    addWrap.appendChild(nameIn);
    addWrap.appendChild(teamIn);
    addWrap.appendChild(el('button', {
      class: 'primary',
      onclick: async () => {
        if (!nameIn.value.trim()) return;
        try {
          await api(`/api/clubs/${state.currentClubId}/employees`, { method: 'POST', body: { name: nameIn.value.trim(), team: teamIn.value } });
          nameIn.value = '';
          refresh();
        } catch (err) { toast(err.message, 'err'); }
      },
    }, 'Add'));
    content.appendChild(addWrap);

    content.appendChild(el('div', { class: 'modal-actions' }, [
      el('button', { onclick: () => { closeModal(); loadSchedule().then(renderScheduleTab); } }, 'Close'),
    ]));

    openModal(content);
    refresh();
  }

  // kickoff
  document.addEventListener('DOMContentLoaded', bootstrap);
})();
