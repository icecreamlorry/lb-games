// Shared theme system for LB Games.
// Each game calls loadTheme(defaultId) once at boot to restore the user's
// stored preference (or fall back to the game's natural default).
// applyTheme(id) is called by the picker on every selection.

const LS_KEY = 'lb.theme';

export const THEMES = [
  { id: 'maritime', label: 'Ocean' },
  { id: 'synth',    label: 'Synth'    },
  { id: 'pastel',   label: 'Pastel'   },
];

export function applyTheme(id) {
  document.documentElement.dataset.theme = id;
  try { localStorage.setItem(LS_KEY, id); } catch {}
  // Sync the active state on every picker that may be open in the DOM.
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.themeId === id);
  });
}

// Call at boot with the game's natural default. Stored preference wins.
export function loadTheme(defaultId = 'synth') {
  let stored;
  try { stored = localStorage.getItem(LS_KEY); } catch {}
  applyTheme(stored && THEMES.some(t => t.id === stored) ? stored : defaultId);
}

// Returns a .theme-picker-section element — caller decides where to insert it.
export function createThemePicker() {
  const section = document.createElement('div');
  section.className = 'theme-picker-section';

  const label = document.createElement('div');
  label.className = 'theme-picker-label';
  label.textContent = 'Theme';
  section.appendChild(label);

  const row = document.createElement('div');
  row.className = 'theme-picker';
  const current = document.documentElement.dataset.theme;
  for (const { id, label: name } of THEMES) {
    const btn = document.createElement('button');
    btn.className = 'theme-btn';
    if (current === id) btn.classList.add('active');
    btn.dataset.themeId = id;
    btn.textContent = name;
    btn.addEventListener('click', () => applyTheme(id));
    row.appendChild(btn);
  }
  section.appendChild(row);
  return section;
}
