// chromagrid/js/main.js — Chromagrid main application entry point

import {
  COLORS, SHAPES, SHAPE_PTS, colorShapeMap, BOMB_ICON_SHAPE_PTS, BOMB_ICON_X_SHIFTS,
  BOMB_SPAWN_THRESHOLD, BOMB_TYPES, SPECIALS, mulberry32, idx as engineIdx, rowOf as engineRowOf,
  colOf as engineColOf, visColor, calcScore, pick, newCell, newBombCell, floodFill as engineFloodFill,
  buildBoardForSeed as engineBuildBoardForSeed, dailySeed, dailySlug, dailyDateLabel
} from './engine.js';
import {
  createRoom, joinRoom, fetchRoom, fetchMyRooms, updateRoomStatus, RoomConnection,
  triggerPush, seatName, seatLeft, markPlayerLeft
} from './net.js';
import { GAME_SLUG, configReady } from './config.js';
import { createRematch } from '../../shared/rematch.js';
import { takeRoomParam, hasDailyParam, roomShareUrl } from '../../shared/deep-link.js';
import { cachedUser, onAuthChange, displayName } from '../../shared/auth.js';
import { openHistory } from '../../shared/history.js';
import { filterDismissed, dismissGame, makeDismissControl } from '../../shared/dismissed-games.js';
import { getGuestName } from '../../shared/guest-name.js';
import { saveSession, readSession, clearSession } from '../../shared/game-session.js';
import { playerKey, postScore, fetchTopScores } from '../../shared/leaderboard.js';

let colourBlindMode        = localStorage.getItem('chromagrid-cbm') === '1';
let colourBlindModePending = colourBlindMode;

let COLS = 12, ROWS = 10;
let CELL = 52, GAP = 6;
const PRESS_MS   = 500;
const FLIP_MS    = 450;
const POP_MS     = 320;
const DROP_MS    = 300;
const INTRO_MS   = 420;
const BOMB_MS    = 160;
const RING_MS    = 300;
const VICTIM_MS  = 150;
const NOMATCH_MS = 380;
const TIME_MS    = 120000;
const DEBUG      = false;

function initLayout() {
  COLS = 8; ROWS = 12;
  if (window.innerWidth <= 760) {
    GAP = 4;
    const bodyPadX = 12;
    const gridPadX = 3;
    const cellByW = Math.floor(
      (window.innerWidth - 2 * bodyPadX - 2 * gridPadX - (COLS - 1) * GAP) / COLS
    );
    // Reserve for the unified game header (56px: 10+10 padding around the
    // 36px burger — the tallest flex item — plus its safe-area inset), which
    // replaced body's old 22px menu-button padding.
    const cellByH = Math.floor((window.innerHeight - 288) / ROWS);
    CELL = Math.min(52, Math.max(28, Math.min(cellByW, cellByH)));
  } else {
    GAP = 6;
    // + the unified game header (56px incl. the 36px burger) and body's gap.
    const cellByH = Math.floor((window.innerHeight - 374) / ROWS);
    CELL = Math.min(52, Math.max(34, cellByH));
  }
  // CELL is height-derived, so the real board width varies with the viewport —
  // publish it as --shell-max so the header column hugs the board at every
  // size instead of assuming the 52px-cell maximum.
  const gridPadX = window.innerWidth <= 760 ? 3 : 12;
  const shellW = COLS * CELL + (COLS - 1) * GAP + 2 * gridPadX + 2;
  document.documentElement.style.setProperty('--shell-max', shellW + 'px');
}

// ── canvas renderer ────────────────────────────────────────────────────
const canvas = document.getElementById('grid-canvas');
const ctx    = canvas.getContext('2d');
let boardW = 0, boardH = 0;
let shapePaths = [];

function sizeCanvas() {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  boardW = COLS * CELL + (COLS - 1) * GAP;
  boardH = ROWS * CELL + (ROWS - 1) * GAP;
  canvas.width  = Math.round(boardW * dpr);
  canvas.height = Math.round(boardH * dpr);
  canvas.style.width  = boardW + 'px';
  canvas.style.height = boardH + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  shapePaths = SHAPE_PTS.map(pts => {
    const p = new Path2D();
    pts.forEach(([x, y], k) => {
      const px = (x - 0.5) * CELL, py = (y - 0.5) * CELL;
      k === 0 ? p.moveTo(px, py) : p.lineTo(px, py);
    });
    p.closePath();
    return p;
  });
}

function drawBomb(g, colorHex, type) {
  const R   = CELL * 0.30;
  const TIP = CELL * 0.47;
  const w   = 0.22;
  const spikeAngles = {
    bomb:      [0,1,2,3,4,5,6,7].map(k => k * Math.PI / 4 + Math.PI / 8),
    bombCross: [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2],
    bombX:     [1, 3, 5, 7].map(k => k * Math.PI / 4),
    bombH:     [0, Math.PI],
    bombV:     [Math.PI / 2, 3 * Math.PI / 2],
  };
  const angles = spikeAngles[type] || spikeAngles.bomb;
  g.fillStyle = colorHex;
  g.beginPath();
  for (const a of angles) {
    g.moveTo(Math.cos(a - w) * R * 0.92, Math.sin(a - w) * R * 0.92);
    g.lineTo(Math.cos(a) * TIP,          Math.sin(a) * TIP);
    g.lineTo(Math.cos(a + w) * R * 0.92, Math.sin(a + w) * R * 0.92);
  }
  g.fill();
  g.beginPath(); g.arc(0, 0, R, 0, 2 * Math.PI); g.fill();

  g.strokeStyle = 'rgba(255,255,255,0.92)';
  if (colourBlindMode) {
    const shapeIdx = colorShapeMap.get(colorHex) ?? 0;
    const pts = BOMB_ICON_SHAPE_PTS[shapeIdx] || SHAPE_PTS[shapeIdx];
    const iconHalf = R * 0.52;
    const xShift = (BOMB_ICON_X_SHIFTS[shapeIdx] || 0) * iconHalf * 2;
    g.lineWidth = Math.max(1, CELL * 0.032);
    g.beginPath();
    for (let k = 0; k < pts.length; k++) {
      const px = (pts[k][0] - 0.5) * iconHalf * 2 + xShift;
      const py = (pts[k][1] - 0.5) * iconHalf * 2;
      k === 0 ? g.moveTo(px, py) : g.lineTo(px, py);
    }
    g.closePath();
    g.stroke();
  } else {
    g.strokeStyle = lightenHex(colorHex, 0.65);
    g.lineWidth = Math.max(1.5, CELL * 0.045);
    g.beginPath(); g.arc(0, 0, R * 0.6, 0, 2 * Math.PI); g.stroke();
    g.lineWidth = Math.max(1.5, CELL * 0.055);
    if (type === 'bomb') {
      g.lineWidth = Math.max(1, CELL * 0.03);
      g.beginPath();
      g.moveTo(-R * 0.92, 0); g.lineTo(R * 0.92, 0);
      g.moveTo(0, -R * 0.92); g.lineTo(0, R * 0.92);
      g.stroke();
    } else if (type === 'bombCross') {
      g.beginPath();
      g.moveTo(-R * 0.82, 0); g.lineTo(R * 0.82, 0);
      g.moveTo(0, -R * 0.82); g.lineTo(0, R * 0.82);
      g.stroke();
    } else if (type === 'bombX') {
      const d = R * 0.58;
      g.beginPath();
      g.moveTo(-d, -d); g.lineTo(d, d);
      g.moveTo(d, -d);  g.lineTo(-d, d);
      g.stroke();
    } else if (type === 'bombH') {
      const bx = R * 0.78, aw = R * 0.28, ah = R * 0.18;
      g.beginPath();
      g.moveTo(-bx, 0); g.lineTo(bx, 0);
      g.moveTo(-bx + aw, -ah); g.lineTo(-bx, 0); g.lineTo(-bx + aw, ah);
      g.moveTo(bx - aw, -ah);  g.lineTo(bx, 0);  g.lineTo(bx - aw, ah);
      g.stroke();
    } else if (type === 'bombV') {
      const by = R * 0.78, aw = R * 0.18, ah = R * 0.28;
      g.beginPath();
      g.moveTo(0, -by); g.lineTo(0, by);
      g.moveTo(-aw, -by + ah); g.lineTo(0, -by); g.lineTo(-aw, -by + ah);
      g.moveTo(-aw,  by - ah); g.lineTo(0,  by); g.lineTo(aw,  by - ah);
      g.stroke();
    }
  }
}

// ── animation channels ─────────────────────────────────────────────────
const fx = {
  flips:      new Map(),
  pops:       new Map(),
  drops:      new Map(),
  intro:      new Map(),
  bombPulse:  new Map(),
  bombCharge: new Map(),
  victims:    new Map(),
  noMatch:    new Map(),
  rings:      [],
};
let press    = null;
let hoverIdx = -1;

function clearFx() {
  Object.values(fx).forEach(ch => ch.clear ? ch.clear() : (fx.rings.length = 0));
  press = null;
}

let rafId = 0;
function invalidate() { if (!rafId) rafId = requestAnimationFrame(frame); }
function frame(now) { rafId = 0; if (render(now)) invalidate(); }

let neonRGB = '0,245,255';
function refreshNeonRGB() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--neon').trim();
  if (v) neonRGB = v;
}

// ── easing / keyframe helpers ──────────────────────────────────────────
const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
function lightenHex(hex, t) {
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return `rgb(${Math.round(r+(255-r)*t)},${Math.round(g+(255-g)*t)},${Math.round(b+(255-b)*t)})`;
}
const easeOutQuad = t => 1 - (1 - t) * (1 - t);
const smoothstep  = t => t * t * (3 - 2 * t);

function kf(t, stops) {
  if (t <= stops[0][0]) return stops[0][1];
  for (let k = 1; k < stops.length; k++) {
    if (t <= stops[k][0]) {
      const [t0, v0] = stops[k - 1], [t1, v1] = stops[k];
      return v0 + (v1 - v0) * ((t - t0) / (t1 - t0));
    }
  }
  return stops[stops.length - 1][1];
}

function flipAngle(t) {
  if (t < 0.5) { const u = t / 0.5; return (u * u) * Math.PI / 2; }
  const u = (t - 0.5) / 0.5;
  return Math.PI / 2 + easeOutCubic(u) * Math.PI / 2;
}

function cellCenter(i) {
  return [
    colOf(i) * (CELL + GAP) + CELL / 2,
    rowOf(i) * (CELL + GAP) + CELL / 2,
  ];
}

function render(now) {
  ctx.clearRect(0, 0, boardW, boardH);
  if (phase === 'idle' || !state.length) return false;
  refreshNeonRGB();

  let active = false;
  const bombsOnTop = [];

  for (let i = 0; i < state.length; i++) {
    const isExploding = fx.bombPulse.has(i);
    if (isExploding) { bombsOnTop.push(i); continue; }
    if (drawTile(now, i)) active = true;
  }
  for (const i of bombsOnTop) if (drawTile(now, i)) active = true;

  for (let k = fx.rings.length - 1; k >= 0; k--) {
    const ring = fx.rings[k];
    const t = (now - ring.start) / RING_MS;
    if (t >= 1) { fx.rings.splice(k, 1); continue; }
    active = true;
    const maxSc = ring.maxScale || 3.8;
    const scale = 0.15 + maxSc * easeOutCubic(t);
    const alpha = kf(t, [[0, 1], [0.4, 0.85], [1, 0]]);
    const radius = (CELL / 2) * scale;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = 'rgba(255,136,50,0.95)';
    ctx.lineWidth = 3;

    if (!ring.type || ring.type === 'bomb') {
      ctx.beginPath();
      ctx.arc(ring.cx, ring.cy, radius, 0, 2 * Math.PI);
      ctx.stroke();
    } else {
      const dirAngles = {
        bombCross: [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2],
        bombX:     [1, 3, 5, 7].map(k => k * Math.PI / 4),
        bombH:     [0, Math.PI],
        bombV:     [Math.PI / 2, 3 * Math.PI / 2],
      };
      const angles = dirAngles[ring.type] || [];
      const isLong = ring.type === 'bombH' || ring.type === 'bombV';
      const arcW = isLong ? Math.PI / 4 : Math.PI / 5;

      if (isLong) {
        ctx.save();
        ctx.globalAlpha = alpha * 0.28;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (const a of angles) {
          ctx.moveTo(ring.cx, ring.cy);
          ctx.lineTo(ring.cx + Math.cos(a) * radius, ring.cy + Math.sin(a) * radius);
        }
        ctx.stroke();
        ctx.restore();
      }

      ctx.lineWidth = isLong ? 4 : 3;
      for (const a of angles) {
        ctx.beginPath();
        ctx.arc(ring.cx, ring.cy, radius, a - arcW / 2, a + arcW / 2);
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  if (press) active = true;
  return active;
}

function drawTile(now, i) {
  const s = state[i];
  if (!s) return false;

  let [cx, cy] = cellCenter(i);
  let alpha = 1, sc = 1, rot = 0, dy = 0;
  let white = 0, glowColor = null, glowBlur = 0;
  let sx = (!colourBlindMode && s.flipped && !s.special) ? -1 : 1;
  let color = visColor(s).hex;
  let active = false;

  const intro = fx.intro.get(i);
  if (intro) {
    const t = (now - intro.start - intro.delay) / INTRO_MS;
    if (t >= 1) fx.intro.delete(i);
    else {
      active = true;
      if (t < 0) return true;
      dy    = -60 * (1 - easeOutCubic(t));
      alpha = Math.min(1, t / 0.6);
    }
  }

  const drop = fx.drops.get(i);
  if (drop) {
    const t = (now - drop.start) / DROP_MS;
    if (t >= 1) fx.drops.delete(i);
    else { active = true; dy = -drop.fromPx * (1 - smoothstep(t)); }
  }

  const flip = fx.flips.get(i);
  if (flip) {
    const t = (now - flip.start) / FLIP_MS;
    if (t >= 1) fx.flips.delete(i);
    else {
      active = true;
      const angle = flipAngle(t);
      sx = colourBlindMode ? Math.abs(Math.cos(angle)) : (s.flipped ? 1 : -1) * Math.cos(angle);
      color = (t < 0.5 ? (s.flipped ? s.frontColor : s.backColor) : visColor(s)).hex;
    }
  }

  const pop = fx.pops.get(i);
  if (pop) {
    const t = (now - pop.start) / POP_MS;
    if (t >= 1) return false;
    active = true;
    sc   *= kf(t, [[0, 1], [0.35, 1.28], [1, 0]]);
    rot   = kf(t, [[0, 0], [0.35, 4], [1, -8]]) * Math.PI / 180;
    alpha *= kf(t, [[0, 1], [0.35, 1], [1, 0]]);
  }

  const vic = fx.victims.get(i);
  if (vic) {
    const t = (now - vic.start) / VICTIM_MS;
    if (t >= 1) return false;
    active = true;
    sc    *= kf(t, [[0, 1], [0.35, 1.45], [1, 0]]);
    alpha *= kf(t, [[0, 1], [0.35, 0.9], [1, 0]]);
  }

  const charge = fx.bombCharge.get(i);
  if (charge) {
    const t = Math.min(1, (now - charge.start) / POP_MS);
    active = true;
    sc *= 1 + Math.sin(t * Math.PI * 3) * 0.12 * easeOutCubic(t);
    if (t > 0.8) white = easeOutCubic((t - 0.8) / 0.2) * 0.75;
  }

  const pulse = fx.bombPulse.get(i);
  if (pulse) {
    const t = Math.min(1, (now - pulse.start) / BOMB_MS);
    if (t >= 1) return false;
    active = true;
    sc    *= kf(t, [[0, 1], [0.28, 2.3], [0.62, 1.9], [1, 1.5]]);
    alpha *= kf(t, [[0, 1], [0.28, 1], [0.62, 0.9], [1, 0]]);
    white  = kf(t, [[0, 0.9], [0.28, 0.85], [0.62, 0.45], [1, 0]]);
  }

  const nm = fx.noMatch.get(i);
  if (nm) {
    const t = (now - nm.start) / NOMATCH_MS;
    if (t >= 1) fx.noMatch.delete(i);
    else {
      active = true;
      const k2 = kf(t, [[0, 0], [0.4, 1], [1, 0]]);
      glowColor = 'rgba(255,64,64,0.9)'; glowBlur = 8 * k2;
      white = 0.25 * k2;
    }
  }

  if (press && press.i === i) {
    const t = Math.min(1, (now - press.start) / PRESS_MS);
    glowColor = `rgba(${neonRGB},0.9)`; glowBlur = 2 + 18 * t;
    white = Math.max(white, 0.22 * t);
  } else if (hoverIdx === i && !press && phase === 'playing' && !isAnimating) {
    sc *= 1.1; sx *= 0.95;
    glowColor = `rgba(${neonRGB},0.7)`; glowBlur = 8;
  }

  if (alpha <= 0 || sc <= 0) return active;

  ctx.save();
  ctx.translate(cx, cy + dy);
  if (rot) ctx.rotate(rot);
  ctx.scale(sc * sx, sc);
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  if (glowColor) { ctx.shadowColor = glowColor; ctx.shadowBlur = glowBlur; }

  if (s.special) {
    drawBomb(ctx, color, s.special.type);
    if (white > 0) {
      ctx.shadowBlur = 0;
      ctx.fillStyle = `rgba(255,255,255,${white})`;
      ctx.beginPath(); ctx.arc(0, 0, CELL * 0.47, 0, 2 * Math.PI); ctx.fill();
    }
  } else {
    const path = shapePaths[colourBlindMode ? (colorShapeMap.get(color) ?? 0) : (s.shape ?? 0)];
    ctx.fillStyle = color;
    ctx.fill(path);
    if (white > 0) {
      ctx.shadowBlur = 0;
      ctx.fillStyle = `rgba(255,255,255,${white})`;
      ctx.fill(path);
    }
  }
  ctx.restore();
  return active;
}

const CHAIN_STAGGER_MS = 90;

let _bombTypeIdx = 0;
function getSpawnType(groupSize) {
  if (groupSize >= BOMB_SPAWN_THRESHOLD) return BOMB_TYPES[_bombTypeIdx++ % BOMB_TYPES.length];
  return null;
}

let rng = Math.random;

let isDaily = false;
let roomMode = false;
let roomEndHook = null;

function enterDailyChallenge() {
  isDaily = true;
  startGame(dailySeed());
}

let state       = [];
let score       = 0;
let isAnimating = false;
let phase       = 'idle';
let timerDeadline = 0;
let timerInterval = null;

function idx(r, c)  { return engineIdx(r, c, COLS); }
function rowOf(i)   { return engineRowOf(i, COLS); }
function colOf(i)   { return engineColOf(i, COLS); }

function floodFill(startIdx) {
  return engineFloodFill(state, startIdx, ROWS, COLS);
}

let deltaClearTimer = null;
function showDelta(text) {
  const el = document.getElementById('score-delta');
  el.textContent = text;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(deltaClearTimer);
  deltaClearTimer = setTimeout(() => el.classList.remove('show'), 1100);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function popAndDrop(indices, originIdx) {
  if (isAnimating) return;
  isAnimating = true;

  const poppedSet  = new Set(indices);
  const firedBombs = new Set();
  const waveData   = [];

  {
    const wave0 = indices.filter(i => state[i].special && SPECIALS[state[i].special.type]);
    if (wave0.length > 0) {
      wave0.forEach(i => firedBombs.add(i));
      waveData.push({ bombs: wave0, victims: [] });

      let wi = 0;
      while (wi < waveData.length) {
        const nextBombs = [];
        for (const bombIdx of waveData[wi].bombs) {
          const newCells = SPECIALS[state[bombIdx].special.type].expandPop(bombIdx, poppedSet, ROWS, COLS);
          for (const ni of newCells) {
            const niSpec = state[ni].special;
            if (niSpec && SPECIALS[niSpec.type] && !firedBombs.has(ni)) {
              firedBombs.add(ni);
              nextBombs.push(ni);
            } else {
              waveData[wi].victims.push(ni);
            }
          }
        }
        if (nextBombs.length > 0) waveData.push({ bombs: nextBombs, victims: [] });
        wi++;
      }
    }
  }

  const t0 = performance.now();
  indices.forEach(i => {
    if (!firedBombs.has(i)) { fx.pops.set(i, { start: t0 }); fx.flips.delete(i); }
  });
  invalidate();

  if (waveData.length > 0) {
    waveData[0].bombs.forEach(b => { fx.bombCharge.set(b, { start: t0 }); fx.flips.delete(b); });
    invalidate();

    const fireWave = w => {
      const { bombs, victims } = waveData[w];
      const t = performance.now();
      const bombMaxDist = new Map();
      for (const bi of bombs) {
        const [bx, by] = cellCenter(bi);
        let maxD = CELL;
        for (const vi of victims) { const [vx,vy]=cellCenter(vi); maxD=Math.max(maxD,Math.hypot(vx-bx,vy-by)); }
        bombMaxDist.set(bi, maxD);
      }
      for (const bombIdx of bombs) {
        fx.bombCharge.delete(bombIdx);
        fx.bombPulse.set(bombIdx, { start: t });
        const [cx, cy] = cellCenter(bombIdx);
        const maxScale = (bombMaxDist.get(bombIdx) / (CELL / 2)) * 1.15;
        fx.rings.push({ cx, cy, start: t, maxScale, type: state[bombIdx].special.type });
      }
      victims.forEach(vi => {
        fx.flips.delete(vi);
        const [vx, vy] = cellCenter(vi);
        let minDelay = Infinity;
        for (const bi of bombs) {
          const [bx, by] = cellCenter(bi);
          const dist = Math.hypot(vx - bx, vy - by);
          const maxD = bombMaxDist.get(bi);
          const maxSc = (maxD / (CELL / 2)) * 1.15;
          const ratio = Math.max(0, Math.min(1, (dist / (CELL / 2) - 0.15) / maxSc));
          const waveT = 1 - Math.cbrt(1 - ratio);
          minDelay = Math.min(minDelay, waveT * RING_MS);
        }
        setTimeout(() => { fx.victims.set(vi, { start: performance.now() }); invalidate(); }, minDelay);
      });
      invalidate();
    };

    setTimeout(() => {
      fireWave(0);
      for (let w = 1; w < waveData.length; w++) setTimeout(() => fireWave(w), w * CHAIN_STAGGER_MS);
    }, POP_MS);

    const totalDelay = POP_MS + (waveData.length - 1) * CHAIN_STAGGER_MS + RING_MS + VICTIM_MS;
    await sleep(totalDelay);
  } else {
    await sleep(340);
  }

  const pts = calcScore(poppedSet.size);
  score += pts;
  document.getElementById('score-val').textContent = score;
  showDelta(`+${pts}`);

  const spawnType = getSpawnType(indices.length);
  const bombColor = spawnType ? visColor(state[originIdx]) : null;
  const originCol = colOf(originIdx);

  const dropInfo = new Map();

  for (let c = 0; c < COLS; c++) {
    const survivors = [];
    for (let r = 0; r < ROWS; r++) {
      if (!poppedSet.has(idx(r, c))) survivors.push({ origRow: r, data: state[idx(r, c)] });
    }
    const missing = ROWS - survivors.length;
    let bombPlaced = false;
    for (let k = 0; k < missing; k++) {
      let data;
      if (!bombPlaced && spawnType && c === originCol && k === 0) {
        data = newBombCell(bombColor, spawnType);
        bombPlaced = true;
      } else {
        data = newCell(rng);
      }
      survivors.unshift({ origRow: -(missing - k), data });
    }
    for (let r = 0; r < ROWS; r++) {
      const { origRow, data } = survivors[r];
      const ni     = idx(r, c);
      const fallen = r - origRow;
      state[ni] = data;
      if (fallen !== 0) dropInfo.set(ni, fallen);
    }
  }

  fx.pops.clear(); fx.victims.clear(); fx.bombPulse.clear(); fx.bombCharge.clear(); fx.flips.clear();
  const t1 = performance.now();
  dropInfo.forEach((fallen, ni) => fx.drops.set(ni, { start: t1, fromPx: fallen * (CELL + GAP) }));
  invalidate();
  updateStatus();
  isAnimating = false;
}

// ── input ──────────────────────────────────────────────────────────────
function cellAt(e) {
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  const stride = CELL + GAP;
  const c = Math.floor(x / stride), r = Math.floor(y / stride);
  if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return -1;
  return idx(r, c);
}

let pressTimer = null, longFired = false, downX = 0, downY = 0;

function cancelPress() {
  clearTimeout(pressTimer);
  pressTimer = null;
  press = null;
  invalidate();
}

canvas.addEventListener('pointerdown', e => {
  if (isAnimating || phase !== 'playing') return;
  const i = cellAt(e);
  if (i < 0) return;
  longFired = false;
  downX = e.clientX; downY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
  press = { i, start: performance.now() };
  invalidate();
  pressTimer = setTimeout(() => {
    longFired = true;
    const pi = press ? press.i : i;
    cancelPress();
    onLongPress(pi);
  }, PRESS_MS);
});

canvas.addEventListener('pointermove', e => {
  if (press && (Math.abs(e.clientX - downX) > 8 || Math.abs(e.clientY - downY) > 8)) {
    cancelPress();
  }
  if (e.pointerType === 'mouse' && !press) {
    const i = (phase === 'playing' && !isAnimating) ? cellAt(e) : -1;
    if (i !== hoverIdx) {
      hoverIdx = i;
      canvas.style.cursor = i >= 0 ? 'pointer' : '';
      invalidate();
    }
  }
});

canvas.addEventListener('pointerup', e => {
  const wasTap = press && !longFired
    && Math.abs(e.clientX - downX) <= 8 && Math.abs(e.clientY - downY) <= 8;
  const i = press ? press.i : -1;
  cancelPress();
  if (wasTap) onTap(i);
});

canvas.addEventListener('pointercancel', cancelPress);
canvas.addEventListener('pointerleave', () => {
  if (hoverIdx !== -1) { hoverIdx = -1; canvas.style.cursor = ''; invalidate(); }
});

function onTap(i) {
  if (i < 0 || isAnimating || phase !== 'playing') return;
  const s = state[i];
  if (s.special) return;
  s.flipped = !s.flipped;
  fx.flips.set(i, { start: performance.now() });
  invalidate();
  updateStatus();
}

function onLongPress(i) {
  if (isAnimating || phase !== 'playing') return;
  const group = floodFill(i);
  if (group.length >= 4) {
    popAndDrop(group, i);
  } else {
    fx.noMatch.set(i, { start: performance.now() });
    invalidate();
  }
}

// ── status bar ──────────────────────────────────────────────────────────
function updateStatus() {
  const el = document.getElementById('status');
  if (phase === 'idle') {
    el.textContent = 'SYS_STANDBY > AWAITING INITIALIZATION';
    return;
  }
  if (phase === 'over') {
    el.textContent = `SYS_HALT > TIME EXPIRED > FINAL SCORE ${score.toLocaleString()}`;
    return;
  }
  const total   = ROWS * COLS;
  const flipped = state.filter(s => s.flipped).length;
  el.textContent =
    `SYS_ACTIVE > ${total} TILES > ${flipped} FLIPPED > ${total - flipped} FACE-UP`;
}

const btnFlipAll = document.getElementById('btn-flip-all');

async function flipAll() {
  if (isAnimating || phase !== 'playing') return;
  isAnimating = true;
  btnFlipAll.disabled = true;

  const w0 = Date.now();
  while (fx.flips.size && Date.now() - w0 < 600) await sleep(50);

  const t = performance.now();
  state.forEach((s, i) => {
    if (s.special) return;
    s.flipped = !s.flipped;
    fx.flips.set(i, { start: t });
  });
  invalidate();
  updateStatus();
  isAnimating = false;
  setTimeout(() => { if (phase === 'playing') btnFlipAll.disabled = false; }, FLIP_MS + 50);
}

btnFlipAll.addEventListener('click', flipAll);

// ── countdown timer ───────────────────────────────────────────────────
function renderTimer(ms) {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  const el = document.getElementById('timer');
  el.textContent = `${m}:${String(s).padStart(2, '0')}`;
  el.classList.toggle('warn',   total <= 30 && total > 10);
  el.classList.toggle('danger', total <= 10 && phase === 'playing');
}

function tickTimer() {
  const remaining = Math.max(0, timerDeadline - Date.now());
  renderTimer(remaining);
  if (remaining <= 0) endGame();
}

function stopClock() {
  clearInterval(timerInterval);
  timerInterval = null;
}

// ── game flow ─────────────────────────────────────────────────────────
const startOverlay    = document.getElementById('start-overlay');
const gameoverOverlay = document.getElementById('gameover-overlay');

function goIdle() {
  isDaily = false;
  document.getElementById('daily-modal').classList.add('hidden');
  initLayout();
  sizeCanvas();
  stopClock();
  clearFx();
  phase = 'idle';
  state = [];
  document.body.classList.remove('playing');
  score = 0;
  document.getElementById('score-val').textContent = '0';
  document.getElementById('timer').classList.remove('warn', 'danger', 'over');
  renderTimer(TIME_MS);
  invalidate();
  startOverlay.classList.remove('hidden');
  gameoverOverlay.classList.add('hidden');
  btnFlipAll.disabled = true;
  updateStatus();
}

async function startGame(seed = null, opts = {}) {
  if (phase === 'playing') return;
  roomMode = !!opts.room;
  colourBlindMode = colourBlindModePending;
  initLayout();
  sizeCanvas();
  clearFx();
  phase = 'playing';
  _bombTypeIdx = 0;
  document.body.classList.add('playing');
  score = 0;
  document.getElementById('score-val').textContent = '0';
  document.getElementById('timer').classList.remove('warn', 'danger', 'over');
  renderTimer(TIME_MS);
  startOverlay.classList.add('hidden');
  gameoverOverlay.classList.add('hidden');
  document.getElementById('daily-modal').classList.add('hidden');
  rng = seed !== null ? mulberry32(seed) : Math.random;
  state = Array.from({ length: ROWS * COLS }, () => newCell(rng));
  rng = Math.random;
  const t = performance.now();
  for (let i = 0; i < state.length; i++) {
    fx.intro.set(i, { start: t, delay: rowOf(i) * 30 + colOf(i) * 12 });
  }
  invalidate();
  updateStatus();

  const cascadeMs = (ROWS - 1) * 30 + (COLS - 1) * 12 + INTRO_MS + 150;
  await sleep(cascadeMs);
  if (phase !== 'playing') return;
  fx.intro.clear();
  invalidate();
  btnFlipAll.disabled = false;
  if (roomMode) return;
  timerDeadline = Date.now() + TIME_MS;
  tickTimer();
  timerInterval = setInterval(tickTimer, 200);
}

async function endGame() {
  if (phase !== 'playing') return;
  phase = 'over';
  document.body.classList.remove('playing');
  stopClock();
  renderTimer(0);
  document.getElementById('timer').classList.add('over');
  btnFlipAll.disabled = true;
  while (isAnimating) await sleep(50);
  updateStatus();
  if (roomMode) {
    if (typeof roomEndHook === 'function') roomEndHook(score);
    return;
  }
  if (isDaily) {
    const lbEl = document.getElementById('daily-lb-list');
    document.getElementById('daily-date-label').textContent = dailyDateLabel();
    document.getElementById('daily-final-score').textContent = score.toLocaleString();
    document.getElementById('daily-final-score').classList.remove('hidden');
    document.getElementById('daily-score-label').classList.remove('hidden');
    document.getElementById('btn-daily-play-again').classList.remove('hidden');
    lbEl.innerHTML = '<div class="daily-lb-empty">Submitting…</div>';
    document.getElementById('daily-modal').classList.remove('hidden');
    if (window.__dailySubmitAndFetch) {
      window.__dailySubmitAndFetch(score, dailySlug(), lbEl).catch(() => {
        lbEl.innerHTML = '<div class="daily-lb-empty">Could not load leaderboard.</div>';
      });
    }
  } else {
    document.getElementById('go-score').textContent = score.toLocaleString();
    gameoverOverlay.classList.remove('hidden');
    if (isHighScore(score)) autoSaveScore(score);
    window.dispatchEvent(new CustomEvent('chromagrid:gameover', { detail: { score } }));
  }
}

// ── local high scores ─────────────────────────────────────────────────
const HS_KEY = 'chromagrid.highscores';
const HS_MAX = 1;
let highScores = [];

function loadHighScores() {
  try {
    const arr = JSON.parse(localStorage.getItem(HS_KEY) || '[]');
    return Array.isArray(arr)
      ? arr.filter(e => e && typeof e.score === 'number').slice(0, HS_MAX)
      : [];
  } catch { return []; }
}

function saveHighScores() {
  try { localStorage.setItem(HS_KEY, JSON.stringify(highScores)); } catch {}
}

function renderBestScore(flash) {
  const el = document.getElementById('best-val');
  if (!el) return;
  if (!highScores.length) { el.textContent = '—'; return; }
  el.textContent = highScores[0].score.toLocaleString();
  if (flash) {
    el.style.color = 'var(--yellow)';
    setTimeout(() => { el.style.color = ''; }, 1200);
  }
}

function isHighScore(s) {
  if (s <= 0) return false;
  if (highScores.length < HS_MAX) return true;
  return s > highScores[highScores.length - 1].score;
}

function autoSaveScore(s) {
  const ts = Date.now();
  highScores.push({ score: s, ts });
  highScores.sort((a, b) => b.score - a.score);
  highScores = highScores.slice(0, HS_MAX);
  saveHighScores();
  renderBestScore(true);
}

highScores = loadHighScores();
renderBestScore();

document.getElementById('btn-reset').addEventListener('click', () => {
  if (isAnimating) return;
  if (phase === 'playing' && !isDaily && isHighScore(score)) autoSaveScore(score);
  goIdle();
});

document.getElementById('btn-start').addEventListener('click', () => startGame());
document.getElementById('btn-play-again').addEventListener('click', () => startGame());
document.getElementById('btn-daily').addEventListener('click', enterDailyChallenge);
document.getElementById('btn-daily-play-again').addEventListener('click', enterDailyChallenge);

function closeDailyModal() {
  document.getElementById('daily-modal').classList.add('hidden');
  if (phase === 'over') goIdle();
}
document.getElementById('daily-close').addEventListener('click', closeDailyModal);
document.getElementById('btn-daily-done').addEventListener('click', closeDailyModal);

document.getElementById('btn-daily-lb').addEventListener('click', () => {
  const modal = document.getElementById('daily-modal');
  if (!modal.classList.contains('hidden')) return;
  document.getElementById('daily-date-label').textContent = dailyDateLabel();
  document.getElementById('daily-final-score').classList.add('hidden');
  document.getElementById('daily-score-label').classList.add('hidden');
  document.getElementById('btn-daily-play-again').classList.add('hidden');
  const lbEl = document.getElementById('daily-lb-list');
  lbEl.innerHTML = '<div class="daily-lb-empty">Loading…</div>';
  modal.classList.remove('hidden');
  if (window.__dailyFetchLB) {
    window.__dailyFetchLB(dailySlug(), lbEl).catch(() => {
      lbEl.innerHTML = '<div class="daily-lb-empty">Could not load leaderboard.</div>';
    });
  }
});

const cbmCheck = document.getElementById('cbm-check');
const cbmStart = document.getElementById('cbm-start');
function setCBM(val) {
  colourBlindModePending = val;
  cbmCheck.checked = val;
  cbmStart.checked = val;
  localStorage.setItem('chromagrid-cbm', val ? '1' : '0');
  if (phase !== 'playing') { colourBlindMode = val; invalidate(); }
}
setCBM(colourBlindMode);
cbmCheck.addEventListener('change', () => setCBM(cbmCheck.checked));
cbmStart.addEventListener('change', () => setCBM(cbmStart.checked));
document.addEventListener('gesturestart',  e => e.preventDefault(), { passive: false });
document.addEventListener('gesturechange', e => e.preventDefault(), { passive: false });

const SITE_URL = 'https://icecreamlorry.github.io/lb-games/chromagrid/';

document.getElementById('btn-copy').addEventListener('click', async () => {
  const best = highScores.length ? highScores[0].score : null;
  const text = best
    ? `I scored ${best.toLocaleString()} on CHROMAGRID — can you beat it?\n${SITE_URL}`
    : `playing CHROMAGRID — 2 minutes, beat your high score.\n${SITE_URL}`;
  try {
    await navigator.clipboard.writeText(text);
    const btn = document.getElementById('btn-copy');
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 1500);
  } catch {}
});

document.getElementById('btn-share').addEventListener('click', async () => {
  const btn = document.getElementById('btn-share');
  try {
    const best = highScores.length ? highScores[0].score : null;
    const shareText = best
      ? `I scored ${best.toLocaleString()} on CHROMAGRID — can you beat it?`
      : 'CHROMAGRID — 2 minutes, beat your high score.';
    if (navigator.share) {
      await navigator.share({ title: 'CHROMAGRID', text: shareText, url: SITE_URL });
    } else {
      await navigator.clipboard.writeText(shareText + '\n' + SITE_URL);
      btn.classList.add('copied');
      setTimeout(() => btn.classList.remove('copied'), 1500);
    }
  } catch {}
});

if (DEBUG) {
  const debugBtn = document.createElement('button');
  debugBtn.textContent = 'DEBUG: ADD BOMBS';
  debugBtn.style.cssText = [
    'position:fixed', 'bottom:12px', 'right:12px', 'z-index:999',
    'font-size:0.65rem', 'padding:5px 10px', 'opacity:0.75',
    'border-color:#ff4400', 'color:#ff4400',
  ].join(';');
  document.body.appendChild(debugBtn);
  debugBtn.addEventListener('click', () => {
    if (phase !== 'playing' || isAnimating) return;
    const indices = [...Array(state.length).keys()]
      .sort(() => Math.random() - 0.5)
      .slice(0, 10);
    indices.forEach(i => { state[i] = newBombCell(pick(COLORS, null)); });
    invalidate();
  });
}

// ── multiplayer bridge ─────────────────────────────────────────────────
const COUNTDOWN_MS = 3000;

function buildBoardForSeed(seed) {
  return engineBuildBoardForSeed(seed, ROWS, COLS);
}

window.CG = {
  TIME_MS,
  COUNTDOWN_MS,
  buildBoardForSeed,
  getScore: () => score,
  getPhase: () => phase,

  async prepareRoom(seed, onEnd) {
    roomEndHook = onEnd || null;
    if (phase === 'playing') { roomMode = false; goIdle(); }
    isDaily = false;
    await startGame(seed, { room: true });
  },

  beginRoomClock(deadline) {
    if (phase !== 'playing') return;
    timerDeadline = deadline;
    if (!timerInterval) {
      tickTimer();
      timerInterval = setInterval(tickTimer, 200);
    }
  },

  leaveRoom() {
    roomMode = false;
    roomEndHook = null;
    goIdle();
  },

  startDaily() {
    document.getElementById('btn-leave-game').classList.add('hidden');
    document.getElementById('btn-reset').classList.remove('hidden');
    enterDailyChallenge();
  },
};

goIdle();

// ── multiplayer room lifecycle ──────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const MAX_PLAYERS = 8;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const GAME_MS = (window.CG && window.CG.TIME_MS) || 120000;

const app = {
  user: null, userId: null, name: null,
  code: null, seat: null, room: null, conn: null,
  phase: 'idle',         // idle | waiting | countdown | playing | results
  startAt: null,         // epoch ms the countdown began (from the start move)
  online: new Set(),
  results: {},           // seat -> { score }
  submittedResult: false,
  timerInt: null,
  rematching: false,
  started: false,        // have we kicked off the board build for this room?
};

function playerName() { return app.user ? displayName(app.user) : getGuestName(); }

// ---- Screens ----------------------------------------------------------

function showLobby() { $('screen-lobby').classList.remove('hidden'); renderLobby(); }
function hideLobby() { $('screen-lobby').classList.add('hidden'); stopLobbyPolling(); }

// ---- Auth -------------------------------------------------------------

function onAuth(user) {
  app.user = user;
  app.userId = user?.id ?? null;
  app.name = playerName();
  $('btn-go-lobby')?.classList.toggle('hidden', !user);
  if (!app.code && window.CG.getPhase() !== 'playing') {
    if (user) showLobby(); else hideLobby();
  }
}

// ---- Lobby ------------------------------------------------------------

let lobbyPoll = null;
function startLobbyPolling() {
  stopLobbyPolling();
  lobbyPoll = setInterval(() => {
    if (!$('screen-lobby').classList.contains('hidden') && !document.hidden) renderLobby();
  }, 6000);
}
function stopLobbyPolling() { if (lobbyPoll) { clearInterval(lobbyPoll); lobbyPoll = null; } }

function lobbyError(m) { const e = $('lobby-error'); if (e) e.textContent = m || ''; }

async function renderLobby() {
  if (!app.userId) return;
  startLobbyPolling();
  const nm = $('lobby-name'); if (nm) nm.textContent = app.name || 'player';
  let rooms;
  try { rooms = await fetchMyRooms(app.userId); }
  catch (e) { lobbyError(`Could not load games (${e.message}).`); return; }
  rooms = filterDismissed(app.userId, rooms);
  const list = $('lobby-list');
  if (!list) return;
  if (!rooms.length) {
    list.innerHTML = '<p class="lobby-empty">No games yet. <strong>NEW GAME</strong> to start one, or challenge a friend.</p>';
    return;
  }
  list.innerHTML = '';
  for (const room of rooms) list.appendChild(lobbyCard(room));
}

function lobbyCard(room) {
  const players = room.players ?? [];
  const invitedMe = room.invited_user_id === app.userId && players.every((p) => p.userId !== app.userId);
  const finished = room.status === 'finished';
  const playing = room.status === 'playing';
  let label, status, live = false;
  if (invitedMe) { label = `${players[0]?.name || 'Someone'} invited you`; status = 'Tap to join'; live = true; }
  else { label = `${players.length} player${players.length === 1 ? '' : 's'}`; status = finished ? 'Finished' : playing ? 'In progress' : 'Waiting — tap to open'; live = playing; }

  const card = document.createElement('button');
  card.className = 'lobby-game' + (live ? ' live' : '');
  card.innerHTML = `<span class="lobby-opp">${esc(label)}</span><span class="lobby-status">${esc(status)}</span>`
    + `<span class="lobby-score">${room.code}</span>`;
  card.addEventListener('click', () => (
    finished ? openHistory({ userId: app.userId, gameSlug: GAME_SLUG }) : openFromLobby(room)
  ));
  card.appendChild(makeDismissControl({
    userId: app.userId, code: room.code, card,
    onRemoved: () => { if (!$('lobby-list').children.length) renderLobby(); },
  }));
  return card;
}

async function openFromLobby(room) {
  try {
    const { room: updated, playerIndex } = await joinRoom(room.code, app.name, app.userId);
    await enterRoom(room.code, playerIndex, app.name, updated);
  } catch (e) { lobbyError(e.message); }
}

// ---- Challenge a friend ----------------------------------------------

async function challengeFriend(friend) {
  try {
    if (!app.name) { lobbyError('Set your name first.'); return; }
    const room = await createRoom(app.name, app.userId, { userId: friend.id, name: friend.display_name }, MAX_PLAYERS);
    triggerPush({ user_id: friend.id, title: 'Chromagrid challenge!', body: `${app.name} challenged you to Chromagrid.`, url: location.href.split('#')[0] }).catch(() => {});
    await enterRoom(room.code, 0, app.name, room);
  } catch (e) { lobbyError(e.message); }
}

// ---- Room / game ------------------------------------------------------

function resetRoomState() {
  if (app.conn) { app.conn.close(); app.conn = null; }
  app.phase = 'idle'; app.startAt = null;
  app.results = {}; app.submittedResult = false;
  app.rematching = false; app.started = false;
  if (app.timerInt) { clearInterval(app.timerInt); app.timerInt = null; }
  if ($('btn-rematch')) $('btn-rematch').disabled = false;
}

let enterGen = 0;
async function enterRoom(code, seat, name, room) {
  if (app.code === code && app.conn) { hideLobby(); return; }
  const gen = ++enterGen;
  resetRoomState();
  app.code = code; app.seat = seat; app.name = name; app.room = room;
  hideLobby();

  await window.CG.prepareRoom(Number(room.seed), onRoomEnd);
  if (gen !== enterGen) return;

  $('btn-reset').classList.add('hidden');
  $('btn-leave-game').classList.remove('hidden');

  setPhase('waiting');
  saveSession(GAME_SLUG, { code, name }, app.userId);

  app.conn = new RoomConnection(code, seat, name, {
    onMove: handleMove,
    onPresence: handlePresence,
    onRoomUpdate: handleRoomUpdate,
  });
  app.conn.connect();
}

function handleMove(move) {
  if (move.type === 'rematch') { rematch.follow(move.payload?.code); return; }
  if (move.type === 'start') {
    if (app.startAt == null) {
      app.startAt = Number(move.payload?.startAt) || Date.parse(move.created_at) || Date.now();
    }
    startTimers();
  } else if (move.type === 'result') {
    const sc = Number(move.payload?.score) || 0;
    app.results[move.player] = { score: sc };
    if (app.phase === 'results' || isOver()) onResultsUpdate();
  }
}

function handlePresence(set) {
  app.online = set;
  const known = (app.room?.players ?? []).length;
  let maxSeat = -1;
  set.forEach((k) => { const n = Number(k); if (Number.isFinite(n)) maxSeat = Math.max(maxSeat, n); });
  if (maxSeat + 1 > known) {
    fetchRoom(app.code).then((r) => { app.room = r; renderRoomPlayers(); renderPrestart(); }).catch(() => {});
  }
  renderRoomPlayers();
}

function handleRoomUpdate(room) {
  if (!room) return;
  app.room = room;
  renderRoomPlayers();
  renderPrestart();
}

// ---- Phase machine + synced timer ------------------------------------

function setPhase(p) {
  app.phase = p;
  $('room-overlay').classList.toggle('hidden', p !== 'waiting');
  $('countdown-overlay').classList.toggle('hidden', p !== 'countdown');
  $('results-overlay').classList.toggle('hidden', p !== 'results');
  if (p === 'waiting') renderPrestart();
}

function isOver() {
  return app.startAt != null && Date.now() >= app.startAt + COUNTDOWN_MS + GAME_MS;
}

function startTimers() {
  if (app.timerInt) return;
  if (app.startAt != null && isOver()) { tick(); return; }
  app.timerInt = setInterval(tick, 200);
  tick();
}

function tick() {
  if (app.startAt == null) return;
  const now = Date.now();
  const reveal = app.startAt + COUNTDOWN_MS;
  const end = reveal + GAME_MS;
  if (now < reveal) {
    if (app.phase !== 'countdown') setPhase('countdown');
    $('countdown-num').textContent = String(Math.max(1, Math.ceil((reveal - now) / 1000)));
  } else if (now < end) {
    if (app.phase !== 'playing') startPlay(end);
  } else {
    endPlay();
  }
}

function startPlay(end) {
  setPhase('playing');
  window.CG.beginRoomClock(end);
}

function endPlay() {
  if (app.timerInt) { clearInterval(app.timerInt); app.timerInt = null; }
  if (app.phase !== 'results' && app.phase !== 'playing') {
    onRoomEnd(window.CG.getScore());
  }
}

function onRoomEnd(finalScore) {
  if (app.timerInt) { clearInterval(app.timerInt); app.timerInt = null; }
  submitMyResult(finalScore);
  if (app.code) updateRoomStatus(app.code, 'finished').catch(() => {});
  $('results-list').innerHTML = '';
  $('results-winner').textContent = '';
  $('results-waiting').classList.remove('hidden');
  setPhase('results');
  onResultsUpdate();
}

function submitMyResult(finalScore) {
  if (app.submittedResult || app.seat == null) return;
  app.submittedResult = true;
  const sc = Math.max(0, Math.round(finalScore));
  app.results[app.seat] = { score: sc };
  app.conn?.sendMove({ move_index: 2 + app.seat, player: app.seat, type: 'result', payload: { score: sc } }).catch(() => {});
}

// ---- Players + prestart + results ------------------------------------

function renderRoomPlayers() {
  const strip = $('room-players');
  if (!strip) return;
  const players = app.room?.players ?? [];
  strip.innerHTML = '';
  players.forEach((p) => {
    const div = document.createElement('div');
    div.className = 'room-player' + (p.seat === app.seat ? ' me' : '');
    const online = app.online.has(String(p.seat));
    const r = app.results[p.seat];
    const showScore = app.phase === 'results' && r;
    div.innerHTML = `<span class="pdot ${online ? '' : 'off'}"></span>`
      + `<span class="pname">${esc(p.name || `P${p.seat + 1}`)}${seatLeft(app.room, p.seat) ? ' <span class="left-tag">left</span>' : ''}</span>`
      + `<span class="pscore">${showScore ? r.score : '·'}</span>`;
    strip.appendChild(div);
  });
}

function renderPrestart() {
  if (app.phase !== 'waiting') return;
  renderRoomPlayers();
  const players = app.room?.players ?? [];
  const n = players.length;
  $('room-title').textContent = n >= 2 ? 'READY?' : 'WAITING FOR PLAYERS';
  $('room-info').innerHTML = `${n} player${n === 1 ? '' : 's'} in · share code <strong>${esc(app.code)}</strong>`;
  const host = app.seat === 0;
  const startBtn = $('btn-start-room');
  startBtn.textContent = 'START GAME';
  startBtn.classList.toggle('hidden', !host);
  startBtn.disabled = app.startAt != null;
  $('room-waiting').classList.toggle('hidden', host);
}

function onResultsUpdate() {
  if (app.phase !== 'results') return;
  const seats = (app.room?.players ?? []).length || 1;
  const submitted = Object.keys(app.results).length;
  renderRoomPlayers();
  const allReady = submitted >= seats;
  $('results-waiting').classList.toggle('hidden', allReady);
  if (allReady) renderFinalResults();
}

function renderFinalResults() {
  const seats = (app.room?.players ?? []).length || 1;
  const ranked = [];
  for (let s = 0; s < seats; s++) {
    ranked.push({
      seat: s,
      score: app.results[s]?.score ?? (s === app.seat ? Math.max(0, Math.round(window.CG.getScore())) : 0),
      name: seatName(app.room, s) || `P${s + 1}`,
    });
  }
  ranked.sort((a, b) => b.score - a.score);

  const ol = $('results-list');
  ol.innerHTML = '';
  ranked.forEach((r, i) => {
    const li = document.createElement('li');
    if (r.seat === app.seat) li.className = 'me';
    const leftTag = seatLeft(app.room, r.seat) ? ' <span class="left-tag">left</span>' : '';
    li.innerHTML = `<span class="r-rank">${i + 1}</span>`
      + `<span class="r-name">${esc(r.name)}${leftTag}</span>`
      + `<span class="r-score">${r.score}</span>`;
    ol.appendChild(li);
  });

  const winnerEl = $('results-winner');
  if (ranked.length <= 1) {
    winnerEl.textContent = ''; winnerEl.className = 'results-winner';
  } else {
    const top = ranked[0].score;
    const tied = ranked.filter((r) => r.score === top);
    const iWon = tied.some((r) => r.seat === app.seat);
    const isTie = tied.length > 1;
    if (isTie && iWon) { winnerEl.textContent = "It's a tie!"; winnerEl.className = 'results-winner'; }
    else if (iWon) { winnerEl.textContent = 'You won!'; winnerEl.className = 'results-winner'; }
    else if (isTie) { winnerEl.textContent = `${tied.map((r) => r.name).join(' & ')} tied`; winnerEl.className = 'results-winner loss'; }
    else { winnerEl.textContent = `${ranked[0].name} won`; winnerEl.className = 'results-winner loss'; }
  }
  $('results-waiting').classList.add('hidden');
  renderRoomPlayers();
}

// ---- Controls ---------------------------------------------------------

$('btn-start-room').addEventListener('click', async () => {
  if (app.startAt != null) return;
  $('btn-start-room').disabled = true;
  const startAt = Date.now();
  try {
    await app.conn.sendMove({ move_index: 0, player: 0, type: 'start', payload: { startAt } });
    updateRoomStatus(app.code, 'playing').catch(() => {});
    app.startAt = startAt;
    startTimers();
  } catch (e) {
    if (e?.code === '23505' || /duplicate key/i.test(e?.message || '')) {
      app.conn?.pollOnce().catch(() => {});
    } else {
      $('btn-start-room').disabled = false;
      $('room-status').textContent = e.message || 'Could not start.';
    }
  }
});

$('btn-room-share').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(roomShareUrl(app.code));
    $('room-status').textContent = 'Invite link copied.';
  } catch {}
});

async function leaveRoom() {
  if (app.code != null && app.seat != null && app.room && app.room.status !== 'finished') {
    try { const room = await markPlayerLeft(app.code, app.seat); if (room) app.conn?.broadcastRoom(room); } catch {}
  }
  clearSession(GAME_SLUG);
  if (app.conn) { app.conn.close(); app.conn = null; }
  resetRoomState();
  const wasCode = app.code;
  app.code = null; app.seat = null; app.room = null;
  $('room-overlay').classList.add('hidden');
  $('countdown-overlay').classList.add('hidden');
  $('results-overlay').classList.add('hidden');
  $('btn-leave-game').classList.add('hidden');
  $('btn-reset').classList.remove('hidden');
  window.CG.leaveRoom();
  return wasCode;
}

async function leaveToLobby() {
  await leaveRoom();
  if (app.user) showLobby();
}

$('btn-room-leave').addEventListener('click', leaveToLobby);
$('btn-leave-game').addEventListener('click', leaveToLobby);
$('btn-results-done').addEventListener('click', async () => {
  const code = app.code;
  await leaveRoom();
  if (code && app.userId) dismissGame(app.userId, code);
  if (app.user) showLobby();
});

const rematch = createRematch({
  state: app,
  createRoom: (name, userId) => createRoom(name, userId, null, MAX_PLAYERS),
  joinRoom, enterRoom,
  onError: (msg) => { $('room-status').textContent = msg; },
});
$('btn-rematch').addEventListener('click', rematch.start);

// ---- Lobby buttons (injected by lobby-ui.js) -------------------------

$('btn-go-lobby')?.addEventListener('click', () => { if (app.user) showLobby(); });
$('btn-lobby-daily')?.addEventListener('click', () => { hideLobby(); window.CG.startDaily(); });
$('btn-lobby-new')?.addEventListener('click', async () => {
  try {
    if (!app.name) { lobbyError('Set your name first.'); return; }
    const room = await createRoom(app.name, app.userId, null, MAX_PLAYERS);
    await enterRoom(room.code, 0, app.name, room);
  } catch (e) { lobbyError(e.message); }
});
$('btn-lobby-join')?.addEventListener('click', () => { $('lobby-join-box').classList.toggle('hidden'); $('lobby-code-input').focus(); });
function doLobbyJoin() {
  if (!app.name) { lobbyError('Set your name first.'); return; }
  const code = $('lobby-code-input').value.trim().toUpperCase();
  if (code.length < 4) { lobbyError('Enter the room code.'); return; }
  lobbyError('');
  joinRoom(code, app.name, app.userId)
    .then(({ room, playerIndex }) => enterRoom(code, playerIndex, app.name, room))
    .catch((e) => lobbyError(e.message || 'Could not join that room.'));
}
$('btn-lobby-join-go')?.addEventListener('click', doLobbyJoin);
$('lobby-code-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLobbyJoin(); });
$('btn-lobby-refresh')?.addEventListener('click', renderLobby);
$('btn-lobby-challenge')?.addEventListener('click', () => window.LBAccount?.openProfile());
$('btn-lobby-history')?.addEventListener('click', () => openHistory({ userId: app.userId, gameSlug: GAME_SLUG }));

// ---- Resume / boot ----------------------------------------------------

async function tryResume() {
  const urlCode = takeRoomParam();
  if (urlCode) {
    try {
      const { room, playerIndex } = await joinRoom(urlCode, app.name, app.userId);
      await enterRoom(urlCode, playerIndex, seatName(room, playerIndex) || 'Guest', room);
      return true;
    } catch { /* fall through to stored session */ }
  }
  const session = readSession(GAME_SLUG);
  if (!session) return false;
  try {
    const { code, name } = typeof session === 'string' ? JSON.parse(session) : session;
    const { room, playerIndex } = await joinRoom(code, name, app.userId);
    await enterRoom(code, playerIndex, name, room);
    return true;
  } catch { clearSession(GAME_SLUG); return false; }
}

async function boot() {
  window.LB_CONFIG.onChallengeFriend = challengeFriend;
  if (!configReady()) { window.LBBoot?.done(); return; }
  app.user = cachedUser();
  app.userId = app.user?.id ?? null;
  app.name = playerName();
  $('btn-go-lobby')?.classList.toggle('hidden', !app.user);
  onAuthChange(onAuth);
  const resumed = await tryResume();
  if (!resumed && hasDailyParam()) { hideLobby(); window.CG.startDaily(); }
  else if (!resumed && app.user) showLobby();
  window.LBBoot?.done();
}

window.__cgRoom = { app, setPhase, enterRoom };

// ── Daily Leaderboard RPC ──────────────────────────────────────────────
function escLb(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function getPlayerName() {
  const n = currentUser ? displayName(currentUser) : getGuestName();
  return (n || '').trim() || 'Player';
}

let currentUser = cachedUser();
onAuthChange((u) => { currentUser = u; });

async function fetchAndRenderLB(slug, lbEl) {
  const myKey = playerKey(currentUser);
  const rows = await fetchTopScores(slug, 10).catch(() => []);
  lbEl.innerHTML = '';
  (rows || []).forEach((row, i) => {
    const isMe = row.player_key === myKey;
    const div = document.createElement('div');
    div.className = 'daily-lb-row' + (isMe ? ' me' : '');
    div.innerHTML = `<span class="daily-lb-rank">${i + 1}</span>`
      + `<span class="daily-lb-name">${escLb(row.name || 'Player')}</span>`
      + `<span class="daily-lb-score">${row.score}</span>`;
    lbEl.appendChild(div);
  });
  if (!rows || !rows.length) lbEl.innerHTML = '<div class="daily-lb-empty">No scores yet today.</div>';
}

window.__dailySubmitAndFetch = async (score, slug, lbEl) => {
  const key = playerKey(currentUser);
  try {
    await postScore(slug, key, getPlayerName(), score);
  } catch {}
  await fetchAndRenderLB(slug, lbEl);
};

window.__dailyFetchLB = (slug, lbEl) => fetchAndRenderLB(slug, lbEl);

boot();
