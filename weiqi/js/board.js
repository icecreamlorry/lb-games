// Shared SVG Go-board renderer + input, used by both the live game and the
// tutorial. One board component draws the grid, stones, the last-move marker,
// and a rich annotation layer (point marks, region outlines, ghost/hint stones,
// arrows and labels) that the tutorial leans on to teach.
//
// Coordinates are in board units: intersection (r,c) sits at pixel
// (MARGIN + c, MARGIN + r) inside a square viewBox, so hit-testing is a simple
// linear map from the SVG's bounding rect to the nearest intersection. Input is
// a single pointerup handler on the SVG (no per-cell listeners, no pointer
// capture) which sidesteps the capture/hit-test pitfalls of a div grid.

const SVGNS = 'http://www.w3.org/2000/svg';
const MARGIN = 1;           // board units of padding around the grid
const STONE_R = 0.47;       // stone radius in board units

// Star points (hoshi) per board size.
const STARS = {
  9: [[2, 2], [2, 6], [6, 2], [6, 6], [4, 4]],
  13: [[3, 3], [3, 9], [9, 3], [9, 9], [6, 6]],
  19: [[3, 3], [3, 9], [3, 15], [9, 3], [9, 9], [9, 15], [15, 3], [15, 9], [15, 15]],
};

function el(name, attrs = {}) {
  const e = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

export function createBoard(container, { onPoint } = {}) {
  let size = 19;
  let hoverPoint = null;   // [r,c] currently hovered (for a ghost preview)
  let hoverSeat = null;    // seat whose ghost to preview on hover
  let blackSeat = 0;
  let interactive = true;

  const svg = el('svg', { class: 'goban', xmlns: SVGNS });
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  container.innerHTML = '';
  container.appendChild(svg);

  // Persistent layers, painted back-to-front.
  const defs = el('defs');
  const bg = el('rect', { class: 'goban-bg', x: 0, y: 0, rx: 0.3 });
  const gGrid = el('g', { class: 'goban-grid' });
  const gShadow = el('g', { class: 'goban-shadows' });
  const gStones = el('g', { class: 'goban-stones' });
  const gAnnot = el('g', { class: 'goban-annot' });
  const gHover = el('g', { class: 'goban-hover' });
  svg.append(defs, bg, gGrid, gShadow, gStones, gAnnot, gHover);

  // Stone gradients + a soft shadow, defined once.
  defs.innerHTML = `
    <radialGradient id="wq-black" cx="0.35" cy="0.3" r="0.75">
      <stop offset="0%" stop-color="#5a6470"/>
      <stop offset="45%" stop-color="#2b333d"/>
      <stop offset="100%" stop-color="#0c1116"/>
    </radialGradient>
    <radialGradient id="wq-white" cx="0.35" cy="0.3" r="0.85">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="70%" stop-color="#eef0f2"/>
      <stop offset="100%" stop-color="#c3c9d1"/>
    </radialGradient>
    <marker id="wq-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5"
            markerHeight="5" orient="auto-start-reverse">
      <path d="M0 1 L9 5 L0 9 z" fill="currentColor"/>
    </marker>`;

  function pos(i) { return MARGIN + i; }

  function buildStatic() {
    const span = size - 1;
    const total = span + MARGIN * 2;
    svg.setAttribute('viewBox', `0 0 ${total} ${total}`);
    bg.setAttribute('width', total);
    bg.setAttribute('height', total);

    gGrid.innerHTML = '';
    const first = pos(0), last = pos(span);
    for (let i = 0; i < size; i++) {
      const p = pos(i);
      gGrid.appendChild(el('line', { class: 'grid-line', x1: first, y1: p, x2: last, y2: p }));
      gGrid.appendChild(el('line', { class: 'grid-line', x1: p, y1: first, x2: p, y2: last }));
    }
    for (const [r, c] of STARS[size] || []) {
      gGrid.appendChild(el('circle', { class: 'star', cx: pos(c), cy: pos(r), r: 0.12 }));
    }
  }

  function stoneEl(r, c, seat, cls = '') {
    const fill = seat === blackSeat ? 'url(#wq-black)' : 'url(#wq-white)';
    const g = el('g', { class: `stone ${cls}`.trim() });
    g.appendChild(el('circle', {
      cx: pos(c), cy: pos(r), r: STONE_R, fill,
      stroke: seat === blackSeat ? '#05080b' : '#aab2bd', 'stroke-width': 0.03,
    }));
    return g;
  }

  // Draw the board, stones and any annotations.
  //   state: { board, size, lastMove?, blackSeat? }
  //   annotations: { marks, ghosts, regions, arrows, labels }
  function render(state, annotations = {}) {
    if (state.size && state.size !== size) { size = state.size; buildStatic(); }
    if (!gGrid.childNodes.length) buildStatic();
    if (state.blackSeat != null) blackSeat = state.blackSeat;
    const board = state.board;

    gStones.innerHTML = '';
    gShadow.innerHTML = '';
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const seat = board[r][c];
        if (seat === null || seat === undefined) continue;
        gShadow.appendChild(el('circle', {
          class: 'stone-shadow', cx: pos(c) + 0.05, cy: pos(r) + 0.07, r: STONE_R,
        }));
        gStones.appendChild(stoneEl(r, c, seat));
      }
    }
    // Last-move dot.
    const lm = state.lastMove;
    if (lm && lm.type === 'place' && board[lm.r]?.[lm.c] != null) {
      const owner = board[lm.r][lm.c];
      gStones.appendChild(el('circle', {
        class: 'last-move', cx: pos(lm.c), cy: pos(lm.r), r: 0.16,
        fill: owner === blackSeat ? '#eef0f2' : '#20262d',
      }));
    }

    renderAnnotations(annotations);
    renderHover();
  }

  function renderAnnotations({ marks = [], ghosts = [], regions = [], arrows = [], labels = [] } = {}) {
    gAnnot.innerHTML = '';

    // Region outlines: a rounded rectangle around the bounding box of a set of
    // points — "draw around a formation of stones".
    for (const rg of regions) {
      const rs = rg.points.map((p) => p[0]);
      const cs = rg.points.map((p) => p[1]);
      const pad = rg.pad ?? 0.52;
      const x = pos(Math.min(...cs)) - pad, y = pos(Math.min(...rs)) - pad;
      const w = (Math.max(...cs) - Math.min(...cs)) + pad * 2;
      const h = (Math.max(...rs) - Math.min(...rs)) + pad * 2;
      const rect = el('rect', {
        class: 'annot-region', x, y, width: w, height: h, rx: 0.4,
        stroke: rg.color || '#f2c14e', 'stroke-width': 0.09,
        'stroke-dasharray': rg.dashed === false ? 'none' : '0.32 0.22', fill: 'none',
      });
      gAnnot.appendChild(rect);
      if (rg.label) {
        gAnnot.appendChild(text(pos(Math.min(...cs)) - pad + 0.05, y - 0.12, rg.label, {
          color: rg.color || '#f2c14e', anchor: 'start', size: 0.5,
        }));
      }
    }

    // Ghost / hint stones — translucent stones showing where to play.
    for (const gh of ghosts) {
      const seat = gh.color === 'white' ? 1 - blackSeat : (gh.color === 'black' ? blackSeat : gh.seat);
      const node = el('circle', {
        class: 'annot-ghost', cx: pos(gh.c), cy: pos(gh.r), r: STONE_R,
        fill: seat === blackSeat ? '#1b232c' : '#f2f4f6',
        stroke: gh.color === 'white' ? '#aab2bd' : '#05080b', 'stroke-width': 0.03,
      });
      gAnnot.appendChild(node);
    }

    // Point marks.
    for (const m of marks) {
      const cx = pos(m.c), cy = pos(m.r);
      const color = m.color || '#f2c14e';
      const sw = 0.09;
      if (m.shape === 'square') {
        gAnnot.appendChild(el('rect', { class: 'annot-mark', x: cx - 0.24, y: cy - 0.24, width: 0.48, height: 0.48, fill: 'none', stroke: color, 'stroke-width': sw }));
      } else if (m.shape === 'triangle') {
        gAnnot.appendChild(el('path', { class: 'annot-mark', d: `M${cx} ${cy - 0.28} L${cx + 0.26} ${cy + 0.2} L${cx - 0.26} ${cy + 0.2} Z`, fill: 'none', stroke: color, 'stroke-width': sw }));
      } else if (m.shape === 'cross') {
        gAnnot.appendChild(el('path', { class: 'annot-mark', d: `M${cx - 0.22} ${cy - 0.22} L${cx + 0.22} ${cy + 0.22} M${cx + 0.22} ${cy - 0.22} L${cx - 0.22} ${cy + 0.22}`, stroke: color, 'stroke-width': sw }));
      } else if (m.shape === 'dot') {
        gAnnot.appendChild(el('circle', { class: 'annot-mark', cx, cy, r: 0.14, fill: color }));
      } else { // circle
        gAnnot.appendChild(el('circle', { class: 'annot-mark', cx, cy, r: 0.26, fill: 'none', stroke: color, 'stroke-width': sw }));
      }
    }

    // Arrows.
    for (const a of arrows) {
      const line = el('line', {
        class: 'annot-arrow', x1: pos(a.from[1]), y1: pos(a.from[0]),
        x2: pos(a.to[1]), y2: pos(a.to[0]), 'stroke-width': 0.1,
        'marker-end': 'url(#wq-arrow)',
      });
      line.style.color = a.color || '#e8604c';
      line.setAttribute('stroke', a.color || '#e8604c');
      gAnnot.appendChild(line);
    }

    // Text labels centred on points.
    for (const l of labels) {
      gAnnot.appendChild(text(pos(l.c), pos(l.r), l.text, { color: l.color, anchor: 'middle', size: 0.6, dy: 0.21 }));
    }
  }

  function text(x, y, str, { color = '#f2c14e', anchor = 'middle', size: fs = 0.5, dy = 0 } = {}) {
    const t = el('text', {
      class: 'annot-text', x, y: y + dy, 'text-anchor': anchor, 'font-size': fs, fill: color,
    });
    t.textContent = str;
    return t;
  }

  function renderHover() {
    gHover.innerHTML = '';
    if (!interactive || !hoverPoint || hoverSeat == null) return;
    const [r, c] = hoverPoint;
    gHover.appendChild(el('circle', {
      class: 'hover-ghost', cx: pos(c), cy: pos(r), r: STONE_R,
      fill: hoverSeat === blackSeat ? '#0c1116' : '#eef0f2', opacity: 0.45,
    }));
  }

  function setHover(point, seat) {
    hoverPoint = point;
    hoverSeat = seat;
    renderHover();
  }

  function setInteractive(v) { interactive = v; svg.classList.toggle('locked', !v); }

  // Map a client point to the nearest intersection, or null if outside.
  function pointFromEvent(e) {
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const total = (size - 1) + MARGIN * 2;
    const ux = ((e.clientX - rect.left) / rect.width) * total;
    const uy = ((e.clientY - rect.top) / rect.height) * total;
    const c = Math.round(ux - MARGIN);
    const r = Math.round(uy - MARGIN);
    if (r < 0 || r >= size || c < 0 || c >= size) return null;
    return [r, c];
  }

  svg.addEventListener('pointerup', (e) => {
    if (!interactive) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const p = pointFromEvent(e);
    if (p) onPoint?.(p[0], p[1]);
  });
  svg.addEventListener('pointermove', (e) => {
    if (!interactive || !onHoverCb) return;
    onHoverCb(pointFromEvent(e));
  });
  svg.addEventListener('pointerleave', () => { if (onHoverCb) onHoverCb(null); });

  let onHoverCb = null;

  return {
    svg,
    render,
    setSize(n) { size = n; buildStatic(); },
    setBlackSeat(s) { blackSeat = s; },
    setInteractive,
    setHover,
    onHover(cb) { onHoverCb = cb; },
    pointFromEvent,
    get size() { return size; },
  };
}
