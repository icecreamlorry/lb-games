// Lexicorp engine — pure, deterministic rules for a turn-based word/patent/stock
// game in the spirit of the classic "build words, patent letters, collect
// royalties, cash out stock" tabletop economy game.
//
// Everything here is deterministic: every client builds the SAME shuffled deck
// from the room seed and replays the SAME ordered move log, so all clients
// arrive at an identical game state with no server authority. (Hands are
// derivable from the seed, like the boards in Scramblr/ChromaGrid; the UI only
// ever shows you your own.)
//
// ── A note on the numbers ───────────────────────────────────────────────────
// The published rulebook's exact economy tables could not be fetched while this
// was written, so the scoring/patent/threshold values below are a faithful
// reconstruction anchored on the facts that ARE well documented: 7-card hand, a
// shared pool of 3, words of 3+ letters using at least one card from your hand,
// money + stock by length, one patent bought per turn (a letter from your word)
// that pays its owner $1 per use by others, seven patents with special powers
// (B J K Q V X Z), and an end trigger on total patent value. Tweak the tables in
// one place (below) without touching the logic.

// ---- Tunable tables --------------------------------------------------------

export const HAND_SIZE = 7;
export const POOL_SIZE = 3;        // shared community cards
export const MIN_WORD = 3;
export const STOCK_VALUE = 1;      // each stock certificate is worth $1 at cash-out

// Money / stock earned by word length. Money tops out at $6 (7+ letters);
// stock starts at 6-letter words and adds one per extra letter.
export function moneyForLength(n) {
  if (n < MIN_WORD) return 0;
  return n >= 7 ? 6 : n - 2;      // 3→1 4→2 5→3 6→4 7+→6
}
export function stockForLength(n) {
  return Math.max(0, n - 5);       // 3-5→0 6→1 7→2 8→3 …
}

// Letter deck composition (~English frequency; 101 cards).
const DECK_COUNTS = {
  A: 9, B: 2, C: 3, D: 4, E: 12, F: 2, G: 3, H: 3, I: 9, J: 1, K: 1, L: 4,
  M: 2, N: 6, O: 8, P: 2, Q: 1, R: 6, S: 5, T: 7, U: 4, V: 1, W: 2, X: 1,
  Y: 2, Z: 1,
};

// Official Letter Tycoon patent costs (= end-game value), read straight off the
// patent cards. A patent pays its owner $1 royalty per matching factory card an
// opponent plays. The seven powered letters (B J K Q V X Z) are all the cheapest
// at $2 — their ability is the draw, not the value. Ordered by value for display.
export const PATENTS = {
  E: { cost: 10 }, A: { cost: 8 }, T: { cost: 8 },
  I: { cost: 7 }, O: { cost: 7 }, N: { cost: 7 },
  R: { cost: 6 }, S: { cost: 6 },
  H: { cost: 5 },
  D: { cost: 4 }, L: { cost: 4 },
  C: { cost: 3 }, F: { cost: 3 }, G: { cost: 3 }, M: { cost: 3 },
  P: { cost: 3 }, U: { cost: 3 }, W: { cost: 3 }, Y: { cost: 3 },
  B: { cost: 2, power: 'B' }, J: { cost: 2, power: 'J' }, K: { cost: 2, power: 'K' },
  Q: { cost: 2, power: 'Q' }, V: { cost: 2, power: 'V' }, X: { cost: 2, power: 'X' },
  Z: { cost: 2, power: 'Z' },
};

// Short human text for each special power (shown in the UI / how-to).
export const POWER_TEXT = {
  B: 'Earn double when your word starts and ends with a vowel.',
  J: 'Earn double when at least half your word is vowels.',
  K: 'Earn double when your word has exactly one vowel.',
  Q: 'Start of turn: replace a card — discard one and draw a new one.',
  V: 'Spell two words on your turn (scored separately).',
  X: 'Use one of your letter cards twice.',
  Z: 'Add an S to the end of your word for free.',
};

// Published Letter Tycoon goal-card values: the patent value that, once any
// player reaches it (while owning at least END_MIN_PATENTS patents), triggers the
// final round. Keyed by player count (2–5).
export const END_THRESHOLD = { 2: 45, 3: 34, 4: 26, 5: 21 };
// The goal cards also require a minimum number of patents owned before the game
// can end — a guard against ending on a handful of high-value patents.
export const END_MIN_PATENTS = { 2: 6, 3: 5, 4: 3, 5: 3 };
export function endThreshold(numPlayers) {
  return END_THRESHOLD[numPlayers] ?? END_THRESHOLD[2];
}
export function endMinPatents(numPlayers) {
  return END_MIN_PATENTS[numPlayers] ?? END_MIN_PATENTS[2];
}

const VOWELS = new Set(['A', 'E', 'I', 'O', 'U']);

// ---- Deterministic deck ----------------------------------------------------

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// The full shuffled deck of letters (a card's identity is its index here).
export function makeDeck(seed) {
  const cards = [];
  for (const [letter, n] of Object.entries(DECK_COUNTS)) {
    for (let i = 0; i < n; i++) cards.push(letter);
  }
  return shuffle(cards, mulberry32(seed >>> 0));
}

// ---- Game state ------------------------------------------------------------
//
// A card is referenced by its integer id (index into `deck`). Hands and the
// pool are arrays of ids; `deck[id]` is the letter.

export function initialState(seed, numPlayers) {
  const deck = makeDeck(seed);
  const hands = [];
  for (let s = 0; s < numPlayers; s++) hands.push(range(s * HAND_SIZE, HAND_SIZE));
  const pool = range(numPlayers * HAND_SIZE, POOL_SIZE);
  return {
    deck,
    numPlayers,
    hands,
    pool,
    top: numPlayers * HAND_SIZE + POOL_SIZE, // next card to draw
    money: new Array(numPlayers).fill(0),
    stock: new Array(numPlayers).fill(0),
    patents: {},          // letter -> owner seat
    turn: 0,              // number of completed turns; next is move_index turn+1
    lastRound: false,     // end trigger seen — finish the round then stop
    ended: false,
    log: [],              // applied { seat, words:[{word,money,stock}], bought, royalties } per turn
  };
}

function range(start, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(start + i);
  return out;
}

export function letterOf(state, id) { return state.deck[id]; }
export function whoseTurn(state) { return state.turn % state.numPlayers; }
export function patentValueOf(state, seat) {
  let v = 0;
  for (const [letter, owner] of Object.entries(state.patents)) {
    if (owner === seat) v += PATENTS[letter].cost;
  }
  return v;
}
export function patentCountOf(state, seat) {
  let n = 0;
  for (const owner of Object.values(state.patents)) if (owner === seat) n += 1;
  return n;
}

// ---- Word evaluation -------------------------------------------------------
//
// A play's payload describes the cards spelling the word, in order. The same id
// may appear twice only with the X power (use one card twice). Flags:
//   appendS  — Z power, tacks an S on the end (no card)
//   second   — V power, a second word played the same turn ({ cards: [...] })
//   buy      — letter to patent this turn (must be in your word(s))
//   qDiscard — Q power, a card discarded at the START of the turn (drew a fresh
//              one before building); applied before the word is read.

// Build the ordered letters of a word from its cards, honoring each card's
// vowel/consonant nature. A `Y` card counts as a consonant unless its id is in
// `yVowelSet` (the player's per-Y designation, like Letter Tycoon's rule that
// every Y must be declared a vowel or a consonant). Z's free trailing S, if any,
// is appended as a non-card consonant. Returns [{ ch, isVowel }, …].
function wordLetters(state, cards, appendS, yVowelSet) {
  const out = cards.map((id) => {
    const ch = state.deck[id];
    const isVowel = VOWELS.has(ch) || (ch === 'Y' && yVowelSet.has(id));
    return { ch, isVowel };
  });
  if (appendS) out.push({ ch: 'S', isVowel: false });
  return out;
}

function wordString(letters) { return letters.map((l) => l.ch).join('').toUpperCase(); }

// Money/stock for a single word. Its `letters` carry vowel/consonant flags (so a
// Y declared a vowel counts as one), and the owner's passive doublers plus the
// universal Q-in-word double are applied. `owned` is the seat's set of powers.
function scoreWord(letters, owned) {
  const word = wordString(letters);
  const len = letters.length;
  let money = moneyForLength(len);
  let stock = stockForLength(len);
  const v = letters.filter((l) => l.isVowel).length;

  // Patent-ability doubler (B/J/K). They don't stack with each other.
  const bigB = owned.has('B') && len >= 2 && letters[0].isVowel && letters[len - 1].isVowel;
  const bigJ = owned.has('J') && v * 2 >= len;
  const bigK = owned.has('K') && v === 1;
  if (bigB || bigJ || bigK) money *= 2;

  // A Q anywhere in the word doubles both money and stock (for everyone).
  if (letters.some((l) => l.ch === 'Q')) { money *= 2; stock *= 2; }

  return { word, money, stock };
}

// Validate (and price) a play without mutating. Returns { ok, error?, words,
// money, stock, usedIds } where `words` is [{ word, money, stock }].
//   isWord(w) — dictionary predicate (must be ready before calling)
export function validatePlay(state, seat, payload, isWord) {
  if (state.ended) return fail('The game is over.');
  if (whoseTurn(state) !== seat) return fail('Not your turn.');

  const hand = withQDiscard(state, seat, payload.qDiscard);
  if (hand == null) return fail('That card is not in your hand.');
  const handSet = new Set(hand);
  const poolSet = new Set(state.pool);
  const owned = ownedPowers(state, seat);

  const wordSpecs = [{ cards: payload.cards || [], appendS: !!payload.appendS }];
  if (payload.second && (payload.second.cards || []).length) {
    if (!owned.has('V')) return fail('You need the V patent to play two words.');
    wordSpecs.push({ cards: payload.second.cards, appendS: !!payload.second.appendS });
  }

  const usedAll = [];          // every card id consumed (distinct), for refill
  const usedCounts = new Map();
  const words = [];
  let usedFromHand = false;
  const yVowelSet = new Set(payload.yVowels || []);

  for (const spec of wordSpecs) {
    const cards = spec.cards;
    if (cards.length < MIN_WORD - (spec.appendS ? 1 : 0)) return fail('Words must be 3+ letters.');
    if (spec.appendS && !owned.has('Z')) return fail('You need the Z patent to add an S.');

    // Tally card usage; a doubled id (X) may appear at most twice.
    const localCounts = new Map();
    for (const id of cards) {
      if (!handSet.has(id) && !poolSet.has(id)) return fail('You can only use cards from your hand or the pool.');
      if (handSet.has(id)) usedFromHand = true;
      localCounts.set(id, (localCounts.get(id) || 0) + 1);
    }
    for (const [id, c] of localCounts) {
      if (c > 2) return fail('A card can be used at most twice.');
      if (c === 2 && !owned.has('X')) return fail('You need the X patent to use a card twice.');
    }

    const letters = wordLetters(state, cards, spec.appendS, yVowelSet);
    const word = wordString(letters);
    if (word.length < MIN_WORD) return fail('Words must be 3+ letters.');
    if (isWord && !isWord(word)) return fail(`${word} is not a word.`);

    words.push(scoreWord(letters, owned));
  }

  if (!usedFromHand) return fail('Use at least one card from your hand.');

  // Merge card usage across both words for refill bookkeeping.
  for (const spec of wordSpecs) {
    const seen = new Set();
    for (const id of spec.cards) {
      if (seen.has(id)) continue; // distinct ids only — refill replaces a card once
      seen.add(id);
      if (!usedCounts.has(id)) { usedCounts.set(id, true); usedAll.push(id); }
    }
  }

  const money = words.reduce((a, w) => a + w.money, 0);
  const stock = words.reduce((a, w) => a + w.stock, 0);
  // Letters you actually played from a factory card — what you may patent and
  // what pays royalties (a Z-appended S or an X-doubled reuse is NOT a card).
  const usedLetters = lettersFromCards(state, usedAll);

  // Patent purchase eligibility (priced, not yet paid).
  let buy = null;
  if (payload.buy) {
    const letter = String(payload.buy).toUpperCase();
    if (!PATENTS[letter]) return fail('Unknown patent.');
    if (state.patents[letter] != null) return fail('That patent is already owned.');
    if (!usedLetters.has(letter)) return fail('You can only patent a letter you played from a card.');
    // You may spend the money you just earned this turn (applied before the buy).
    const projected = state.money[seat] + words.reduce((a, w) => a + w.money, 0);
    if (projected < PATENTS[letter].cost) return fail('Not enough money for that patent.');
    buy = { letter, cost: PATENTS[letter].cost };
  }

  return { ok: true, words, money, stock, usedIds: usedAll, buy, letters: usedLetters };
}

function lettersFromCards(state, ids) {
  const set = new Set();
  for (const id of ids) set.add(state.deck[id]);
  return set;
}

// The seat's hand after an optional Q-discard (returns null if the discard card
// isn't actually in hand). The drawn replacement is the deterministic top card.
function withQDiscard(state, seat, discardId) {
  const hand = state.hands[seat].slice();
  if (discardId == null) return hand;
  if (!ownedPowers(state, seat).has('Q')) return null;
  const i = hand.indexOf(discardId);
  if (i === -1) return null;
  hand.splice(i, 1);
  if (state.top < state.deck.length) hand.push(state.top); // the fresh card
  return hand;
}

function ownedPowers(state, seat) {
  const set = new Set();
  for (const [letter, owner] of Object.entries(state.patents)) {
    if (owner === seat && PATENTS[letter].power) set.add(PATENTS[letter].power);
  }
  return set;
}

function fail(error) { return { ok: false, error }; }

// ---- Applying a move (mutating, deterministic) -----------------------------
//
// Recomputes all numeric effects from the payload so every client converges,
// then deals replacement cards from the deterministic deck. `isWord` is optional
// on replay (words were validated by the sender); when omitted, dictionary
// checks are skipped but every economic effect is still recomputed identically.

export function applyMove(state, move, isWord) {
  if (move.type === 'swap') return applySwap(state, move);
  if (move.type === 'discard') return applyDiscard(state, move);
  if (move.type !== 'play') return state;

  const seat = move.player;
  const payload = move.payload || {};

  // Resolve a Q-discard first (mutates hand + draw pointer deterministically).
  if (payload.qDiscard != null && ownedPowers(state, seat).has('Q')) {
    const hand = state.hands[seat];
    const i = hand.indexOf(payload.qDiscard);
    if (i !== -1) {
      hand.splice(i, 1);
      if (state.top < state.deck.length) hand.push(state.top++);
    }
  }

  const res = validatePlay(state, seat, { ...payload, qDiscard: undefined }, isWord);
  // On replay we trust the sender's validation but still need the breakdown; if
  // it fails (shouldn't happen for legit moves), recompute leniently.
  const words = res.ok ? res.words : reReadWords(state, seat, payload);
  const usedIds = res.ok ? res.usedIds : distinctUsed(payload);

  // 1. Earnings to the active player.
  let money = words.reduce((a, w) => a + w.money, 0);
  const stock = words.reduce((a, w) => a + w.stock, 0);

  // 2. Royalties: $1 from the bank to each OTHER owner per FACTORY CARD of theirs
  // played. Iterating the used cards (not the word string) means an X-doubled
  // reuse counts once and a Z-appended S — neither being a card — pays nothing.
  const royalties = new Array(state.numPlayers).fill(0);
  for (const id of usedIds) {
    const owner = state.patents[state.deck[id]];
    if (owner != null && owner !== seat) royalties[owner] += 1;
  }

  state.money[seat] += money;
  state.stock[seat] += stock;
  for (let s = 0; s < state.numPlayers; s++) state.money[s] += royalties[s];

  // 3. Patent purchase (re-checked against current funds).
  let bought = null;
  if (payload.buy) {
    const letter = String(payload.buy).toUpperCase();
    const playedLetters = lettersFromCards(state, usedIds);
    if (PATENTS[letter] && state.patents[letter] == null && playedLetters.has(letter) && state.money[seat] >= PATENTS[letter].cost) {
      state.money[seat] -= PATENTS[letter].cost;
      state.patents[letter] = seat;
      bought = letter;
    }
  }

  // 4. Remove used cards and refill (pool first, then the active hand).
  removeCards(state, seat, usedIds);
  refillPool(state);
  refillHand(state, seat);

  state.log.push({ seat, words, bought, royalties, money, stock });
  advanceTurn(state, seat);
  return state;
}

function applySwap(state, move) {
  const seat = move.player;
  // Discard the whole hand and draw a fresh one (a relief valve so a player can
  // never be soft-locked with an unplayable hand). No earnings, ends the turn.
  state.hands[seat] = [];
  refillHand(state, seat);
  state.log.push({ seat, words: [], bought: null, royalties: new Array(state.numPlayers).fill(0), money: 0, stock: 0, swap: true });
  advanceTurn(state, seat);
  return state;
}

// The Letter Tycoon "discard" turn action: discard any chosen cards from your
// hand, draw the same number back, and end your turn (no word, no earnings).
function applyDiscard(state, move) {
  const seat = move.player;
  const ids = (move.payload && move.payload.cards) || [];
  const drop = new Set(ids);
  const before = state.hands[seat].length;
  state.hands[seat] = state.hands[seat].filter((id) => !drop.has(id));
  refillHand(state, seat); // refills to HAND_SIZE → draws exactly as many as left
  const discarded = before - state.hands[seat].length;
  state.log.push({ seat, words: [], bought: null, royalties: new Array(state.numPlayers).fill(0), money: 0, stock: 0, discard: discarded });
  advanceTurn(state, seat);
  return state;
}

function removeCards(state, seat, ids) {
  const handSet = new Set(state.hands[seat]);
  const rmHand = ids.filter((id) => handSet.has(id));
  const rmPool = ids.filter((id) => !handSet.has(id));
  if (rmHand.length) { const r = new Set(rmHand); state.hands[seat] = state.hands[seat].filter((id) => !r.has(id)); }
  if (rmPool.length) { const r = new Set(rmPool); state.pool = state.pool.filter((id) => !r.has(id)); }
}

function refillPool(state) {
  while (state.pool.length < POOL_SIZE && state.top < state.deck.length) state.pool.push(state.top++);
}
function refillHand(state, seat) {
  while (state.hands[seat].length < HAND_SIZE && state.top < state.deck.length) state.hands[seat].push(state.top++);
}

function advanceTurn(state, seat) {
  // End trigger: any player's patent value hits the threshold, or the deck is
  // spent. Finish the round (until the last seat plays) then stop.
  const thr = endThreshold(state.numPlayers);
  const minP = endMinPatents(state.numPlayers);
  const triggered = range(0, state.numPlayers).some((s) =>
    patentValueOf(state, s) >= thr && patentCountOf(state, s) >= minP);
  if (triggered) state.lastRound = true;
  if (state.top >= state.deck.length && state.pool.length === 0) state.lastRound = true;
  state.turn += 1;
  if (state.lastRound && seat === state.numPlayers - 1) state.ended = true;
}

// Lenient fallbacks for replay if validation unexpectedly fails.
function reReadWords(state, seat, payload) {
  const owned = ownedPowers(state, seat);
  const yVowelSet = new Set(payload.yVowels || []);
  const out = [];
  const specs = [{ cards: payload.cards || [], appendS: !!payload.appendS }];
  if (payload.second && (payload.second.cards || []).length) specs.push({ cards: payload.second.cards, appendS: !!payload.second.appendS });
  for (const spec of specs) {
    const letters = wordLetters(state, spec.cards, spec.appendS, yVowelSet);
    out.push(scoreWord(letters, owned));
  }
  return out;
}
function distinctUsed(payload) {
  const out = [], seen = new Set();
  const push = (cards) => { for (const id of cards || []) if (!seen.has(id)) { seen.add(id); out.push(id); } };
  push(payload.cards);
  if (payload.second) push(payload.second.cards);
  return out;
}

// ---- Final standings -------------------------------------------------------

export function finalStandings(state) {
  const rows = [];
  for (let s = 0; s < state.numPlayers; s++) {
    const pv = patentValueOf(state, s);
    rows.push({
      seat: s,
      money: state.money[s],
      stock: state.stock[s],
      patentValue: pv,
      score: state.money[s] + state.stock[s] * STOCK_VALUE + pv,
    });
  }
  return rows;
}

// Seat with the top score; ties broken by patent value then money. Returns a
// seat index, or 'tie' if still level (or everyone at zero).
export function winnerSeat(state) {
  const rows = finalStandings(state).slice().sort((a, b) =>
    b.score - a.score || b.patentValue - a.patentValue || b.money - a.money);
  if (rows.length === 1) return rows[0].seat;
  const a = rows[0], b = rows[1];
  if (a.score === b.score && a.patentValue === b.patentValue && a.money === b.money) return 'tie';
  return a.seat;
}
