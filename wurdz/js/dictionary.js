// Word validity lookup for challenges.
//
// Two-letter words come from the curated list in words2.js (which includes
// modern additions like QI/ZA that the bundled long-word list predates).
// Words of three letters or more are checked against data/dictionary.txt
// (the public-domain ENABLE word list, ~173k words), fetched lazily the
// first time a challenge needs it and cached thereafter.

import { TWO_LETTER_WORDS } from './words2.js';

const twoLetter = new Set(TWO_LETTER_WORDS.map((e) => e.w.toUpperCase()));

let wordSet = null;
let loadPromise = null;

export function dictionaryLoaded() {
  return wordSet !== null;
}

// Loads (and caches) the long-word list. Safe to call repeatedly.
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
      loadPromise = null; // allow a retry on the next challenge
      throw err;
    });
  return loadPromise;
}

// Synchronous lookup. Returns true/false, or null when a 3+ letter word is
// queried before the long-word list has loaded (call loadDictionary first).
export function lookup(word) {
  const w = word.toUpperCase();
  if (w.length < 2) return false;
  if (w.length === 2) return twoLetter.has(w);
  if (!wordSet) return null;
  return wordSet.has(w);
}

// Checks every word in a play. Returns { ok, invalid: [...] }. Assumes the
// dictionary is already loaded (invalid words are those not found).
export function checkWords(words) {
  const invalid = [];
  for (const word of words) {
    if (lookup(word) === false) invalid.push(word.toUpperCase());
  }
  return { ok: invalid.length === 0, invalid };
}
