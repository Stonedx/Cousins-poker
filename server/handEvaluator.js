// Self-contained Texas Hold'em hand evaluator — no external dependencies.
// Card notation: rank + suit, e.g. "Ah", "Td", "2c" (T = ten).
//
// Every hand is scored as [category, ...tiebreakers], where category is
// 0 (High Card) .. 8 (Straight Flush). Comparing two scores lexicographically
// (category first, then tiebreakers left to right) tells you the winner —
// this is the classic, reliable way to rank poker hands.

const RANK_VALUES = { 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };
const CATEGORY_NAMES = [
  'High Card',
  'Pair',
  'Two Pair',
  'Three of a Kind',
  'Straight',
  'Flush',
  'Full House',
  'Four of a Kind',
  'Straight Flush',
];

function cardValue(card) {
  return RANK_VALUES[card[0]];
}
function cardSuit(card) {
  return card[1];
}

// Evaluate exactly 5 cards. Returns { category, tiebreak: number[] }.
function evaluate5(cards) {
  const values = cards.map(cardValue);
  const suits = cards.map(cardSuit);
  const sortedDesc = [...values].sort((a, b) => b - a);

  const isFlush = suits.every((s) => s === suits[0]);

  const uniqueVals = [...new Set(values)].sort((a, b) => b - a);
  let straightHigh = null;
  if (uniqueVals.length === 5) {
    if (uniqueVals[0] - uniqueVals[4] === 4) {
      straightHigh = uniqueVals[0];
    } else if (uniqueVals.join(',') === '14,5,4,3,2') {
      straightHigh = 5; // wheel: A-2-3-4-5, five-high straight
    }
  }

  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  const countEntries = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const countPattern = countEntries.map((e) => e[1]).join('');

  if (isFlush && straightHigh) {
    return { category: 8, tiebreak: [straightHigh] };
  }
  if (countPattern === '41') {
    return { category: 7, tiebreak: [countEntries[0][0], countEntries[1][0]] };
  }
  if (countPattern === '32') {
    return { category: 6, tiebreak: [countEntries[0][0], countEntries[1][0]] };
  }
  if (isFlush) {
    return { category: 5, tiebreak: sortedDesc };
  }
  if (straightHigh) {
    return { category: 4, tiebreak: [straightHigh] };
  }
  if (countPattern === '311') {
    return { category: 3, tiebreak: [countEntries[0][0], countEntries[1][0], countEntries[2][0]] };
  }
  if (countPattern === '221') {
    const pairs = [countEntries[0][0], countEntries[1][0]].sort((a, b) => b - a);
    return { category: 2, tiebreak: [...pairs, countEntries[2][0]] };
  }
  if (countPattern === '2111') {
    return {
      category: 1,
      tiebreak: [countEntries[0][0], countEntries[1][0], countEntries[2][0], countEntries[3][0]],
    };
  }
  return { category: 0, tiebreak: sortedDesc };
}

function combinations5(cards) {
  // cards.length is 5, 6, or 7 in this app (hole + community). Enumerate all 5-card subsets.
  const n = cards.length;
  if (n === 5) return [cards];
  const results = [];
  const idx = [0, 1, 2, 3, 4];
  const pick = (start, combo) => {
    if (combo.length === 5) {
      results.push(combo.map((i) => cards[i]));
      return;
    }
    for (let i = start; i < n; i++) {
      pick(i + 1, [...combo, i]);
    }
  };
  pick(0, []);
  return results;
}

function compareScore(a, b) {
  if (a.category !== b.category) return a.category - b.category;
  for (let i = 0; i < a.tiebreak.length; i++) {
    const diff = (a.tiebreak[i] || 0) - (b.tiebreak[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function nameFor(category, tiebreak) {
  if (category === 8 && tiebreak[0] === 14) return 'Royal Flush';
  return CATEGORY_NAMES[category];
}

// Best 5-card hand out of 5-7 cards.
function solve(cards) {
  const combos = combinations5(cards);
  let best = null;
  for (const combo of combos) {
    const result = evaluate5(combo);
    if (!best || compareScore(result, best) > 0) {
      best = { ...result, cards: combo };
    }
  }
  return { category: best.category, tiebreak: best.tiebreak, cards: best.cards, name: nameFor(best.category, best.tiebreak) };
}

const VALUE_SINGULAR = {
  2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight',
  9: 'Nine', 10: 'Ten', 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace',
};
const VALUE_PLURAL = {
  2: 'Twos', 3: 'Threes', 4: 'Fours', 5: 'Fives', 6: 'Sixes', 7: 'Sevens', 8: 'Eights',
  9: 'Nines', 10: 'Tens', 11: 'Jacks', 12: 'Queens', 13: 'Kings', 14: 'Aces',
};

// Human-readable description of a solved hand, e.g. "Pair of Kings",
// "Two Pair, Aces & Fives", "King-high Straight" — the readout a poker client shows.
function describe(solved) {
  const t = solved.tiebreak;
  switch (solved.category) {
    case 8:
      return t[0] === 14 ? 'Royal Flush' : `${VALUE_SINGULAR[t[0]]}-high Straight Flush`;
    case 7:
      return `Four ${VALUE_PLURAL[t[0]]}`;
    case 6:
      return `Full House, ${VALUE_PLURAL[t[0]]} full of ${VALUE_PLURAL[t[1]]}`;
    case 5:
      return `${VALUE_SINGULAR[t[0]]}-high Flush`;
    case 4:
      return `${VALUE_SINGULAR[t[0]]}-high Straight`;
    case 3:
      return `Three ${VALUE_PLURAL[t[0]]}`;
    case 2:
      return `Two Pair, ${VALUE_PLURAL[t[0]]} & ${VALUE_PLURAL[t[1]]}`;
    case 1:
      return `Pair of ${VALUE_PLURAL[t[0]]}`;
    default:
      return `${VALUE_SINGULAR[t[0]]} High`;
  }
}

// solvedHands: [{ playerId, solved }] -> playerIds that tie for best hand.
function winners(solvedHands) {
  let bestScore = null;
  for (const { solved } of solvedHands) {
    if (!bestScore || compareScore(solved, bestScore) > 0) bestScore = solved;
  }
  return solvedHands.filter(({ solved }) => compareScore(solved, bestScore) === 0).map((h) => h.playerId);
}

module.exports = { solve, winners, describe };
