// Word validity for Splitz. The ENABLE word list (~173k words) is fetched once
// the game starts and cached. Splitz validates every across/down run on a
// player's grid, so the same membership test Scramblr uses applies here.

let wordSet = null;
let loadPromise = null;

export function dictionaryLoaded() {
  return wordSet !== null;
}

// Loads (and caches) the word list. Safe to call repeatedly.
export function loadDictionary() {
  if (wordSet) return Promise.resolve(wordSet);
  if (loadPromise) return loadPromise;
  loadPromise = fetch(new URL('../data/dictionary.txt', import.meta.url))
    .then((r) => {
      if (!r.ok) throw new Error(`word list returned ${r.status}`);
      return r.text();
    })
    .then((text) => {
      wordSet = new Set();
      for (const line of text.split('\n')) {
        const w = line.trim().toUpperCase();
        if (w) wordSet.add(w);
      }
      return wordSet;
    })
    .catch((err) => {
      loadPromise = null; // allow a retry
      throw err;
    });
  return loadPromise;
}

// Synchronous membership test. Returns false until the list has loaded.
export function isWord(w) {
  if (!wordSet) return false;
  return wordSet.has(String(w).toUpperCase());
}
