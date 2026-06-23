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

// Patent cost == end value, mostly by how often the letter shows up (a common
// letter earns more royalties, so it costs more). The seven lettered powers are
// the cheap, rare letters — their ability is the draw, not the value.
export const PATENTS = {
  E: { cost: 10 }, A: { cost: 9 }, I: { cost: 8 }, O: { cost: 8 },
  N: { cost: 7 }, R: { cost: 7 }, T: { cost: 7 }, S: { cost: 7 },
  L: { cost: 6 }, U: { cost: 6 }, D: { cost: 6 },
  G: { cost: 5 }, C: { cost: 5 }, M: { cost: 5 }, H: { cost: 5 },
  P: { cost: 4 }, Y: { cost: 4 }, F: { cost: 4 }, W: { cost: 4 },
  B: { cost: 4, power: 'B' }, V: { cost: 3, power: 'V' }, K: { cost: 3, power: 'K' },
  J: { cost: 3, power: 'J' }, X: { cost: 3, power: 'X' }, Q: { cost: 2, power: 'Q' },
  Z: { cost: 2, power: 'Z' },
};

// Short human text for each special power (shown in the UI / how-to).
export const POWER_TEXT = {
  B: 'Earn double when your word starts and ends with a vowel.',
  J: 'Earn double when at least half your word is vowels.',
  K: 'Earn double when your word has exactly one vowel.',
  Q: 'Start of turn: you may discard one card and draw one.',
  V: 'Spell two words on your turn (scored separately).',
  X: 'Use one of your letter cards twice.',
  Z: 'Add an S to the end of your word for free.',
};

// Total patent value that, once any player reaches it, triggers the final round.
export const END_THRESHOLD = { 2: 10, 3: 8, 4: 7, 5: 6 };
export function endThreshold(numPlayers) {
  return END_THRESHOLD[numPlayers] ?? END_THRESHOLD[2];
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

// ---- Word evaluation -------------------------------------------------------
//
// A play's payload describes the cards spelling the word, in order. The same id
// may appear twice only with the X power (use one card twice). Flags:
//   appendS  — Z power, tacks an S on the end (no card)
//   second   — V power, a second word played the same turn ({ cards: [...] })
//   buy      — letter to patent this turn (must be in your word(s))
//   qDiscard — Q power, a card discarded at the START of the turn (drew a fresh
//              one before building); applied before the word is read.

function wordFromCards(state, cards, appendS) {
  let w = cards.map((id) => state.deck[id]).join('');
  if (appendS) w += 'S';
  return w.toUpperCase();
}

function vowelCount(word) {
  let v = 0;
  for (const ch of word) if (VOWELS.has(ch)) v += 1;
  return v;
}

// Money/stock for a single word, applying the owner's passive doublers and the
// universal Q-in-word double. `owned` is the set of powers this seat holds.
function scoreWord(word, owned) {
  let money = moneyForLength(word.length);
  let stock = stockForLength(word.length);
  const v = vowelCount(word);

  // Patent-ability doubler (B/J/K). They don't stack with each other.
  const bigB = owned.has('B') && word.length >= 2 && VOWELS.has(word[0]) && VOWELS.has(word[word.length - 1]);
  const bigJ = owned.has('J') && v * 2 >= word.length;
  const bigK = owned.has('K') && v === 1;
  if (bigB || bigJ || bigK) money *= 2;

  // A Q anywhere in the word doubles both money and stock (for everyone).
  if (word.includes('Q')) { money *= 2; stock *= 2; }

  return { money, stock };
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

    const word = wordFromCards(state, cards, spec.appendS);
    if (word.length < MIN_WORD) return fail('Words must be 3+ letters.');
    if (isWord && !isWord(word)) return fail(`${word} is not a word.`);

    words.push({ word, ...scoreWord(word, owned) });
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

  // Patent purchase eligibility (priced, not yet paid).
  let buy = null;
  if (payload.buy) {
    const letter = String(payload.buy).toUpperCase();
    if (!PATENTS[letter]) return fail('Unknown patent.');
    if (state.patents[letter] != null) return fail('That patent is already owned.');
    const inWords = words.some((w) => w.word.includes(letter));
    if (!inWords) return fail('You can only patent a letter from your word.');
    // You may spend the money you just earned this turn (applied before the buy).
    const projected = state.money[seat] + words.reduce((a, w) => a + w.money, 0);
    if (projected < PATENTS[letter].cost) return fail('Not enough money for that patent.');
    buy = { letter, cost: PATENTS[letter].cost };
  }

  return { ok: true, words, money, stock, usedIds: usedAll, buy, letters: lettersIn(words) };
}

function lettersIn(words) {
  const set = new Set();
  for (const w of words) for (const ch of w.word) set.add(ch);
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

  // 2. Royalties: $1 from the bank to each OTHER owner per use of their letter.
  const royalties = new Array(state.numPlayers).fill(0);
  for (const w of words) {
    for (const ch of w.word) {
      const owner = state.patents[ch];
      if (owner != null && owner !== seat) royalties[owner] += 1;
    }
  }

  state.money[seat] += money;
  state.stock[seat] += stock;
  for (let s = 0; s < state.numPlayers; s++) state.money[s] += royalties[s];

  // 3. Patent purchase (re-checked against current funds).
  let bought = null;
  if (payload.buy) {
    const letter = String(payload.buy).toUpperCase();
    const inWords = words.some((w) => w.word.includes(letter));
    if (PATENTS[letter] && state.patents[letter] == null && inWords && state.money[seat] >= PATENTS[letter].cost) {
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
  const maxVal = Math.max(...range(0, state.numPlayers).map((s) => patentValueOf(state, s)));
  if (maxVal >= endThreshold(state.numPlayers)) state.lastRound = true;
  if (state.top >= state.deck.length && state.pool.length === 0) state.lastRound = true;
  state.turn += 1;
  if (state.lastRound && seat === state.numPlayers - 1) state.ended = true;
}

// Lenient fallbacks for replay if validation unexpectedly fails.
function reReadWords(state, seat, payload) {
  const owned = ownedPowers(state, seat);
  const out = [];
  const specs = [{ cards: payload.cards || [], appendS: !!payload.appendS }];
  if (payload.second && (payload.second.cards || []).length) specs.push({ cards: payload.second.cards, appendS: !!payload.second.appendS });
  for (const spec of specs) {
    const word = wordFromCards(state, spec.cards, spec.appendS);
    out.push({ word, ...scoreWord(word, owned) });
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
