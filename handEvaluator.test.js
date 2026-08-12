const assert = require('assert');
const { solve, winners } = require('../server/handEvaluator');

function name(cards) {
  return solve(cards).name;
}

// Category identification
assert.strictEqual(name(['Ah', 'Kh', 'Qh', 'Jh', 'Th', '2c', '3d']), 'Royal Flush');
assert.strictEqual(name(['9h', '8h', '7h', '6h', '5h', '2c', '3d']), 'Straight Flush');
assert.strictEqual(name(['Ah', 'Ad', 'Ac', 'As', 'Kh', '2c', '3d']), 'Four of a Kind');
assert.strictEqual(name(['Ah', 'Ad', 'Ac', 'Kh', 'Ks', '2c', '3d']), 'Full House');
assert.strictEqual(name(['Ah', '9h', '7h', '4h', '2h', '2c', '3d']), 'Flush');
assert.strictEqual(name(['9h', '8d', '7c', '6h', '5s', '2c', 'Kd']), 'Straight');
assert.strictEqual(name(['Ah', '5d', '4c', '3h', '2s', '9c', 'Kd']), 'Straight'); // wheel A-2-3-4-5
assert.strictEqual(name(['Ah', 'Ad', 'Ac', 'Kh', 'Qs', '2c', '3d']), 'Three of a Kind');
assert.strictEqual(name(['Ah', 'Ad', 'Kc', 'Kh', 'Qs', '2c', '3d']), 'Two Pair');
assert.strictEqual(name(['Ah', 'Ad', 'Kc', 'Qh', 'Js', '2c', '3d']), 'Pair');
assert.strictEqual(name(['Ah', 'Kd', 'Qc', 'Jh', '9s', '2c', '3d']), 'High Card');
console.log('Category identification: OK');

// Best-of-7 picks correctly (should find the straight flush hidden among 7 cards)
const sf = solve(['2h', '3h', '4h', '5h', '6h', 'Ad', 'Kc']);
assert.strictEqual(sf.name, 'Straight Flush');
assert.strictEqual(sf.tiebreak[0], 6);
console.log('Best-of-7 selection: OK');

// Higher straight flush beats lower straight flush
const sfHigh = solve(['9h', 'Th', 'Jh', 'Qh', 'Kh', '2c', '3d']);
const sfLow = solve(['2h', '3h', '4h', '5h', '6h', 'Ad', 'Kc']);
assert.ok(sfHigh.tiebreak[0] > sfLow.tiebreak[0]);
console.log('Straight flush ranking: OK');

// Kicker comparisons: same pair, different kicker
function score(cards) {
  return solve(cards);
}
const pairAceKingKicker = score(['Ah', 'Ad', 'Kc', '9h', '7s', '2c', '3d']);
const pairAceQueenKicker = score(['Ah', 'Ad', 'Qc', '9h', '7s', '2c', '3d']);
assert.strictEqual(pairAceKingKicker.category, pairAceQueenKicker.category);
assert.ok(pairAceKingKicker.tiebreak[1] > pairAceQueenKicker.tiebreak[1]);
console.log('Kicker comparison: OK');

// winners(): tie detection (identical hands on the board, different hole cards that don't improve it)
const board = ['2c', '5d', '9h', 'Jc', 'Ks']; // no pairs, no straight, no flush possible on board alone
const p1 = { playerId: 'p1', solved: solve(['3h', '4h', ...board]) };
const p2 = { playerId: 'p2', solved: solve(['3d', '4d', ...board]) }; // plays the board identically-ranked high cards
// Force an exact tie scenario instead: both play the board (7 cards produce same best 5 -> K J 9 5 2 high)
const boardOnlyA = { playerId: 'a', solved: solve(['2h', '3h', ...board]) }; // low unrelated hole cards, best hand = board
const boardOnlyB = { playerId: 'b', solved: solve(['2d', '3d', ...board]) };
const tieWinners = winners([boardOnlyA, boardOnlyB]);
assert.strictEqual(tieWinners.length, 2, 'expected a chopped pot / tie');
console.log('Tie detection: OK');

// winners(): clear single winner
const strongHand = { playerId: 'strong', solved: solve(['Ah', 'Ad', ...board]) }; // pair of aces
const weakHand = { playerId: 'weak', solved: solve(['2h', '3h', ...board]) }; // board-only
const clearWinners = winners([strongHand, weakHand]);
assert.deepStrictEqual(clearWinners, ['strong']);
console.log('Single winner detection: OK');

console.log('\nAll hand evaluator tests passed.');
