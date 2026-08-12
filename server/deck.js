// Standard 52-card deck utilities.
// Card notation matches what `pokersolver` expects: rank + suit, e.g. "Ah", "Td", "2c".

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUITS = ['h', 'd', 'c', 's'];

function freshDeck() {
  const deck = [];
  for (const r of RANKS) {
    for (const s of SUITS) {
      deck.push(r + s);
    }
  }
  return deck;
}

// Fisher-Yates shuffle, in place, returns the same array.
function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function newShuffledDeck() {
  return shuffle(freshDeck());
}

module.exports = { freshDeck, shuffle, newShuffledDeck, RANKS, SUITS };
