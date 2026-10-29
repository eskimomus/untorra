/* Authoring tools — not part of the game.
 *
 *   Shift+C   collider editor: coloured boxes over the screen, one per
 *             entry in this node's COLLIDER_DATA actions array. Drag and
 *             resize them, then export; the boxes are turned into the
 *             160x120 collider PNGs offline (tools/rects_to_colliders.py).
 *   Shift+N   navigation-marker editor: the same reticles the game shows
 *             while the right button is held, draggable, with buttons to
 *             centre them on the screen's axes.
 *
 * Both seed themselves from what already exists — the painted collider
 * map's region boxes and centroids — so a screen opens with something
 * sensible to nudge rather than an empty frame. Work is kept in
 * localStorage as you go and leaves as one JSON file.
 */
var editorMode = null;   // 'collider' | 'nav' | null

(() => {
  'use strict';

  const STORE = 'untorra-editor-v1';
  // Everything is stored as a fraction of the frame; the fields speak the
  // 640x480 design pixels the mockups are drawn in.
  const SRC = { w: 640, h: 480 };
  // `dirty` is the set of screens whose box shapes were actually edited.
  // Opening a screen seeds its boxes from the painted map, and those seeds
  // are bounding rectangles — exporting them for a screen nobody reshaped
  // would flatten its hand-painted regions into boxes for no reason.
  const edit = { rects: {}, marks: {}, actions: {}, dirty: {}, layers: {}, deletedMarks: {}, freeMarks: {} };
  const baseFreeMarks = JSON.parse(JSON.stringify(NAV_FREE_MARKERS));
  const baseMarkerHides = JSON.parse(JSON.stringify(NAV_MARKER_HIDES));
  function markerHidden(key, idx) {
    const overrides = edit.deletedMarks[key] || {};
    return Object.prototype.hasOwnProperty.call(overrides, idx)
      ? !!overrides[idx] : !!((baseMarkerHides[key] || baseMarkerHides[navMarkerBaseKey(key)] || {})[idx]);
  }
  function syncMarkerHides() {
    Object.keys(NAV_FREE_MARKERS).forEach(k => { delete NAV_FREE_MARKERS[k]; });
    Object.assign(NAV_FREE_MARKERS, JSON.parse(JSON.stringify(baseFreeMarks)), edit.freeMarks);
    Object.keys(NAV_MARKER_HIDES).forEach(k => { delete NAV_MARKER_HIDES[k]; });
    const keys = new Set([...Object.keys(baseMarkerHides), ...Object.keys(edit.deletedMarks)]);
    keys.forEach(k => { NAV_MARKER_HIDES[k] = Object.assign({}, baseMarkerHides[k] || baseMarkerHides[navMarkerBaseKey(k)], edit.deletedMarks[k]); });
  }
  const markDirty = () => { edit.dirty[curKey()] = true; };
  let sel = null;                    // { idx, n } in collider mode, { idx } in nav mode
  let guides = { xs: [], ys: [] };   // snap lines being held to, drawn while dragging
  let clip = null;                   // one cut/copied box
  const history = { past: [], future: [] };
  let lastNudge = 0;
  const SNAP_PX = 6;                 // how close an edge has to come to stick
  let layer = null, panel = null, listEl = null, pickEl = null, titleEl = null, noteEl = null;
  let coordsEl = null;

  const CURSOR_COLOR = {
    front: '#3f84e0', back: '#e08a3f', left: '#4fc24f',
    right: '#4fc24f', grab: '#e04646', star: '#e04646',
  };
  const colorOf = a => (a && CURSOR_COLOR[a.cursor]) || '#b452c8';
  const labelOf = a => a.free ? 'свободная метка' : a.to ? '→ ' + a.to
                     : a.action ? '⚙ ' + a.action
                     : ('sound' in a) ? '♪ ' + (a.sound || '') : '?';

  const curKey = () => editorMode === 'nav' ? navMarkerKeyFor(state.current) : colliderKeyFor(state.current);

  // What the editor works with: the actions the game already ships for this
  // screen, with anything drafted here laid over the top. A screen the game
  // has no collider for at all starts from nothing but the empty slot 0.
  function actionsFor(key) {
    const baseKey = navMarkerBaseKey(key);
    const base = (COLLIDER_DATA[baseKey] && COLLIDER_DATA[baseKey].actions) || [null];
    const out = base.slice();
    const extra = edit.actions[navMarkerBaseKey(key)] || {};
    Object.keys(extra).forEach(i => { out[+i] = extra[i]; });
    if (editorMode === 'nav') Object.entries(freeMarksFor(key)).forEach(([id, m]) => {
      out[id] = { cursor: m.cursor, free: true };
    });
    return out;
  }
  const baseAction = (key, i) => (((COLLIDER_DATA[navMarkerBaseKey(key)] || {}).actions) || [])[i];
  const isDrafted = (key, i) => !!(edit.actions[key] && edit.actions[key][i]);
  const isNew = (key, i) => isDrafted(key, i) && !baseAction(key, i);
  const isEdited = (key, i) => isDrafted(key, i) && !!baseAction(key, i);

  // Painting order, lowest priority first: where two zones overlap the one
  // painted later wins, so "higher layer" means later. Without an explicit
  // order the index is the order, which is how the maps were generated.
  function layerOrder(key, actions) {
    const L = edit.layers[key] || {};
    const at = i => (L[i] === undefined ? i : L[i]);
    return actions.map((a, i) => (a ? i : -1)).filter(i => i > 0)
                  .sort((a, b) => at(a) - at(b) || a - b);
  }

  // Move the selected zone one step through that order. Re-numbering the
  // whole stack afterwards keeps the stored values dense and independent
  // of the indices, which must not be shuffled — an index is the pixel
  // value in the map.
  function moveLayer(dir) {
    const key = curKey();
    if (!sel || editorMode !== 'collider') return;
    const order = layerOrder(key, actionsFor(key));
    const pos = order.indexOf(sel.idx);
    const to = pos + (dir === 'up' ? 1 : -1);
    if (pos < 0 || to < 0 || to >= order.length) return;
    snapshot();
    order[pos] = order[to];
    order[to] = sel.idx;
    edit.layers[key] = {};
    order.forEach((i, n) => { edit.layers[key][i] = n; });
    markDirty();
    save();
    refresh();
  }

  // Change one field of whatever action is selected — the game's own as
  // readily as a drafted one. Everything else on the action is carried
  // over, so an interaction keeps its `action`/`sound`/`flavor`, and an
  // override that ends up matching the original is dropped rather than
  // exported as a no-op.
  function editAction(field, value) {
    const key = curKey();
    if (!sel) return;
    const cur = actionsFor(key)[sel.idx];
    if (!cur) return;
    if (field === 'to' && !cur.to) return;   // never turn an interaction into a move
    if (cur[field] === value) return;
    snapshot();
    const next = Object.assign({}, cur);
    next[field] = value;
    const orig = baseAction(key, sel.idx);
    edit.actions[key] = edit.actions[key] || {};
    if (orig && JSON.stringify(next) === JSON.stringify(orig)) delete edit.actions[key][sel.idx];
    else edit.actions[key][sel.idx] = next;
    save();
    refresh();
  }
  const stageRect = () => document.getElementById('stage').getBoundingClientRect();

  function load() {
    try {
      const raw = localStorage.getItem(STORE);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d.rects) edit.rects = d.rects;
      if (d.marks) edit.marks = d.marks;
      if (d.actions) edit.actions = d.actions;
      if (d.dirty) edit.dirty = d.dirty;
      if (d.layers) edit.layers = d.layers;
      if (d.deletedMarks) edit.deletedMarks = d.deletedMarks;
      if (d.freeMarks) edit.freeMarks = d.freeMarks;
      // Preserve existing authored layouts as independent starting points.
      for (const field of ['marks', 'deletedMarks', 'freeMarks']) {
        Object.entries(NAV_MARKER_VARIANTS).forEach(([key, v]) => {
          if (!Object.prototype.hasOwnProperty.call(edit[field], key) && edit[field][v.node])
            edit[field][key] = JSON.parse(JSON.stringify(edit[field][v.node]));
        });
      }
      syncMarkerHides();
    } catch (e) { /* a corrupt draft just means starting over */ }
  }
  function save() {
    syncMarkerHides();
    try { localStorage.setItem(STORE, JSON.stringify({ rects: edit.rects, marks: edit.marks, actions: edit.actions, dirty: edit.dirty, layers: edit.layers, deletedMarks: edit.deletedMarks, freeMarks: edit.freeMarks })); }
    catch (e) { /* private mode — the export button still works */ }
  }

  // --- history ---------------------------------------------------------
  // Whole-draft snapshots: the drafts are a few kB of numbers, so there is
  // nothing to gain from recording per-field deltas.
  const frame = () => JSON.stringify({ rects: edit.rects, marks: edit.marks, actions: edit.actions, dirty: edit.dirty, layers: edit.layers, deletedMarks: edit.deletedMarks, freeMarks: edit.freeMarks });
  function snapshot() {
    history.past.push(frame());
    if (history.past.length > 80) history.past.shift();
    history.future.length = 0;
  }
  function restore(s) {
    const d = JSON.parse(s);
    edit.rects = d.rects || {};
    edit.marks = d.marks || {};
    edit.actions = d.actions || {};
    edit.dirty = d.dirty || {};
    edit.layers = d.layers || {};
    edit.deletedMarks = d.deletedMarks || {};
    edit.freeMarks = d.freeMarks || {};
    save();
    refresh();
  }
  function undo() {
    if (!history.past.length) return;
    history.future.push(frame());
    restore(history.past.pop());
  }
  function redo() {
    if (!history.future.length) return;
    history.past.push(frame());
    restore(history.future.pop());
  }

  // --- seeds -----------------------------------------------------------
  // Nothing is stored for a screen until its painted map has been decoded,
  // otherwise an early open would freeze an empty set in place.
  function rectsFor(key) {
    if (edit.rects[key]) return edit.rects[key];
    if (!COLLIDER_DATA[key]) return (edit.rects[key] = {});   // nothing painted to seed from
    const regions = colliderRegions(key);
    if (!regions) return null;
    const seeded = {};
    COLLIDER_DATA[key].actions.forEach((a, i) => { if (a && regions[i]) seeded[i] = [regions[i].box.slice()]; });
    edit.rects[key] = seeded;
    return seeded;
  }
  function freeMarksFor(key) {
    if (!edit.freeMarks[key]) edit.freeMarks[key] = JSON.parse(JSON.stringify(baseFreeMarks[key] || baseFreeMarks[navMarkerBaseKey(key)] || {}));
    return edit.freeMarks[key];
  }
  function markPosition(key, idx) {
    return (freeMarksFor(key)[idx] || {}).pos || (edit.marks[key] || {})[idx] || null;
  }
  function marksFor(key) {
    if (edit.marks[key]) return edit.marks[key];
    const baseKey = navMarkerBaseKey(key);
    if (COLLIDER_DATA[baseKey] && !colliderRegions(baseKey)) return null;
    const seeded = {};
    if (COLLIDER_DATA[baseKey]) navMarkerPositions(key, false).forEach(m => { if (!markerHidden(key, m.i)) seeded[m.i] = m.pos.slice(); });
    // drafted actions have no painted region, so they start on their own box
    const extra = edit.actions[navMarkerBaseKey(key)] || {};
    Object.keys(extra).forEach(i => {
      if (!extra[i].to || seeded[i] || markerHidden(key, i)) return;
      const b = ((edit.rects[baseKey] || {})[i] || [])[0];
      seeded[i] = b ? [b[0] + b[2] / 2, b[1] + b[3] / 2] : [0.5, 0.5];
    });
    edit.marks[key] = seeded;
    return seeded;
  }

  // --- chrome ----------------------------------------------------------
  function build() {
    layer = document.createElement('div');
    layer.id = 'editor-layer';
    document.getElementById('stage').appendChild(layer);

    panel = document.createElement('div');
    panel.id = 'editor-panel';
    panel.innerHTML =
      '<h2 title="свернуть"></h2>' +
      '<label>экран<select></select></label>' +
      '<div class="ed-list"></div>' +
      '<div class="ed-coords">' +
        '<label>X<input type="number" step="1" data-f="0"></label>' +
        '<label>Y<input type="number" step="1" data-f="1"></label>' +
        '<label class="ed-boxonly">Ш<input type="number" step="1" data-f="2"></label>' +
        '<label class="ed-boxonly">В<input type="number" step="1" data-f="3"></label>' +
      '</div>' +
      '<div class="ed-row ed-boxonly">' +
        '<button data-act="add">+ бокс</button>' +
        '<button data-act="del">− удалить</button>' +
      '</div>' +
      '<div class="ed-row ed-boxonly">' +
        '<button data-act="up">▲ выше</button>' +
        '<button data-act="down">▼ ниже</button>' +
      '</div>' +
      '<div class="ed-new ed-boxonly">' +
        '<select class="ed-to"></select>' +
        '<select class="ed-cursor">' +
          '<option value="front">вперёд</option>' +
          '<option value="back">назад</option>' +
          '<option value="left">влево</option>' +
          '<option value="right">вправо</option>' +
          '<option value="grab">взять</option>' +
        '</select>' +
        '<div class="ed-row">' +
          '<button data-act="newaction">+ переход</button>' +
          '<button data-act="delaction">− переход</button>' +
        '</div>' +
      '</div>' +
      '<div class="ed-navonly">' +
        '<label>иконка свободной метки<select class="ed-markicon">' +
          '<option value="front">вперёд</option><option value="back">назад</option>' +
          '<option value="left">влево</option><option value="right">вправо</option>' +
          '<option value="star">звёздочка</option>' +
        '</select></label>' +
        '<div class="ed-row"><button data-act="freeadd">+ свободная метка</button></div>' +
      '</div>' +
      '<div class="ed-row">' +
        '<button data-act="reset" class="ed-wide">сброс к рисунку</button>' +
      '</div>' +
      '<div class="ed-row">' +
        '<button data-act="marktoggle" class="ed-navonly">− метка</button>' +
        '<button data-act="cx">↔ центр</button>' +
        '<button data-act="cy">↕ центр</button>' +
      '</div>' +
      '<div class="ed-row">' +
        '<button data-act="export" class="ed-wide">экспорт JSON</button>' +
      '</div>' +
      '<p class="ed-note"></p>';
    document.body.appendChild(panel);

    titleEl = panel.querySelector('h2');
    // the panel sits over the frame, so it has to get out of the way
    titleEl.addEventListener('click', () => { panel.classList.toggle('folded'); refresh(); });
    pickEl = panel.querySelector('select');
    listEl = panel.querySelector('.ed-list');
    noteEl = panel.querySelector('.ed-note');
    coordsEl = panel.querySelector('.ed-coords');
    // 'change', not 'input': committing on Enter or blur keeps a half-typed
    // number from being read as a position on every keystroke
    coordsEl.addEventListener('change', applyCoords);
    coordsEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });

    const addOptions = (label, list) => {
      if (!list.length) return;
      const grp = document.createElement('optgroup');
      grp.label = label;
      if (label === 'варианты меток') grp.className = 'ed-marker-variants';
      list.forEach(k => {
        const o = document.createElement('option');
        o.value = k; o.textContent = NAV_MARKER_VARIANTS[k]?.label || k;
        grp.appendChild(o);
      });
      pickEl.appendChild(grp);
    };
    const known = Object.keys(COLLIDER_DATA).sort();
    // a node counts as covered if any variant of its key has a map
    const covered = new Set(known.map(k => k.split('__')[0]));
    addOptions('варианты меток', Object.keys(NAV_MARKER_VARIANTS));
    addOptions('с коллайдером', known);
    addOptions('без коллайдера', Object.keys(nodes).filter(id => !covered.has(id)).sort());

    const toEl = panel.querySelector('.ed-to');
    Object.keys(nodes).sort().forEach(id => {
      const o = document.createElement('option');
      o.value = id; o.textContent = id;
      toEl.appendChild(o);
    });
    // With a row selected these edit it; with nothing selected they just
    // hold what the next "+ переход" will be made of.
    toEl.addEventListener('change', () => editAction('to', toEl.value));
    const curEl = panel.querySelector('.ed-cursor');
    curEl.addEventListener('change', () => editAction('cursor', curEl.value));
    const iconEl = panel.querySelector('.ed-markicon');
    iconEl.addEventListener('change', () => {
      const mark = sel && freeMarksFor(curKey())[sel.idx];
      if (!mark) return;
      snapshot(); mark.cursor = iconEl.value; save(); refresh();
    });
    pickEl.addEventListener('change', () => gotoKey(pickEl.value));
    panel.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (b) act(b.dataset.act);
    });
    layer.addEventListener('pointerdown', (e) => {
      if (e.target === layer) { sel = null; refresh(); }
    });
  }

  // Jumping between screens from the picker: the two keys that depend on
  // game state need that state set, or colliderKeyFor would hand back the
  // other variant the moment we rendered.
  function gotoKey(key) {
    const variant = NAV_MARKER_VARIANTS[key];
    if (variant) {
      if (variant.node === 'lever_view') { state.leverOpen = false; state.cablesSolved = variant.ready; }
      if (variant.node === 'towerlift_2_1') state.towerSolved = variant.ready;
      state.current = variant.node;
      render(); sel = null; ensureThen(refresh); return;
    }
    if (key === 'third_gate__open') state.leverOpen = true;
    if (key === 'third_gate__closed') state.leverOpen = false;
    if (key === 'lift_2_1__green') state.circuitGreen = true;
    if (key === 'lift_2_1__red') state.circuitGreen = false;
    state.current = key.split('__')[0];
    render();
    sel = null;
    ensureThen(refresh);
  }

  // The painted map is decoded lazily, so wait for it rather than drawing an
  // empty editor over a screen opened for the first time.
  function ensureThen(fn) {
    fn();
    const baseKey = navMarkerBaseKey(curKey());
    if (COLLIDER_DATA[baseKey]) whenColliderReady(baseKey, () => { if (editorMode) fn(); });
  }

  // --- exact coordinates -----------------------------------------------
  const selBox = () => (sel && editorMode === 'collider')
    ? (((edit.rects[curKey()] || {})[sel.idx] || [])[sel.n] || null) : null;
  const selMark = () => (sel && editorMode === 'nav')
    ? (markerHidden(curKey(), sel.idx) ? null : markPosition(curKey(), sel.idx)) : null;
  const tidy = v => String(Math.round(v * 10) / 10);

  // Mirror the selected action into the two selects, and only let the
  // destination be changed on something that is actually a move.
  function syncActionFields(actions) {
    const toEl = panel.querySelector('.ed-to');
    const curEl = panel.querySelector('.ed-cursor');
    const a = sel ? actions[sel.idx] : null;
    toEl.disabled = !!(a && !a.to);
    if (a && a.to && document.activeElement !== toEl) toEl.value = a.to;
    if (a && a.cursor && document.activeElement !== curEl) curEl.value = a.cursor;
    const del = panel.querySelector('button[data-act="delaction"]');
    if (del) del.disabled = !(sel && isNew(curKey(), sel.idx));
    const icon = panel.querySelector('.ed-markicon');
    icon.disabled = !(a && a.free);
    if (a && a.free) icon.value = a.cursor;
    const mt = panel.querySelector('button[data-act="marktoggle"]');
    if (mt) {
      const hidden = !!(sel && markerHidden(curKey(), sel.idx));
      mt.textContent = hidden ? '+ метка' : '− метка';
      mt.disabled = !a || (!a.to && !a.free);
    }
  }

  function syncCoords() {
    const b = selBox(), m = selMark();
    const vals = b ? [b[0] * SRC.w, b[1] * SRC.h, b[2] * SRC.w, b[3] * SRC.h]
              : m ? [m[0] * SRC.w, m[1] * SRC.h, null, null]
              : [null, null, null, null];
    coordsEl.querySelectorAll('input').forEach((inp, i) => {
      inp.disabled = vals[i] === null || vals[i] === undefined;
      if (document.activeElement !== inp) inp.value = inp.disabled ? '' : tidy(vals[i]);
    });
  }

  function applyCoords() {
    const b = selBox(), m = selMark();
    if (!b && !m) return;
    const v = [...coordsEl.querySelectorAll('input')].map(i => parseFloat(i.value));
    snapshot();
    if (b) {
      if (isFinite(v[0])) b[0] = v[0] / SRC.w;
      if (isFinite(v[1])) b[1] = v[1] / SRC.h;
      if (isFinite(v[2])) b[2] = v[2] / SRC.w;
      if (isFinite(v[3])) b[3] = v[3] / SRC.h;
      normalise(b);
      markDirty();
    } else {
      if (isFinite(v[0])) m[0] = clamp01(v[0] / SRC.w);
      if (isFinite(v[1])) m[1] = clamp01(v[1] / SRC.h);
    }
    save();
    refresh();
  }

  // --- drawing ---------------------------------------------------------
  function refresh() {
    if (!editorMode) return;
    const key = curKey();
    titleEl.textContent = (editorMode === 'collider' ? 'коллайдеры' : 'метки навигации') +
                          (panel.classList.contains('folded') ? '  ▸' : '  ▾');
    panel.classList.toggle('nav-mode', editorMode === 'nav');
    const variantGroup = pickEl.querySelector('.ed-marker-variants');
    if (variantGroup) { variantGroup.hidden = editorMode !== 'nav'; variantGroup.disabled = editorMode !== 'nav'; }
    if (pickEl.value !== key) pickEl.value = key;

    layer.innerHTML = '';
    listEl.innerHTML = '';

    const store = editorMode === 'collider' ? rectsFor(key) : marksFor(key);
    if (!store) { noteEl.textContent = 'карта ещё грузится…'; return; }

    const actions = actionsFor(key);
    if (!actions.some(Boolean) && (editorMode !== 'nav' || !Object.keys(freeMarksFor(key)).length)) {
      listEl.innerHTML = '<div class="ed-empty">' +
        (editorMode === 'collider' ? 'коллайдера нет — добавь переход ниже'
                                   : 'добавь свободную метку ниже') + '</div>';
    }
    // topmost (wins overlaps) first, like a layers panel
    const order = layerOrder(key, actions);
    const listing = editorMode === 'collider'
      ? order.slice().reverse()
      : [...actions.map((a, i) => (a ? i : -1)).filter(i => i > 0), ...Object.keys(freeMarksFor(key))];
    listing.forEach(i => {
      const a = actions[i];
      if (!a) return;
      if (editorMode === 'nav' && !a.to && !a.free) return;
      const row = document.createElement('div');
      row.className = 'ed-item' + (sel && sel.idx === i ? ' on' : '') +
                      (isNew(key, i) ? ' new' : '') + (isEdited(key, i) ? ' edited' : '') +
                      (editorMode === 'nav' && markerHidden(key, i) ? ' hidden-mark' : '');
      const count = editorMode === 'collider' ? (store[i] || []).length : 0;
      row.innerHTML = '<i style="background:' + colorOf(a) + '"></i>' +
                      '<b>' + i + '</b><span>' + labelOf(a) + '</span>' +
                      '<em' + (editorMode === 'collider' && !count ? ' class="warn"' : '') + '>' +
                      (a.cursor || '') + (editorMode === 'collider' ? ' ×' + count : markerHidden(key, i) ? ' · скрыта' : '') + '</em>';
      row.addEventListener('click', () => {
        sel = editorMode === 'collider' ? { idx: i, n: 0 } : { idx: i };
        refresh();
      });
      listEl.appendChild(row);

      if (editorMode === 'collider') {
        (store[i] || []).forEach((r, n) => drawRect(key, a, i, n, r, order.indexOf(i) + 1));
      } else if (markPosition(key, i) && !markerHidden(key, i)) drawMark(a, i, markPosition(key, i));
    });

    syncCoords();
    syncActionFields(actions);
    guides.xs.forEach(v => drawGuide('x', v));
    guides.ys.forEach(v => drawGuide('y', v));

    noteEl.textContent = (edit.dirty[key] ? '⚠ боксы этого экрана заменят ручной рисунок при экспорте. ' : '') +
      (editorMode === 'collider'
      ? 'тяни тело — двигать, углы и края — размер. стрелки — пиксель, с Shift — десять. '
        + '⌘Z / ⌘⇧Z — отмена и возврат, ⌘X / ⌘C / ⌘V — бокс. Alt при перетаскивании отключает примагничивание. '
        + 'список идёт сверху вниз по приоритету: верхний перекрывает нижние.'
      : 'тяни метку. стрелки — пиксель, с Shift — десять. ⌘Z / ⌘⇧Z — отмена и возврат. '
        + 'Alt при перетаскивании отключает примагничивание.');
  }

  function drawGuide(axis, v) {
    const el = document.createElement('div');
    el.className = 'ed-guide ' + axis;
    el.style[axis === 'x' ? 'left' : 'top'] = (v * 100) + '%';
    layer.appendChild(el);
  }

  function drawRect(key, a, idx, n, r, z) {
    const el = document.createElement('div');
    el.style.zIndex = z || 1;
    el.className = 'ed-rect' + (sel && sel.idx === idx && sel.n === n ? ' on' : '');
    el.style.left = (r[0] * 100) + '%';
    el.style.top = (r[1] * 100) + '%';
    el.style.width = (r[2] * 100) + '%';
    el.style.height = (r[3] * 100) + '%';
    el.style.setProperty('--c', colorOf(a));
    el.innerHTML = '<span>' + idx + ' ' + labelOf(a) + '</span>';
    ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach(d => {
      const h = document.createElement('i');
      h.className = 'h ' + d; h.dataset.dir = d;
      el.appendChild(h);
    });
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      sel = { idx, n };
      const dir = e.target.dataset ? e.target.dataset.dir : null;
      snapshot();
      startDrag(e, (dx, dy, ev) => {
        const box = edit.rects[key][idx][n];
        if (!dir) { box[0] += dx; box[1] += dy; }
        else {
          if (dir.includes('w')) { box[0] += dx; box[2] -= dx; }
          if (dir.includes('e')) { box[2] += dx; }
          if (dir.includes('n')) { box[1] += dy; box[3] -= dy; }
          if (dir.includes('s')) { box[3] += dy; }
        }
        normalise(box);
        guides = ev.altKey ? { xs: [], ys: [] } : snapBox(key, idx, n, box, dir);
        markDirty();
      });
    });
    layer.appendChild(el);
  }

  function drawMark(a, idx, p) {
    const el = document.createElement('div');
    el.className = 'ed-mark' + (sel && sel.idx === idx ? ' on' : '');
    el.style.left = (p[0] * 100) + '%';
    el.style.top = (p[1] * 100) + '%';
    const img = document.createElement('img');
    img.src = 'assets/nav/' + (NAV_MARKER_ART[a.cursor] || 'target') + '.png?v=1';
    img.dataset.direction = a.cursor || 'front';
    img.style.transform = NAV_MARKER_SPIN[a.cursor] || '';
    el.appendChild(img);
    const tag = document.createElement('span');
    tag.textContent = idx + ' ' + labelOf(a);
    el.appendChild(tag);
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      sel = { idx };
      snapshot();
      startDrag(e, (dx, dy, ev) => {
        const key = curKey();
        const m = markPosition(key, idx);
        m[0] = clamp01(m[0] + dx);
        m[1] = clamp01(m[1] + dy);
        guides = ev.altKey ? { xs: [], ys: [] } : snapMark(key, idx, m);
      });
    });
    layer.appendChild(el);
  }

  // --- snapping --------------------------------------------------------
  // Every edge and centre line of the other boxes on this screen, plus the
  // frame's own edges and middle. Holding Alt while dragging ignores them.
  function snapLines(key, skipIdx, skipN) {
    const xs = [0, 0.5, 1], ys = [0, 0.5, 1];
    const store = Object.assign({}, (editorMode === 'collider' ? edit.rects : edit.marks)[key] || {});
    if (editorMode === 'nav') Object.entries(freeMarksFor(key)).forEach(([id, m]) => { store[id] = m.pos; });
    for (const i in store) {
      if (editorMode === 'collider') {
        store[i].forEach((b, n) => {
          if (+i === skipIdx && n === skipN) return;
          xs.push(b[0], b[0] + b[2] / 2, b[0] + b[2]);
          ys.push(b[1], b[1] + b[3] / 2, b[1] + b[3]);
        });
      } else if (String(i) !== String(skipIdx) && !markerHidden(key, i)) {
        xs.push(store[i][0]);
        ys.push(store[i][1]);
      }
    }
    return { xs, ys };
  }

  function nearest(v, lines, tol) {
    let best = null, d = tol;
    lines.forEach(l => { const dd = Math.abs(l - v); if (dd <= d) { d = dd; best = l; } });
    return best;
  }

  // Of a box's three x (or y) landmarks, the one closest to a line wins and
  // the whole box moves by that much — so a box can latch by its left edge,
  // its centre or its right edge, whichever is nearest.
  function bestShift(points, lines, tol, hits) {
    let shift = 0, best = Infinity, hit = null;
    points.forEach(v => {
      const s = nearest(v, lines, tol);
      if (s === null) return;
      if (Math.abs(s - v) < best) { best = Math.abs(s - v); shift = s - v; hit = s; }
    });
    if (hit !== null) hits.push(hit);
    return shift;
  }

  function snapBox(key, idx, n, b, dir) {
    const r = stageRect();
    const tolX = SNAP_PX / r.width, tolY = SNAP_PX / r.height;
    const L = snapLines(key, idx, n);
    const hits = { xs: [], ys: [] };
    if (!dir) {
      b[0] += bestShift([b[0], b[0] + b[2] / 2, b[0] + b[2]], L.xs, tolX, hits.xs);
      b[1] += bestShift([b[1], b[1] + b[3] / 2, b[1] + b[3]], L.ys, tolY, hits.ys);
    } else {
      let s;
      if (dir.includes('w') && (s = nearest(b[0], L.xs, tolX)) !== null) { b[2] += b[0] - s; b[0] = s; hits.xs.push(s); }
      if (dir.includes('e') && (s = nearest(b[0] + b[2], L.xs, tolX)) !== null) { b[2] = s - b[0]; hits.xs.push(s); }
      if (dir.includes('n') && (s = nearest(b[1], L.ys, tolY)) !== null) { b[3] += b[1] - s; b[1] = s; hits.ys.push(s); }
      if (dir.includes('s') && (s = nearest(b[1] + b[3], L.ys, tolY)) !== null) { b[3] = s - b[1]; hits.ys.push(s); }
    }
    normalise(b);
    return hits;
  }

  function snapMark(key, idx, m) {
    const r = stageRect();
    const L = snapLines(key, idx, -1);
    const hits = { xs: [], ys: [] };
    const sx = nearest(m[0], L.xs, SNAP_PX / r.width);
    const sy = nearest(m[1], L.ys, SNAP_PX / r.height);
    if (sx !== null) { m[0] = sx; hits.xs.push(sx); }
    if (sy !== null) { m[1] = sy; hits.ys.push(sy); }
    return hits;
  }

  // --- interaction -----------------------------------------------------
  const clamp01 = v => Math.min(1, Math.max(0, v));

  // A box dragged past its own edge flips rather than inverting, and
  // nothing is allowed outside the frame — the collider PNG has no room
  // for either case.
  function normalise(b) {
    if (b[2] < 0) { b[0] += b[2]; b[2] = -b[2]; }
    if (b[3] < 0) { b[1] += b[3]; b[3] = -b[3]; }
    b[2] = Math.min(b[2], 1); b[3] = Math.min(b[3], 1);
    b[0] = Math.min(Math.max(b[0], 0), 1 - b[2]);
    b[1] = Math.min(Math.max(b[1], 0), 1 - b[3]);
  }

  function startDrag(e, apply) {
    const r = stageRect();
    let lastX = e.clientX, lastY = e.clientY;
    const move = (ev) => {
      apply((ev.clientX - lastX) / r.width, (ev.clientY - lastY) / r.height, ev);
      lastX = ev.clientX; lastY = ev.clientY;
      refresh();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      guides = { xs: [], ys: [] };
      save();
      refresh();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    refresh();
  }

  function addFreeMarker() {
    if (editorMode !== 'nav') return;
    snapshot();
    const store = freeMarksFor(curKey());
    let n = 1; while (store['f' + n]) n++;
    const idx = 'f' + n;
    store[idx] = { pos: [0.5, 0.5], cursor: panel.querySelector('.ed-markicon').value || 'front' };
    sel = { idx }; save(); refresh();
  }

  function toggleMarker() {
    if (editorMode !== 'nav' || !sel) return;
    if (freeMarksFor(curKey())[sel.idx]) {
      snapshot(); delete edit.freeMarks[curKey()][sel.idx]; sel = null; save(); refresh(); return;
    }
    if (!actionsFor(curKey())[sel.idx]?.to) return;
    const key = curKey(), idx = sel.idx;
    const restoring = markerHidden(key, idx);
    snapshot();
    edit.deletedMarks[key] = edit.deletedMarks[key] || {};
    // Explicit false restores even a marker hidden in the shipped data.
    edit.deletedMarks[key][idx] = !restoring;
    if (restoring && !(edit.marks[key] || {})[idx]) {
      const baseKey = navMarkerBaseKey(key);
      const placed = (NAV_MARKERS[key] || NAV_MARKERS[baseKey] || {})[idx];
      const b = ((edit.rects[baseKey] || {})[idx] || [])[0];
      const region = (colliderRegions(baseKey) || {})[idx];
      edit.marks[key] = edit.marks[key] || {};
      edit.marks[key][idx] = placed ? placed.slice()
        : region ? region.centroid.slice()
        : b ? [b[0]+b[2]/2,b[1]+b[3]/2] : [0.5,0.5];
    }
    save(); refresh();
  }

  function act(what) {
    const key = curKey();
    if (what === 'export') return exportJson();
    if (what === 'marktoggle') return toggleMarker();
    if (what === 'freeadd') return addFreeMarker();
    if (what === 'newaction') return addAction();
    if (what === 'up' || what === 'down') return moveLayer(what);
    snapshot();
    if (what === 'reset') {
      if (editorMode === 'collider') { delete edit.rects[key]; delete edit.dirty[key]; }
      else { delete edit.marks[key]; delete edit.deletedMarks[key]; delete edit.freeMarks[key]; syncMarkerHides(); }
      delete colliderRegionCache[key];
      sel = null; save(); ensureThen(refresh); return;
    }
    if (!sel) return;
    if (what === 'delaction') {
      if (!isNew(key, sel.idx)) return;
      markDirty();
      delete edit.actions[key][sel.idx];
      if (edit.rects[key]) delete edit.rects[key][sel.idx];
      if (edit.marks[key]) delete edit.marks[key][sel.idx];
      sel = null;
      save(); refresh();
      return;
    }
    if (editorMode === 'collider') {
      const list = (edit.rects[key] || {})[sel.idx];
      if (what === 'add' && list) { list.push([0.4, 0.4, 0.2, 0.2]); sel = { idx: sel.idx, n: list.length - 1 }; }
      if (what === 'del' && list && list.length) { list.splice(sel.n, 1); sel = { idx: sel.idx, n: 0 }; }
      const b = list && list[sel.n];
      if (b && what === 'cx') b[0] = (1 - b[2]) / 2;
      if (b && what === 'cy') b[1] = (1 - b[3]) / 2;
      markDirty();
    } else {
      const m = markPosition(key, sel.idx);
      if (m && what === 'cx') m[0] = 0.5;
      if (m && what === 'cy') m[1] = 0.5;
    }
    save(); refresh();
  }

  function nudge(dx, dy) {
    if (!sel) return;
    // a held arrow key repeats; one snapshot per burst, not per repeat
    const now = Date.now();
    if (now - lastNudge > 700) snapshot();
    lastNudge = now;
    const key = curKey();
    if (editorMode === 'collider') {
      const b = ((edit.rects[key] || {})[sel.idx] || [])[sel.n];
      if (!b) return;
      b[0] += dx; b[1] += dy; normalise(b);
      markDirty();
    } else {
      const m = markPosition(key, sel.idx);
      if (!m) return;
      m[0] = clamp01(m[0] + dx); m[1] = clamp01(m[1] + dy);
    }
    save(); refresh();
  }

  // A transition the game does not have yet. It takes the next free index,
  // which is what the exported map paints and what the generated
  // COLLIDER_DATA entry has to line up with — so nothing is ever inserted
  // in the middle, where it would renumber the regions already painted.
  function addAction() {
    const key = curKey();
    const idx = Math.max(actionsFor(key).length, 1);
    snapshot();
    (edit.actions[key] = edit.actions[key] || {})[idx] = {
      to: panel.querySelector('.ed-to').value,
      cursor: panel.querySelector('.ed-cursor').value,
    };
    markDirty();
    const store = edit.rects[key] || (edit.rects[key] = {});
    store[idx] = [[0.4, 0.4, 0.2, 0.2]];
    if (edit.marks[key]) edit.marks[key][idx] = [0.5, 0.5];
    sel = { idx, n: 0 };
    save(); refresh();
  }

  // Cut / copy / paste move one box between indices and screens, which is
  // the quick way to reuse a zone that is the same shape somewhere else.
  function clipboard(what) {
    if (editorMode !== 'collider' || !sel) return;
    const key = curKey();
    const list = (edit.rects[key] || {})[sel.idx];
    if (what === 'paste') {
      if (!clip || !list) return;
      snapshot();
      markDirty();
      list.push(clip.slice());
      sel = { idx: sel.idx, n: list.length - 1 };
    } else {
      if (!list || !list[sel.n]) return;
      clip = list[sel.n].slice();
      if (what === 'cut') {
        snapshot();
        markDirty();
        list.splice(sel.n, 1);
        sel = { idx: sel.idx, n: 0 };
      }
    }
    save();
    refresh();
  }

  function exportJson() {
    // Only screens whose boxes were actually moved ship their shapes: the
    // rest keep their hand-painted regions, which a seeded bounding box
    // would otherwise overwrite just because the screen had been opened.
    const rects = {};
    Object.keys(edit.dirty).forEach(k => { if (edit.rects[k]) rects[k] = edit.rects[k]; });
    const blob = new Blob([JSON.stringify({ version: 1, rects: rects, marks: edit.marks,
                                            actions: edit.actions, layers: edit.layers, deletedMarks: edit.deletedMarks, freeMarks: edit.freeMarks }, null, 1)],
                          { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'untorra-editor.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    const edited = Object.keys(edit.actions).filter(k => Object.keys(edit.actions[k]).length).length;
    noteEl.textContent = 'выгружено: ' + Object.keys(rects).length + ' экранов с перерисованными боксами, ' +
                         edited + ' с правками переходов, ' + Object.keys(edit.marks).length + ' с метками';
  }

  // --- mode ------------------------------------------------------------
  function open(mode) {
    if (!layer) build();
    if (minimapOpen) closeMinimap();
    hideNavMarkers();
    editorMode = mode;
    sel = null;
    document.body.classList.add('editing');
    ensureThen(refresh);
  }
  function close() {
    editorMode = null;
    sel = null;
    document.body.classList.remove('editing');
    if (layer) layer.innerHTML = '';
  }

  document.addEventListener('keydown', (e) => {
    if (e.shiftKey && !e.metaKey && !e.ctrlKey && (e.code === 'KeyC' || e.code === 'KeyN')) {
      const want = e.code === 'KeyC' ? 'collider' : 'nav';
      e.preventDefault(); e.stopImmediatePropagation();
      if (editorMode === want) close(); else open(want);
      return;
    }
    if (!editorMode) return;
    if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.key === 'Escape') { e.stopImmediatePropagation(); close(); return; }
    if (e.metaKey || e.ctrlKey) {
      const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
      if (e.code === 'KeyZ') { stop(); if (e.shiftKey) redo(); else undo(); return; }
      if (e.code === 'KeyY') { stop(); redo(); return; }
      if (e.code === 'KeyX') { stop(); clipboard('cut'); return; }
      if (e.code === 'KeyC') { stop(); clipboard('copy'); return; }
      if (e.code === 'KeyV') { stop(); clipboard('paste'); return; }
      return;
    }
    const step = (e.shiftKey ? 10 : 1) / 640;
    if (e.key === 'ArrowLeft')  { e.preventDefault(); e.stopImmediatePropagation(); nudge(-step, 0); }
    if (e.key === 'ArrowRight') { e.preventDefault(); e.stopImmediatePropagation(); nudge(step, 0); }
    if (e.key === 'ArrowUp')    { e.preventDefault(); e.stopImmediatePropagation(); nudge(0, -step); }
    if (e.key === 'ArrowDown')  { e.preventDefault(); e.stopImmediatePropagation(); nudge(0, step); }
    // the game's own M / Esc bindings have no business firing while editing
    if (e.code === 'KeyM') e.stopImmediatePropagation();
  }, true);

  window.addEventListener('resize', () => { if (editorMode) refresh(); });

  load();
})();
