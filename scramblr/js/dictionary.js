// Word validity for Scramblr. The ENABLE word list (~173k words) is fetched once
// the game is starting and cached. Scramblr's minimum word length is 3, so the
// two-letter special-case list Wurdz uses isn't needed here.

let wordSet = null;
let sortedWords = null; // same words, kept sorted for prefix binary-search
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
      const list = [];
      for (const line of text.split('\n')) {
        const w = line.trim().toUpperCase();
        if (w) { wordSet.add(w); list.push(w); }
      }
      // hasPrefix() binary-searches this, so it must be sorted. The ENABLE file
      // ships sorted, but sort defensively — it's a one-time O(n log n) cost.
      list.sort();
      sortedWords = list;
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

// Is `p` a prefix of at least one dictionary word? Binary-searches the sorted
// list for the first word >= p: because the list is sorted, if any word starts
// with p that first one does. This is the pruning oracle for solveBoard().
// Returns false until the list has loaded.
export function hasPrefix(p) {
  if (!sortedWords) return false;
  const pre = String(p).toUpperCase();
  let lo = 0, hi = sortedWords.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedWords[mid] < pre) lo = mid + 1; else hi = mid;
  }
  return lo < sortedWords.length && sortedWords[lo].startsWith(pre);
}
