/* ═════════════════════════════════════════════════════════════════════════
   Type-ahead search component (vanilla, no deps)

   Usage:
     const ta = Typeahead.attach({
       inputEl:    document.getElementById('pitcher-input'),
       items:      arrayOfPlayerRows,
       matchFn:    (row, q) => row.name.toLowerCase().includes(q),
       renderRow:  (row, query) => htmlString,
       onSelect:   (row) => { ... },
       maxResults: 15,
       initialPick: defaultRowOrNull,
     });
     ta.update(newItems);    // swap dataset (e.g., when filtering)
     ta.setSelected(row);    // programmatically pick
   ═════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  function escHTML(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Lightweight substring match that also handles diacritics by stripping them.
  function norm(s) {
    return (s || '').toString().toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  function highlight(text, query) {
    if (!query) return escHTML(text);
    const t = text || '';
    const tn = norm(t);
    const qn = norm(query);
    const i = tn.indexOf(qn);
    if (i < 0) return escHTML(t);
    return escHTML(t.slice(0, i))
      + '<mark>' + escHTML(t.slice(i, i + qn.length)) + '</mark>'
      + escHTML(t.slice(i + qn.length));
  }

  function attach(cfg) {
    const inputEl = cfg.inputEl;
    if (!inputEl) throw new Error('Typeahead: inputEl required');
    const maxResults = cfg.maxResults || 15;

    let items = cfg.items || [];
    let filtered = [];
    let activeIdx = -1;
    let lastQuery = '';
    let isOpen = false;

    // Build dropdown panel right after the input
    const panel = document.createElement('div');
    panel.className = 'ta-panel';
    panel.setAttribute('role', 'listbox');
    panel.style.display = 'none';
    inputEl.insertAdjacentElement('afterend', panel);

    // ARIA wiring
    inputEl.setAttribute('autocomplete', 'off');
    inputEl.setAttribute('autocorrect', 'off');
    inputEl.setAttribute('autocapitalize', 'off');
    inputEl.setAttribute('spellcheck', 'false');
    inputEl.setAttribute('role', 'combobox');
    inputEl.setAttribute('aria-autocomplete', 'list');
    inputEl.setAttribute('aria-expanded', 'false');

    function defaultMatch(row, q) {
      return norm(row.name).includes(q) || norm(row.team || '').includes(q);
    }
    const matchFn = cfg.matchFn || defaultMatch;
    const renderRow = cfg.renderRow || ((row, q) => `
      <div class="ta-row-name">${highlight(row.name, q)}</div>
      <div class="ta-row-meta">${escHTML(row.team || '')}</div>
    `);

    function update(newItems) { items = newItems || []; }

    function open() {
      if (!filtered.length) { close(); return; }
      panel.style.display = '';
      inputEl.setAttribute('aria-expanded', 'true');
      isOpen = true;
    }
    function close() {
      panel.style.display = 'none';
      inputEl.setAttribute('aria-expanded', 'false');
      isOpen = false;
      activeIdx = -1;
    }

    function refresh() {
      const q = norm(inputEl.value.trim());
      lastQuery = q;
      filtered = q ? items.filter(r => matchFn(r, q)).slice(0, maxResults)
                   : items.slice(0, maxResults);
      activeIdx = filtered.length ? 0 : -1;
      render();
      if (inputEl.value.trim().length > 0) open(); else close();
    }

    function render() {
      panel.innerHTML = filtered.map((r, i) =>
        `<div class="ta-row ${i === activeIdx ? 'ta-active' : ''}"
              role="option" aria-selected="${i === activeIdx}" data-i="${i}">
           ${renderRow(r, lastQuery)}
         </div>`
      ).join('');
    }

    function pick(i) {
      const row = filtered[i];
      if (!row) return;
      // Show a friendly display label in the input
      inputEl.value = row.name + (row.team ? ' · ' + row.team : '');
      close();
      cfg.onSelect && cfg.onSelect(row);
    }

    inputEl.addEventListener('input', refresh);
    inputEl.addEventListener('focus', () => {
      if (filtered.length || inputEl.value.length > 0) refresh();
    });
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        if (!isOpen) refresh();
        activeIdx = Math.min(filtered.length - 1, activeIdx + 1);
        render();
        const r = panel.querySelector('.ta-active');
        r && r.scrollIntoView({ block: 'nearest' });
        e.preventDefault();
      } else if (e.key === 'ArrowUp') {
        activeIdx = Math.max(0, activeIdx - 1);
        render();
        const r = panel.querySelector('.ta-active');
        r && r.scrollIntoView({ block: 'nearest' });
        e.preventDefault();
      } else if (e.key === 'Enter') {
        if (activeIdx >= 0) { pick(activeIdx); e.preventDefault(); }
      } else if (e.key === 'Escape') {
        close();
      }
    });

    panel.addEventListener('mousedown', (e) => {
      // mousedown not click — fires before input blur, prevents premature close
      const t = e.target.closest('.ta-row');
      if (!t) return;
      pick(parseInt(t.dataset.i, 10));
      e.preventDefault();
    });

    document.addEventListener('click', (e) => {
      if (e.target !== inputEl && !panel.contains(e.target)) close();
    });

    // Optional initial pick
    if (cfg.initialPick) {
      inputEl.value = cfg.initialPick.name
        + (cfg.initialPick.team ? ' · ' + cfg.initialPick.team : '');
    }

    return {
      update,
      setSelected(row) {
        if (!row) { inputEl.value = ''; return; }
        inputEl.value = row.name + (row.team ? ' · ' + row.team : '');
        close();
      },
      clear() { inputEl.value = ''; close(); },
      destroy() { panel.remove(); },
    };
  }

  window.Typeahead = { attach };
})();
