// The Atlaz map component. Renders one region (data/maps JSON) into an SVG
// with mobile-first interaction: one-finger pan, two-finger pinch zoom, wheel
// zoom, double-tap zoom, and tap detection with a nearest-neighbour assist so
// tiny territories (Singapore, microstates, island dots) stay tappable.
//
// The page owns WHAT taps mean (select/confirm/drag targets) — this class only
// reports them. Visual states are CSS classes on the item paths:
//   .sel (outline highlight)  .ok (green fill)  .bad (red fill)
//   .flash (brief wrong-pick pulse)             .placed (jigsaw: borders on)
// plus a root 'silhouette' class for Jigsaw's borderless-region look.

const SVGNS = 'http://www.w3.org/2000/svg';
const MAX_ZOOM = 14;
const TAP_SLOP_PX = 9;         // finger movement allowed within a "tap"
const NEAR_PX = 26;            // tap assist radius (screen px)
const LABEL_PX = 13;           // on-screen label size, kept constant while zooming

export class AtlazMap {
  constructor(host, region, { onTap = null } = {}) {
    this.host = host;
    this.region = region;
    this.onTap = onTap;
    this.k = 1; this.tx = 0; this.ty = 0;
    this.items = new Map(region.items.map((it) => [it.id, it]));
    this.pointers = new Map();  // active pointerId -> {x, y}
    this.gesture = null;        // pan/pinch bookkeeping
    this.tapStart = null;
    this.lastTap = { t: 0, x: 0, y: 0 };

    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${region.w} ${region.h}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.classList.add('atlaz-map');
    this.svg = svg;

    this.vp = document.createElementNS(SVGNS, 'g');
    this.vp.classList.add('map-vp');
    svg.appendChild(this.vp);

    this.pathLayer = document.createElementNS(SVGNS, 'g');
    this.labelLayer = document.createElementNS(SVGNS, 'g');
    this.labelLayer.classList.add('map-labels');
    this.vp.appendChild(this.pathLayer);
    this.vp.appendChild(this.labelLayer);

    // Non-playable neighbouring land + lakes render beneath/above the
    // playable layer; neither takes pointer events (CSS pointer-events:none).
    for (const d of region.ctx || []) {
      const p = document.createElementNS(SVGNS, 'path');
      p.setAttribute('d', d);
      p.classList.add('ctx-land');
      this.pathLayer.appendChild(p);
    }

    // Inset shelves (USA: Alaska & Hawaii): a divider under the mainland plus a
    // box around each relocated territory, so it's obvious they're drawn out of
    // place. Purely decorative — no pointer events (see CSS).
    if (region.insets?.length) {
      if (region.insetTop != null) {
        const line = document.createElementNS(SVGNS, 'line');
        line.setAttribute('x1', 0); line.setAttribute('x2', region.w);
        line.setAttribute('y1', region.insetTop); line.setAttribute('y2', region.insetTop);
        line.classList.add('inset-divider');
        this.pathLayer.appendChild(line);
      }
      for (const inset of region.insets) {
        const [x, y, w, h] = inset.box;
        const r = document.createElementNS(SVGNS, 'rect');
        r.setAttribute('x', x); r.setAttribute('y', y);
        r.setAttribute('width', w); r.setAttribute('height', h);
        r.classList.add('inset-frame');
        this.pathLayer.appendChild(r);
      }
    }

    this.paths = new Map();
    this.labels = new Map();
    for (const it of region.items) {
      const p = document.createElementNS(SVGNS, 'path');
      p.setAttribute('d', it.d);
      p.dataset.id = it.id;
      p.classList.add('territory');
      if (it.dot) p.classList.add('dot');
      this.pathLayer.appendChild(p);
      this.paths.set(it.id, p);
    }

    for (const d of region.lakes || []) {
      const p = document.createElementNS(SVGNS, 'path');
      p.setAttribute('d', d);
      p.classList.add('lake');
      this.pathLayer.appendChild(p);
    }

    svg.addEventListener('pointerdown', (e) => this.#pointerDown(e));
    svg.addEventListener('pointermove', (e) => this.#pointerMove(e));
    svg.addEventListener('pointerup', (e) => this.#pointerUp(e));
    svg.addEventListener('pointercancel', (e) => this.#pointerGone(e));
    svg.addEventListener('wheel', (e) => this.#wheel(e), { passive: false });
    svg.addEventListener('contextmenu', (e) => e.preventDefault());

    host.appendChild(svg);
    this.#apply();
  }

  destroy() { this.svg.remove(); }

  // ---- Coordinates ----------------------------------------------------------

  // Client (screen) → viewBox units.
  clientToView(x, y) {
    const m = this.svg.getScreenCTM();
    if (!m) return [0, 0];
    const inv = m.inverse();
    return [inv.a * x + inv.c * y + inv.e, inv.b * x + inv.d * y + inv.f];
  }

  // Client → map (region data) units, through the current pan/zoom.
  clientToMap(x, y) {
    const [vx, vy] = this.clientToView(x, y);
    return [(vx - this.tx) / this.k, (vy - this.ty) / this.k];
  }

  // Screen pixels per map unit (used for tap radii and the jigsaw ghost).
  pxPerUnit() {
    const m = this.svg.getScreenCTM();
    return (m ? m.a : 1) * this.k;
  }

  // ---- Pan / zoom -----------------------------------------------------------

  #apply() {
    this.vp.setAttribute('transform', `translate(${this.tx} ${this.ty}) scale(${this.k})`);
    const fs = Math.max(LABEL_PX / this.pxPerUnit(), 6);
    if (Math.abs(fs - (this._fs || 0)) > 0.5) {
      this._fs = fs;
      this.labelLayer.style.fontSize = `${fs}px`;
    }
  }

  #clamp() {
    const { w, h } = this.region;
    this.k = Math.min(Math.max(this.k, 1), MAX_ZOOM);
    // Keep at least 15% of the frame covered by map in each axis.
    const minX = 0.15 * w - w * this.k, maxX = 0.85 * w;
    const minY = 0.15 * h - h * this.k, maxY = 0.85 * h;
    this.tx = Math.min(Math.max(this.tx, minX), maxX);
    this.ty = Math.min(Math.max(this.ty, minY), maxY);
  }

  // Zoom by factor around a client point (defaults to centre).
  zoomBy(factor, clientX = null, clientY = null) {
    const rect = this.svg.getBoundingClientRect();
    const cx = clientX ?? rect.left + rect.width / 2;
    const cy = clientY ?? rect.top + rect.height / 2;
    const [vx, vy] = this.clientToView(cx, cy);
    const k2 = Math.min(Math.max(this.k * factor, 1), MAX_ZOOM);
    const f = k2 / this.k;
    this.tx = vx - (vx - this.tx) * f;
    this.ty = vy - (vy - this.ty) * f;
    this.k = k2;
    this.#clamp();
    this.#apply();
  }

  resetView() { this.k = 1; this.tx = 0; this.ty = 0; this.#apply(); }

  zoomToItem(id, targetFrac = 0.4) {
    const it = this.items.get(id);
    if (!it) return;
    const [x0, y0, x1, y1] = it.bbox;
    const { w, h } = this.region;
    const span = Math.max(x1 - x0, (y1 - y0) * (w / h), 1);
    this.k = Math.min(Math.max((w * targetFrac) / span, 1), MAX_ZOOM);
    this.tx = w / 2 - ((x0 + x1) / 2) * this.k;
    this.ty = h / 2 - ((y0 + y1) / 2) * this.k;
    this.#clamp();
    this.#apply();
  }

  // ---- Pointer handling -------------------------------------------------------

  #pointerDown(e) {
    e.preventDefault();
    this.svg.setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 1) {
      this.tapStart = { x: e.clientX, y: e.clientY, t: Date.now(), target: e.target, moved: false };
      this.gesture = { mode: 'pan', x: e.clientX, y: e.clientY };
    } else if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.gesture = { mode: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      if (this.tapStart) this.tapStart.moved = true;
    }
  }

  #pointerMove(e) {
    const pt = this.pointers.get(e.pointerId);
    if (!pt) return;
    pt.x = e.clientX; pt.y = e.clientY;

    if (this.gesture?.mode === 'pan' && this.pointers.size === 1) {
      const dx = e.clientX - this.gesture.x, dy = e.clientY - this.gesture.y;
      if (this.tapStart && Math.hypot(e.clientX - this.tapStart.x, e.clientY - this.tapStart.y) > TAP_SLOP_PX) {
        this.tapStart.moved = true;
      }
      const m = this.svg.getScreenCTM();
      const s = m ? m.a : 1; // client px per viewBox unit
      this.tx += dx / s; this.ty += dy / s;
      this.gesture.x = e.clientX; this.gesture.y = e.clientY;
      this.#clamp();
      this.#apply();
    } else if (this.gesture?.mode === 'pinch' && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      if (this.gesture.d > 0) this.zoomBy(d / this.gesture.d, cx, cy);
      // Also pan with the midpoint so the gesture feels anchored.
      const m = this.svg.getScreenCTM();
      const s = m ? m.a : 1;
      this.tx += (cx - this.gesture.cx) / s;
      this.ty += (cy - this.gesture.cy) / s;
      this.#clamp(); this.#apply();
      this.gesture.d = d; this.gesture.cx = cx; this.gesture.cy = cy;
    }
  }

  #pointerUp(e) {
    const wasTap = this.tapStart && !this.tapStart.moved && this.pointers.size === 1
      && Date.now() - this.tapStart.t < 600;
    // NB: after setPointerCapture, e.target is retargeted to the svg itself —
    // the element actually under the finger is the pointerDOWN target.
    const downTarget = this.tapStart?.target ?? null;
    this.#pointerGone(e);
    if (!wasTap) return;

    const now = Date.now();
    const isDouble = now - this.lastTap.t < 320 && Math.hypot(e.clientX - this.lastTap.x, e.clientY - this.lastTap.y) < 34;
    this.lastTap = { t: isDouble ? 0 : now, x: e.clientX, y: e.clientY };
    if (isDouble) { this.zoomBy(2.1, e.clientX, e.clientY); return; }

    const id = this.hitTest(e.clientX, e.clientY, downTarget);
    this.onTap?.(id, this.clientToMap(e.clientX, e.clientY));
  }

  #pointerGone(e) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 1) {
      const [p] = [...this.pointers.values()];
      this.gesture = { mode: 'pan', x: p.x, y: p.y };
    } else if (this.pointers.size === 0) {
      this.gesture = null;
      this.tapStart = null;
    }
  }

  #wheel(e) {
    e.preventDefault();
    this.zoomBy(e.deltaY < 0 ? 1.18 : 1 / 1.18, e.clientX, e.clientY);
  }

  // Direct hit on a territory path wins (checked at the pointer-up point, then
  // via the pointer-down target); otherwise snap to the item whose bounding box
  // is nearest, within NEAR_PX screen pixels (rescues tiny territories).
  hitTest(clientX, clientY, target = null) {
    const fromPoint = document.elementFromPoint(clientX, clientY)?.closest?.('path[data-id]');
    if (fromPoint && this.svg.contains(fromPoint)) return fromPoint.dataset.id;
    const fromDown = target instanceof Element ? target.closest?.('path[data-id]') : null;
    if (fromDown && this.svg.contains(fromDown)) return fromDown.dataset.id;
    const [mx, my] = this.clientToMap(clientX, clientY);
    const ppu = this.pxPerUnit();
    let best = null, bestD = NEAR_PX;
    for (const it of this.items.values()) {
      // Distance to the bbox rectangle (not its centre) so long, thin
      // territories — Norway, Chile — are reachable along their whole length.
      const dx = Math.max(it.bbox[0] - mx, 0, mx - it.bbox[2]);
      const dy = Math.max(it.bbox[1] - my, 0, my - it.bbox[3]);
      const d = Math.hypot(dx, dy) * ppu;
      if (d < bestD) { bestD = d; best = it.id; }
    }
    return best;
  }

  // ---- Visual state -----------------------------------------------------------

  setState(id, cls, on = true) {
    this.paths.get(id)?.classList.toggle(cls, on);
  }

  clearState(...classes) {
    for (const p of this.paths.values()) p.classList.remove(...classes);
  }

  flash(id) {
    const p = this.paths.get(id);
    if (!p) return;
    p.classList.remove('flash');
    void p.getBBox; // force a tick so re-adding restarts the animation
    requestAnimationFrame(() => p.classList.add('flash'));
    setTimeout(() => p.classList.remove('flash'), 900);
  }

  label(id, cls = '') {
    const it = this.items.get(id);
    if (!it) return;
    let t = this.labels.get(id);
    if (!t) {
      t = document.createElementNS(SVGNS, 'text');
      t.setAttribute('x', it.cx);
      t.setAttribute('y', it.cy);
      t.textContent = it.name;
      this.labelLayer.appendChild(t);
      this.labels.set(id, t);
    }
    t.setAttribute('class', cls);
  }

  unlabel(id) {
    this.labels.get(id)?.remove();
    this.labels.delete(id);
  }

  clearLabels() {
    for (const t of this.labels.values()) t.remove();
    this.labels.clear();
  }

  // Jigsaw: hide all borders until pieces are placed.
  silhouette(on) { this.svg.classList.toggle('silhouette', on); }

  // Wipe every visual state (between questions / runs).
  clearAll() {
    this.clearState('sel', 'ok', 'bad', 'flash', 'placed');
    this.clearLabels();
  }
}
