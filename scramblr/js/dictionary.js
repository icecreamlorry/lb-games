// Word validity for Scramblr. The ENABLE word list (~173k words) is fetched once
// the game is starting and cached. Scramblr's minimum word length is 3, so the
// two-letter special-case list Wurdz uses isn't needed here.

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
