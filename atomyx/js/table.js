// The periodic-table component. Renders the WHOLE table every time — set
// cells bright (and tappable), everything else dimmed context — as an SVG
// with Atlaz's mobile-first interaction, adapted from atlaz/js/map.js:
// one-finger pan, two-finger pinch zoom, wheel zoom, double-tap zoom, and
// slop-tolerant tap detection, plus the same +/−/⌖ zoom buttons.
//
// Layout: 18 columns; rows 1-7 the main table, a slim spacer, then the
// lanthanide/actinide shelf (positions baked into the data as x/y — see
// tools/build-data.mjs). Tiles are drawn at a comfortable natural size
// (number top-left, symbol centred) and the viewport starts fitted to the
// frame — zooming in is how small screens read the numbers.
//
// API (modes.js):
//   const t = renderTable(host, elements, setIds, { blankActive, onTap })
//   t.mark(id, ...classes) / t.unmark(id, ...classes)  — cell state classes
//   t.reveal(id)             — un-blank a cell (BUILD/SWEEP fills)
//   t.clearSel()             — drop the pending .sel highlight
//
// Blank cells hide the atomic number as well as the symbol: number →
// element is 1:1, so a visible number would give BUILD/SWEEP away.

const SVGNS = 'http://www.w3.org/2000/svg';
const CW = 40, CH = 46, GAP = 3;    // natural tile size ("less squashed": taller than wide)
const SHELF_GAP = 16;                // breathing room above the f-block shelf
const COLS = 18;
const MAX_ZOOM = 6;
const TAP_SLOP_PX = 9;               // finger movement allowed within a "tap"
const NEAR_PX = 14;                  // snap taps in the gutters to the nearest tile

const W = COLS * CW + (COLS - 1) * GAP;
function rowTop(y) {
  const r = y >= 9 ? y - 2 : y - 1;             // shelf rows sit right after row 7
  return r * (CH + GAP) + (y >= 9 ? SHELF_GAP : 0);
}
const H = rowTop(10) + CH;

export function renderTable(host, elements, setIds, { blankActive = false, onTap = null } = {}) {
  const inSet = new Set(setIds);
  host.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'pt-host';
  host.appendChild(wrap);

  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.classList.add('pt-svg');
  const vp = document.createElementNS(SVGNS, 'g');
  svg.appendChild(vp);
  wrap.appendChild(svg);

  const cells = new Map();
  const rects = [];                   // { id, x0, y0 } for arithmetic hit testing
  for (const [id, el] of Object.entries(elements)) {
    const x0 = (el.x - 1) * (CW + GAP), y0 = rowTop(el.y);
    const g = document.createElementNS(SVGNS, 'g');
    g.classList.add('el-cell');
    if (!inSet.has(id)) g.classList.add('ctx');
    else if (blankActive) g.classList.add('blank');
    g.dataset.id = id;

    const r = document.createElementNS(SVGNS, 'rect');
    r.setAttribute('x', x0); r.setAttribute('y', y0);
    r.setAttribute('width', CW); r.setAttribute('height', CH);
    r.setAttribute('rx', 4);
    g.appendChild(r);

    const num = document.createElementNS(SVGNS, 'text');
    num.classList.add('el-num');
    num.setAttribute('x', x0 + 3.5); num.setAttribute('y', y0 + 11);
    num.textContent = el.num;
    g.appendChild(num);

    const sym = document.createElementNS(SVGNS, 'text');
    sym.classList.add('el-sym');
    sym.setAttribute('x', x0 + CW / 2); sym.setAttribute('y', y0 + CH / 2 + 5);
    sym.textContent = el.sym;
    g.appendChild(sym);

    vp.appendChild(g);
    cells.set(id, g);
    rects.push({ id, x0, y0 });
  }

  // Faint markers in the main-table group-3 gaps pointing at the shelf.
  for (const [row, label] of [[6, '57–71'], [7, '89–103']]) {
    const x0 = 2 * (CW + GAP), y0 = rowTop(row);
    const g = document.createElementNS(SVGNS, 'g');
    g.classList.add('el-marker');
    const r = document.createElementNS(SVGNS, 'rect');
    r.setAttribute('x', x0); r.setAttribute('y', y0);
    r.setAttribute('width', CW); r.setAttribute('height', CH);
    r.setAttribute('rx', 4);
    g.appendChild(r);
    const t = document.createElementNS(SVGNS, 'text');
    t.setAttribute('x', x0 + CW / 2); t.setAttribute('y', y0 + CH / 2 + 3);
    t.textContent = label;
    g.appendChild(t);
    vp.appendChild(g);
  }

  // ---- Pan / zoom (the Atlaz gesture set) -----------------------------------

  let k = 1, tx = 0, ty = 0;
  const pointers = new Map();
  let gesture = null, tapStart = null, lastTap = { t: 0, x: 0, y: 0 };

  const apply = () => vp.setAttribute('transform', `translate(${tx} ${ty}) scale(${k})`);

  function clamp() {
    k = Math.min(Math.max(k, 1), MAX_ZOOM);
    // Keep at least 15% of the frame covered by table in each axis.
    const minX = 0.15 * W - W * k, maxX = 0.85 * W;
    const minY = 0.15 * H - H * k, maxY = 0.85 * H;
    tx = Math.min(Math.max(tx, minX), maxX);
    ty = Math.min(Math.max(ty, minY), maxY);
  }

  // Client (screen) → viewBox units.
  function clientToView(x, y) {
    const m = svg.getScreenCTM();
    if (!m) return [0, 0];
    const inv = m.inverse();
    return [inv.a * x + inv.c * y + inv.e, inv.b * x + inv.d * y + inv.f];
  }
  const clientToTable = (x, y) => {
    const [vx, vy] = clientToView(x, y);
    return [(vx - tx) / k, (vy - ty) / k];
  };
  const pxPerUnit = () => {
    const m = svg.getScreenCTM();
    return (m ? m.a : 1) * k;
  };

  function zoomBy(factor, clientX = null, clientY = null) {
    const rect = svg.getBoundingClientRect();
    const cx = clientX ?? rect.left + rect.width / 2;
    const cy = clientY ?? rect.top + rect.height / 2;
    const [vx, vy] = clientToView(cx, cy);
    const k2 = Math.min(Math.max(k * factor, 1), MAX_ZOOM);
    const f = k2 / k;
    tx = vx - (vx - tx) * f;
    ty = vy - (vy - ty) * f;
    k = k2;
    clamp(); apply();
  }
  function resetView() { k = 1; tx = 0; ty = 0; apply(); }

  svg.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    svg.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      tapStart = { x: e.clientX, y: e.clientY, t: Date.now(), moved: false };
      gesture = { mode: 'pan', x: e.clientX, y: e.clientY };
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      gesture = { mode: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      if (tapStart) tapStart.moved = true;
    }
  });

  svg.addEventListener('pointermove', (e) => {
    const pt = pointers.get(e.pointerId);
    if (!pt) return;
    pt.x = e.clientX; pt.y = e.clientY;

    if (gesture?.mode === 'pan' && pointers.size === 1) {
      const dx = e.clientX - gesture.x, dy = e.clientY - gesture.y;
      if (tapStart && Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y) > TAP_SLOP_PX) {
        tapStart.moved = true;
      }
      const m = svg.getScreenCTM();
      const s = m ? m.a : 1; // client px per viewBox unit
      tx += dx / s; ty += dy / s;
      gesture.x = e.clientX; gesture.y = e.clientY;
      clamp(); apply();
    } else if (gesture?.mode === 'pinch' && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      if (gesture.d > 0) zoomBy(d / gesture.d, cx, cy);
      // Also pan with the midpoint so the gesture feels anchored.
      const m = svg.getScreenCTM();
      const s = m ? m.a : 1;
      tx += (cx - gesture.cx) / s;
      ty += (cy - gesture.cy) / s;
      clamp(); apply();
      gesture.d = d; gesture.cx = cx; gesture.cy = cy;
    }
  });

  function pointerGone(e) {
    pointers.delete(e.pointerId);
    if (pointers.size === 1) {
      const [p] = [...pointers.values()];
      gesture = { mode: 'pan', x: p.x, y: p.y };
    } else if (pointers.size === 0) {
      gesture = null;
      tapStart = null;
    }
  }

  svg.addEventListener('pointerup', (e) => {
    const wasTap = tapStart && !tapStart.moved && pointers.size === 1 && Date.now() - tapStart.t < 600;
    pointerGone(e);
    if (!wasTap) return;

    const now = Date.now();
    const isDouble = now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 34;
    lastTap = { t: isDouble ? 0 : now, x: e.clientX, y: e.clientY };
    if (isDouble) { zoomBy(2.1, e.clientX, e.clientY); return; }

    const id = hitTest(e.clientX, e.clientY);
    if (id && inSet.has(id)) onTap?.(id);
  });
  svg.addEventListener('pointercancel', pointerGone);
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.18 : 1 / 1.18, e.clientX, e.clientY);
  }, { passive: false });
  svg.addEventListener('contextmenu', (e) => e.preventDefault());

  // Uniform grid → arithmetic hit test: nearest tile rectangle wins, within
  // NEAR_PX screen pixels, so taps in the 3px gutters still land.
  function hitTest(clientX, clientY) {
    const [mx, my] = clientToTable(clientX, clientY);
    const ppu = pxPerUnit();
    let best = null, bestD = NEAR_PX;
    for (const c of rects) {
      const dx = Math.max(c.x0 - mx, 0, mx - (c.x0 + CW));
      const dy = Math.max(c.y0 - my, 0, my - (c.y0 + CH));
      const d = Math.hypot(dx, dy) * ppu;
      if (d < bestD) { bestD = d; best = c.id; }
    }
    return best;
  }

  // The Atlaz zoom buttons, self-contained so they exist only in table modes.
  const controls = document.createElement('div');
  controls.className = 'zoom-controls';
  for (const [label, title, fn] of [
    ['+', 'Zoom in', () => zoomBy(1.6)],
    ['−', 'Zoom out', () => zoomBy(1 / 1.6)],
    ['⌖', 'Fit table', resetView],
  ]) {
    const b = document.createElement('button');
    b.className = 'zoom-btn';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', fn);
    controls.appendChild(b);
  }
  wrap.appendChild(controls);

  apply();

  return {
    el: wrap,
    cells,
    zoomBy, resetView,
    mark(id, ...cls) { cells.get(id)?.classList.add(...cls); },
    unmark(id, ...cls) { cells.get(id)?.classList.remove(...cls); },
    reveal(id) { cells.get(id)?.classList.remove('blank'); },
    clearSel() { for (const c of cells.values()) c.classList.remove('sel'); },
  };
}
