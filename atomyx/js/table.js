// The periodic-table grid component. Renders the WHOLE table every time —
// set cells bright (and tappable), everything else dimmed context — so the
// spatial learning keeps its anchor no matter how small the playable set is.
//
// Pure CSS grid: 18 columns, rows 1-7 the main table, row 8 a slim spacer,
// rows 9/10 the lanthanide/actinide shelf (positions come baked into the
// data as x/y — see tools/build-data.mjs). Cell type sizes use container
// query units so the table scales from a 360px phone to the 680px cap.
//
// API:
//   const t = renderTable(host, elements, setIds, { blankActive, onTap })
//   t.mark(id, ...classes)   — add state classes to a cell
//   t.unmark(id, ...classes) — remove them
//   t.reveal(id)             — un-blank a cell (BUILD/SWEEP fills)
//   t.clearSel()             — drop the pending .sel highlight

export function renderTable(host, elements, setIds, { blankActive = false, onTap = null } = {}) {
  const inSet = new Set(setIds);
  host.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'pt-wrap';
  const grid = document.createElement('div');
  grid.className = 'pt-grid';
  wrap.appendChild(grid);
  host.appendChild(wrap);

  const cells = new Map();
  for (const [id, el] of Object.entries(elements)) {
    const c = document.createElement('button');
    const active = inSet.has(id);
    c.className = 'el-cell' + (active ? '' : ' ctx') + (active && blankActive ? ' blank' : '');
    c.style.gridColumn = el.x;
    c.style.gridRow = el.y;
    c.dataset.id = id;
    c.innerHTML = `<span class="el-num">${el.num}</span><span class="el-sym">${el.sym}</span>`;
    if (active && onTap) c.addEventListener('click', () => onTap(id));
    grid.appendChild(c);
    cells.set(id, c);
  }

  // Faint markers in the main-table group-3 gaps pointing at the shelf.
  for (const [row, label] of [[6, '57–71'], [7, '89–103']]) {
    const m = document.createElement('div');
    m.className = 'el-marker';
    m.style.gridColumn = 3;
    m.style.gridRow = row;
    m.textContent = label;
    grid.appendChild(m);
  }

  return {
    el: wrap,
    cells,
    mark(id, ...cls) { cells.get(id)?.classList.add(...cls); },
    unmark(id, ...cls) { cells.get(id)?.classList.remove(...cls); },
    reveal(id) { cells.get(id)?.classList.remove('blank'); },
    clearSel() { for (const c of cells.values()) c.classList.remove('sel'); },
  };
}
