const { newShuffledDeck } = require('./deck');
const handEvaluator = require('./handEvaluator');
const { randomId } = require('./ids');

const ACTION_TIMEOUT_MS = 60 * 1000; // auto-fold/check a player who goes quiet mid-hand
const RUNOUT_REVEAL_DELAY_MS = 1600; // pause after flipping all-in hands before the flop lands
const RUNOUT_STREET_DELAY_MS = 1800; // pause between flop → turn → river on an all-in runout
const TIME_BANK_MS = 30 * 1000; // extra time a player can claim once per hand

const DEFAULT_BLIND_SCHEDULE = [
  { smallBlind: 25, bigBlind: 50, ante: 0 },
  { smallBlind: 50, bigBlind: 100, ante: 0 },
  { smallBlind: 75, bigBlind: 150, ante: 0 },
  { smallBlind: 100, bigBlind: 200, ante: 25 },
  { smallBlind: 150, bigBlind: 300, ante: 25 },
  { smallBlind: 200, bigBlind: 400, ante: 50 },
  { smallBlind: 300, bigBlind: 600, ante: 75 },
  { smallBlind: 400, bigBlind: 800, ante: 100 },
  { smallBlind: 500, bigBlind: 1000, ante: 100 },
  { smallBlind: 600, bigBlind: 1200, ante: 200 },
  { smallBlind: 800, bigBlind: 1600, ante: 200 },
  { smallBlind: 1000, bigBlind: 2000, ante: 300 },
  { smallBlind: 1500, bigBlind: 3000, ante: 400 },
  { smallBlind: 2000, bigBlind: 4000, ante: 500 },
];

const MAX_SEATS = 9;
const HAND_OVER_DELAY_MS = 7000; // pause so players can see the result before the next hand deals

function makeCardsPretty(cards) {
  return cards; // client renders suit/rank from the raw code, kept as-is server-side
}

const RANK_WORDS = {
  2: 'Twos', 3: 'Threes', 4: 'Fours', 5: 'Fives', 6: 'Sixes', 7: 'Sevens', 8: 'Eights',
  9: 'Nines', T: 'Tens', J: 'Jacks', Q: 'Queens', K: 'Kings', A: 'Aces',
};
const RANK_SINGULAR = {
  2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight',
  9: 'Nine', T: 'Ten', J: 'Jack', Q: 'Queen', K: 'King', A: 'Ace',
};

// Pre-flop description of two hole cards, e.g. "Pocket Jacks" / "Ace-King suited".
function describeHoleCards(hole) {
  if (!hole || hole.length < 2) return null;
  const [a, b] = hole;
  const ra = a[0], rb = b[0];
  if (ra === rb) return `Pocket ${RANK_WORDS[ra]}`;
  const order = '23456789TJQKA';
  const [hi, lo] = order.indexOf(ra) > order.indexOf(rb) ? [ra, rb] : [rb, ra];
  const suited = a[1] === b[1] ? ' suited' : '';
  return `${RANK_SINGULAR[hi]}-${RANK_SINGULAR[lo]}${suited}`;
}

class Player {
  constructor(id, name, chips) {
    this.id = id;
    this.name = name;
    this.chips = chips;
    this.seat = null;
    this.holeCards = [];
    this.folded = false;
    this.allIn = false;
    this.roundBet = 0; // chips committed in the current betting round
    this.totalBetInHand = 0; // chips committed across the whole hand (for side pots)
    this.connected = true;
    this.bustedOut = false;
    this.bustedPlace = null; // finishing position, set on elimination
    this.sittingOut = false;
    this.hasActed = false;
    this.lastAction = null; // e.g. "raise to 300", for the UI
    this.lastSeenAt = Date.now(); // updated on every API call from this player (polling heartbeat)
    this.timeBankUsedThisHand = false; // one extra-time top-up per hand, like a real client
  }
}

class Table {
  constructor(id, hostPlayerId, options = {}) {
    this.id = id;
    this.hostPlayerId = hostPlayerId;
    this.maxSeats = options.maxSeats || MAX_SEATS;
    this.startingStack = options.startingStack || 10000;
    this.blindSchedule = options.blindSchedule || DEFAULT_BLIND_SCHEDULE;
    this.levelDurationMs = options.levelDurationMs || 15 * 60 * 1000;
    this.tournamentName = options.tournamentName || "Cousins' Poker Night";

    this.seats = new Array(this.maxSeats).fill(null); // Player | null
    this.players = new Map(); // id -> Player
    this.tokens = new Map(); // playerToken -> playerId (for reconnect)

    this.status = 'lobby'; // lobby | active | paused | tournament_over
    this.handNumber = 0;
    this.deck = [];
    this.communityCards = [];
    this.bettingRound = null; // preflop | flop | turn | river | showdown
    this.dealerSeat = -1;
    this.actingSeat = -1;
    this.currentBet = 0;
    this.minRaiseAmount = 0;
    this.playersToAct = new Set();
    this.pots = []; // computed at showdown: [{amount, eligiblePlayerIds}]
    this.log = [];
    this.eliminationCounter = 0; // counts down finishing places

    this.blindLevelIndex = 0;
    this.levelStartedAt = null;
    this.handOverTimer = null;

    this.onStateChange = null; // set by server, called whenever state should broadcast
  }

  addLog(message) {
    this.log.push({ t: Date.now(), message });
    if (this.log.length > 60) this.log.shift();
  }

  notify() {
    if (this.onStateChange) this.onStateChange(this);
  }

  // ---------- Player / seating management ----------

  addPlayer(name) {
    if (this.status !== 'lobby') {
      throw new Error('This game has already started — ask the host for a new table.');
    }
    const seatIndex = this.seats.findIndex((s) => s === null);
    if (seatIndex === -1) throw new Error('Table is full.');

    const id = randomId(10);
    const player = new Player(id, name.slice(0, 20) || 'Player', this.startingStack);
    player.seat = seatIndex;
    this.seats[seatIndex] = player;
    this.players.set(id, player);

    const token = randomId(24);
    this.tokens.set(token, id);

    this.addLog(`${player.name} joined the table.`);
    return { player, token };
  }

  // The client is a polling web app, not a persistent socket — "connection" here just means
  // "we resolved their token and touched their heartbeat," used to show a connected/away dot
  // and to know it's safe to auto-fold someone who's gone quiet mid-hand.
  playerByToken(token) {
    const playerId = this.tokens.get(token);
    if (!playerId) return null;
    const player = this.players.get(playerId);
    if (!player) return null;
    return player;
  }

  touchPlayer(player) {
    const wasDisconnected = !player.connected;
    player.connected = true;
    player.lastSeenAt = Date.now();
    if (wasDisconnected) this.addLog(`${player.name} is back.`);
  }

  sweepStalePlayers(staleAfterMs = 8000) {
    const now = Date.now();
    for (const player of this.players.values()) {
      if (player.connected && now - player.lastSeenAt > staleAfterMs) {
        player.connected = false;
        this.addLog(`${player.name} disconnected.`);
      }
    }
  }

  activePlayers() {
    // seated, not busted
    return [...this.players.values()].filter((p) => !p.bustedOut);
  }

  // ---------- Tournament lifecycle ----------

  startTournament(requesterId) {
    if (requesterId !== this.hostPlayerId) throw new Error('Only the host can start the game.');
    if (this.status !== 'lobby') throw new Error('Game already started.');
    const seated = this.activePlayers();
    if (seated.length < 2) throw new Error('Need at least 2 players to start.');

    this.status = 'active';
    this.blindLevelIndex = 0;
    this.levelStartedAt = Date.now();
    this.dealerSeat = seated[0].seat; // first hand dealer = first seated player; rotates after
    this.addLog(`Tournament started with ${seated.length} players.`);
    this.startHand();
  }

  currentBlinds() {
    const idx = Math.min(this.blindLevelIndex, this.blindSchedule.length - 1);
    return this.blindSchedule[idx];
  }

  maybeAdvanceBlindLevel() {
    if (this.status !== 'active') return;
    const elapsed = Date.now() - this.levelStartedAt;
    if (elapsed >= this.levelDurationMs && this.blindLevelIndex < this.blindSchedule.length - 1) {
      this.blindLevelIndex += 1;
      this.levelStartedAt = Date.now();
      const b = this.currentBlinds();
      this.addLog(`Blinds increased to ${b.smallBlind}/${b.bigBlind}${b.ante ? ` (ante ${b.ante})` : ''}.`);
      this.notify();
    }
  }

  // ---------- Hand lifecycle ----------

  nextOccupiedSeat(fromSeat, predicate) {
    for (let i = 1; i <= this.maxSeats; i++) {
      const idx = (fromSeat + i) % this.maxSeats;
      const p = this.seats[idx];
      if (p && (!predicate || predicate(p))) return idx;
    }
    return -1;
  }

  startHand() {
    const contenders = this.activePlayers().filter((p) => p.chips > 0);
    if (contenders.length < 2) {
      this.endTournament();
      return;
    }

    this.handNumber += 1;
    this.deck = newShuffledDeck();
    this.communityCards = [];
    this.pots = [];
    this.bettingRound = 'preflop';
    // Critical: clear last hand's showdown reveal, or previously-shown players' hole cards
    // stay visible to everyone for the rest of the tournament.
    this.showdownReveal = null;
    this.showdownResults = null;
    this.dealingRunout = false;

    for (const p of this.players.values()) {
      p.holeCards = [];
      p.folded = p.bustedOut; // busted players are treated as folded/out of the hand
      p.allIn = false;
      p.roundBet = 0;
      p.totalBetInHand = 0;
      p.hasActed = false;
      p.lastAction = null;
      p.timeBankUsedThisHand = false;
      if (p.chips <= 0 && !p.bustedOut) p.folded = true; // safety
    }

    // Rotate dealer to next occupied seat with chips.
    this.dealerSeat = this.nextOccupiedSeat(this.dealerSeat, (p) => p.chips > 0 && !p.bustedOut);

    const playing = () => this.seatsInOrder().filter((p) => p.chips > 0 && !p.bustedOut);
    const order = playing();

    const blinds = this.currentBlinds();
    let sbSeat, bbSeat;
    if (order.length === 2) {
      // Heads-up: dealer posts small blind and acts first preflop.
      sbSeat = this.dealerSeat;
      bbSeat = this.nextOccupiedSeat(this.dealerSeat, (p) => p.chips > 0 && !p.bustedOut);
    } else {
      sbSeat = this.nextOccupiedSeat(this.dealerSeat, (p) => p.chips > 0 && !p.bustedOut);
      bbSeat = this.nextOccupiedSeat(sbSeat, (p) => p.chips > 0 && !p.bustedOut);
    }
    this.smallBlindSeat = sbSeat;
    this.bigBlindSeat = bbSeat;

    // Antes first.
    if (blinds.ante > 0) {
      for (const p of order) {
        const ante = Math.min(blinds.ante, p.chips);
        p.chips -= ante;
        p.totalBetInHand += ante;
        if (p.chips === 0) p.allIn = true;
      }
    }

    this.postBet(this.seats[sbSeat], blinds.smallBlind);
    this.postBet(this.seats[bbSeat], blinds.bigBlind);

    // Deal two hole cards each, in order starting left of dealer.
    for (let round = 0; round < 2; round++) {
      for (const p of order) {
        p.holeCards.push(this.deck.pop());
      }
    }

    this.currentBet = blinds.bigBlind;
    this.minRaiseAmount = blinds.bigBlind;

    // First to act preflop: left of big blind (3+ players), or the small-blind/dealer in heads-up.
    if (order.length === 2) {
      this.actingSeat = sbSeat; // dealer/SB acts first preflop heads-up
    } else {
      this.actingSeat = this.nextOccupiedSeat(bbSeat, (p) => p.chips > 0 && !p.bustedOut && !p.folded);
    }

    this.playersToAct = new Set(order.filter((p) => !p.allIn).map((p) => p.id));
    this.actingSince = Date.now();
    // Blind posters still owe action even though they've "acted" by posting.
    this.addLog(
      `Hand #${this.handNumber} — blinds ${blinds.smallBlind}/${blinds.bigBlind}${blinds.ante ? ` (ante ${blinds.ante})` : ''}. ${this.seats[sbSeat].name} posts SB, ${this.seats[bbSeat].name} posts BB.`
    );

    this.resolveAutoAdvance();
    this.notify();
  }

  postBet(player, amount) {
    const bet = Math.min(amount, player.chips);
    player.chips -= bet;
    player.roundBet += bet;
    player.totalBetInHand += bet;
    if (player.chips === 0) player.allIn = true;
  }

  seatsInOrder() {
    const out = [];
    for (let i = 0; i < this.maxSeats; i++) {
      if (this.seats[i]) out.push(this.seats[i]);
    }
    return out;
  }

  nonFoldedPlayers() {
    return this.seatsInOrder().filter((p) => !p.folded && !p.bustedOut);
  }

  // ---------- Actions ----------

  handleAction(playerId, type, amount) {
    const player = this.players.get(playerId);
    if (!player) throw new Error('Unknown player.');
    if (this.bettingRound === null || this.bettingRound === 'showdown') {
      throw new Error('No betting in progress.');
    }
    if (!this.seats[this.actingSeat] || this.seats[this.actingSeat].id !== playerId) {
      throw new Error("It's not your turn.");
    }

    const toCall = this.currentBet - player.roundBet;

    switch (type) {
      case 'fold': {
        player.folded = true;
        player.lastAction = 'folded';
        this.playersToAct.delete(playerId);
        this.addLog(`${player.name} folds.`);
        break;
      }
      case 'check': {
        if (toCall > 0) throw new Error('You cannot check — there is a bet to call.');
        player.hasActed = true;
        player.lastAction = 'checked';
        this.playersToAct.delete(playerId);
        this.addLog(`${player.name} checks.`);
        break;
      }
      case 'call': {
        if (toCall <= 0) throw new Error('Nothing to call — check instead.');
        const callAmt = Math.min(toCall, player.chips);
        player.chips -= callAmt;
        player.roundBet += callAmt;
        player.totalBetInHand += callAmt;
        if (player.chips === 0) player.allIn = true;
        player.lastAction = player.allIn ? `all-in call (${player.roundBet})` : `called ${callAmt}`;
        this.playersToAct.delete(playerId);
        this.addLog(`${player.name} ${player.allIn ? 'calls all-in' : 'calls'} ${callAmt}.`);
        break;
      }
      case 'bet':
      case 'raise': {
        // `amount` = the TOTAL amount the player wants their roundBet to become.
        const desiredTotal = Math.floor(amount);
        const addChips = desiredTotal - player.roundBet;
        if (addChips <= 0) throw new Error('Raise must increase your bet.');
        if (addChips > player.chips) throw new Error('Not enough chips.');

        const isAllIn = addChips === player.chips;
        const raiseIncrement = desiredTotal - this.currentBet;
        if (!isAllIn && desiredTotal < this.currentBet + this.minRaiseAmount) {
          throw new Error(`Minimum raise is to ${this.currentBet + this.minRaiseAmount}.`);
        }

        player.chips -= addChips;
        player.roundBet = desiredTotal;
        player.totalBetInHand += addChips;
        if (player.chips === 0) player.allIn = true;

        const wasRaise = desiredTotal > this.currentBet;
        if (wasRaise && raiseIncrement >= this.minRaiseAmount) {
          this.minRaiseAmount = raiseIncrement;
        }
        this.currentBet = Math.max(this.currentBet, desiredTotal);

        player.lastAction = player.allIn ? `all-in (${desiredTotal})` : `raised to ${desiredTotal}`;
        this.addLog(`${player.name} ${player.allIn ? 'moves all-in for' : 'raises to'} ${desiredTotal}.`);

        // Everyone else who hasn't matched this bet now owes action again.
        this.playersToAct = new Set(
          this.nonFoldedPlayers()
            .filter((p) => p.id !== player.id && !p.allIn)
            .map((p) => p.id)
        );
        break;
      }
      default:
        throw new Error('Unknown action.');
    }

    this.advanceActingSeat();
    this.resolveAutoAdvance();
    this.notify();
  }

  advanceActingSeat() {
    const next = this.nextOccupiedSeat(this.actingSeat, (p) => !p.folded && !p.bustedOut && !p.allIn);
    this.actingSeat = next;
    this.actingSince = Date.now();
  }

  // "Extra time" — one top-up per hand for the player currently on the clock.
  useTimeBank(playerId) {
    const player = this.players.get(playerId);
    if (!player) throw new Error('Unknown player.');
    if (!this.seats[this.actingSeat] || this.seats[this.actingSeat].id !== playerId) {
      throw new Error("You can only use extra time on your own turn.");
    }
    if (player.timeBankUsedThisHand) throw new Error('Extra time already used this hand.');
    player.timeBankUsedThisHand = true;
    // The deadline is actingSince + ACTION_TIMEOUT_MS, so pushing actingSince forward
    // buys exactly TIME_BANK_MS more.
    this.actingSince += TIME_BANK_MS;
    this.addLog(`${player.name} used extra time.`);
    this.notify();
  }

  // Called from the server's periodic tick. If whoever is up has gone quiet for too long
  // (phone locked, lost connection, stepped away), act for them so the table doesn't stall.
  checkActionTimeout() {
    if (this.status !== 'active') return;
    if (this.dealingRunout) return; // board is running out on a timer; nobody is due to act
    if (!['preflop', 'flop', 'turn', 'river'].includes(this.bettingRound)) return;
    if (this.actingSeat < 0 || !this.seats[this.actingSeat]) return;
    if (!this.actingSince || Date.now() - this.actingSince < ACTION_TIMEOUT_MS) return;

    const player = this.seats[this.actingSeat];
    const toCall = this.currentBet - player.roundBet;
    try {
      this.handleAction(player.id, toCall > 0 ? 'fold' : 'check', undefined);
      this.addLog(`${player.name} was auto-folded (no action taken).`);
    } catch (err) {
      // If something about game state changed underneath us, don't crash the tick loop.
    }
  }

  // Handles: uncontested wins, closing betting rounds, dealing streets, showdown, and the
  // case where remaining players are all-in and the board just needs to run out.
  resolveAutoAdvance() {
    if (this.dealingRunout) return; // a timed all-in runout is already in progress
    const remaining = this.nonFoldedPlayers();
    if (remaining.length <= 1) {
      this.awardUncontested(remaining[0]);
      return;
    }

    const stillToAct = remaining.filter((p) => !p.allIn && this.playersToAct.has(p.id));
    if (stillToAct.length > 0) return; // betting continues

    const contestants = remaining.filter((p) => !p.allIn);
    if (contestants.length <= 1) {
      // Everyone (or all but one) is all-in — run out remaining streets with no more betting.
      this.runOutBoard();
      return;
    }

    this.advanceStreet();
  }

  advanceStreet() {
    for (const p of this.nonFoldedPlayers()) {
      p.roundBet = 0;
      p.hasActed = false;
    }
    this.currentBet = 0;
    this.minRaiseAmount = this.currentBlinds().bigBlind;

    if (this.bettingRound === 'preflop') {
      this.deck.pop(); // burn
      this.communityCards.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
      this.bettingRound = 'flop';
    } else if (this.bettingRound === 'flop') {
      this.deck.pop();
      this.communityCards.push(this.deck.pop());
      this.bettingRound = 'turn';
    } else if (this.bettingRound === 'turn') {
      this.deck.pop();
      this.communityCards.push(this.deck.pop());
      this.bettingRound = 'river';
    } else if (this.bettingRound === 'river') {
      this.goToShowdown();
      return;
    }

    this.addLog(`— ${this.bettingRound.toUpperCase()}: ${this.communityCards.join(' ')} —`);

    const activeToAct = this.nonFoldedPlayers().filter((p) => !p.allIn);
    this.playersToAct = new Set(activeToAct.map((p) => p.id));
    if (activeToAct.length > 0) {
      this.actingSeat = this.nextOccupiedSeat(this.dealerSeat, (p) => !p.folded && !p.bustedOut && !p.allIn);
      this.actingSince = Date.now();
    }
    this.resolveAutoAdvance();
  }

  // Everyone left is all-in, so there's no more betting — but rather than dumping the whole
  // board at once, deal it out one street at a time on a timer so the hand actually has some
  // drama to it. All-in players' hole cards are flipped face-up first (as a real table would),
  // then flop → turn → river land with a pause between each.
  runOutBoard() {
    this.dealingRunout = true;

    // Flip the all-in players' cards face-up now — they have no more decisions to make, so
    // there's nothing left to protect, and it's what makes the runout worth watching.
    this.showdownReveal = this.nonFoldedPlayers().map((p) => ({ playerId: p.id, holeCards: p.holeCards }));
    this.addLog('All-in — cards on their backs!');
    this.notify();

    const dealNextStreet = () => {
      if (this.bettingRound === 'preflop') {
        this.deck.pop(); // burn
        this.communityCards.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
        this.bettingRound = 'flop';
        this.addLog(`— FLOP: ${this.communityCards.join(' ')} —`);
      } else if (this.bettingRound === 'flop') {
        this.deck.pop();
        this.communityCards.push(this.deck.pop());
        this.bettingRound = 'turn';
        this.addLog(`— TURN: ${this.communityCards.join(' ')} —`);
      } else if (this.bettingRound === 'turn') {
        this.deck.pop();
        this.communityCards.push(this.deck.pop());
        this.bettingRound = 'river';
        this.addLog(`— RIVER: ${this.communityCards.join(' ')} —`);
      }

      this.notify();

      if (this.bettingRound === 'river') {
        this.runoutTimer = setTimeout(() => {
          this.dealingRunout = false;
          this.goToShowdown();
        }, RUNOUT_STREET_DELAY_MS);
      } else {
        this.runoutTimer = setTimeout(dealNextStreet, RUNOUT_STREET_DELAY_MS);
      }
    };

    this.runoutTimer = setTimeout(dealNextStreet, RUNOUT_REVEAL_DELAY_MS);
  }

  computePots() {
    const contributors = this.seatsInOrder()
      .filter((p) => p.totalBetInHand > 0)
      .map((p) => ({ id: p.id, amount: p.totalBetInHand, folded: p.folded }));

    const levels = [...new Set(contributors.map((c) => c.amount))].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const level of levels) {
      const layerContributors = contributors.filter((c) => c.amount >= level);
      const layerAmount = (level - prev) * layerContributors.length;
      const eligible = layerContributors.filter((c) => !c.folded).map((c) => c.id);
      if (layerAmount > 0 && eligible.length > 0) {
        pots.push({ amount: layerAmount, eligiblePlayerIds: eligible });
      }
      prev = level;
    }
    return pots;
  }

  awardUncontested(winner) {
    this.pots = this.computePots();
    const totalPot = this.pots.reduce((s, p) => s + p.amount, 0);
    if (winner) {
      winner.chips += totalPot;
      this.addLog(`${winner.name} wins ${totalPot} (everyone else folded).`);
    }
    this.finishHand([]);
  }

  goToShowdown() {
    this.bettingRound = 'showdown';
    this.pots = this.computePots();

    const contenders = this.nonFoldedPlayers();
    const solved = contenders.map((p) => ({
      playerId: p.id,
      solved: handEvaluator.solve([...p.holeCards, ...this.communityCards]),
    }));

    const results = [];
    for (const pot of this.pots) {
      const eligible = solved.filter((s) => pot.eligiblePlayerIds.includes(s.playerId));
      if (eligible.length === 0) continue;
      const winnerIds = handEvaluator.winners(eligible);
      const share = Math.floor(pot.amount / winnerIds.length);
      let remainder = pot.amount - share * winnerIds.length;
      for (const wid of winnerIds) {
        const p = this.players.get(wid);
        let payout = share;
        if (remainder > 0) {
          payout += 1;
          remainder -= 1;
        }
        p.chips += payout;
      }
      const winnerNames = winnerIds.map((id) => this.players.get(id).name);
      const winningSolved = eligible.find((s) => winnerIds.includes(s.playerId)).solved;
      const handName = handEvaluator.describe(winningSolved);
      const verb = winnerNames.length > 1 ? 'win' : 'wins';
      this.addLog(`${winnerNames.join(' & ')} ${verb} ${pot.amount} with ${handName}.`);
      results.push({
        potAmount: pot.amount,
        winnerIds,
        winnerNames,
        handName,
        // The exact 5 cards that made the winning hand, so the UI can highlight them.
        winningCards: winningSolved.cards,
      });
    }

    const reveal = contenders.map((p) => ({ playerId: p.id, holeCards: p.holeCards }));
    this.finishHand(reveal, results);
  }

  finishHand(reveal, results = []) {
    this.bettingRound = 'handover';
    this.showdownReveal = reveal;
    this.showdownResults = results;
    this.dealingRunout = false;
    if (this.runoutTimer) {
      clearTimeout(this.runoutTimer);
      this.runoutTimer = null;
    }

    // Eliminations: 0-chip players are out. Rank by reverse elimination order.
    const stillIn = this.activePlayers().filter((p) => p.chips > 0);
    const bustedThisHand = this.activePlayers().filter((p) => p.chips <= 0 && !p.bustedOut);
    for (const p of bustedThisHand) {
      p.bustedOut = true;
      p.bustedPlace = stillIn.length + bustedThisHand.filter((x) => !x.bustedPlace).length; // computed below, refined next
    }
    // Assign finishing places properly: everyone busting in the same hand ties for the same place band,
    // ranked below all currently-remaining players.
    if (bustedThisHand.length > 0) {
      const place = stillIn.length + 1;
      for (const p of bustedThisHand) {
        p.bustedPlace = place;
        this.addLog(`${p.name} is eliminated (finished ${this.ordinal(place)}).`);
      }
    }

    this.notify();

    const remainingWithChips = this.activePlayers().filter((p) => p.chips > 0);
    if (remainingWithChips.length <= 1) {
      this.handOverTimer = setTimeout(() => this.endTournament(), HAND_OVER_DELAY_MS);
      return;
    }

    this.handOverTimer = setTimeout(() => {
      this.maybeAdvanceBlindLevel();
      this.startHand();
    }, HAND_OVER_DELAY_MS);
  }

  ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  endTournament() {
    this.status = 'tournament_over';
    this.bettingRound = null;
    const winner = this.activePlayers().find((p) => p.chips > 0);
    if (winner) {
      winner.bustedPlace = 1;
      this.addLog(`🏆 ${winner.name} wins the tournament!`);
    }
    this.notify();
  }

  // ---------- Serialization for clients ----------

  getStateFor(playerId) {
    const blinds = this.currentBlinds();
    const timeRemainingMs =
      this.status === 'active'
        ? Math.max(0, this.levelDurationMs - (Date.now() - this.levelStartedAt))
        : this.levelDurationMs;

    const standings = this.activePlayers()
      .slice()
      .sort((a, b) => {
        if (a.bustedPlace && b.bustedPlace) return a.bustedPlace - b.bustedPlace;
        if (a.bustedPlace) return 1;
        if (b.bustedPlace) return -1;
        return b.chips - a.chips;
      });

    return {
      tableId: this.id,
      tournamentName: this.tournamentName,
      status: this.status,
      hostPlayerId: this.hostPlayerId,
      handNumber: this.handNumber,
      bettingRound: this.bettingRound,
      communityCards: makeCardsPretty(this.communityCards),
      dealerSeat: this.dealerSeat,
      smallBlindSeat: this.smallBlindSeat,
      bigBlindSeat: this.bigBlindSeat,
      actingPlayerId:
        !this.dealingRunout && this.actingSeat >= 0 && this.seats[this.actingSeat]
          ? this.seats[this.actingSeat].id
          : null,
      dealingRunout: !!this.dealingRunout,
      actionDeadlineMs: this.actingSince && !this.dealingRunout
        ? Math.max(0, ACTION_TIMEOUT_MS - (Date.now() - this.actingSince))
        : null,
      currentBet: this.currentBet,
      minRaiseAmount: this.minRaiseAmount,
      pots: this.status === 'active' ? this.computePotsPreview() : [],
      blindLevel: {
        level: this.blindLevelIndex + 1,
        smallBlind: blinds.smallBlind,
        bigBlind: blinds.bigBlind,
        ante: blinds.ante,
        timeRemainingMs,
        nextBlind: this.blindSchedule[this.blindLevelIndex + 1] || null,
      },
      players: this.seats.map((p, seatIdx) => {
        if (!p) return null;
        const isMe = p.id === playerId;
        const showCards =
          isMe ||
          (this.showdownReveal && this.showdownReveal.some((r) => r.playerId === p.id));
        return {
          id: p.id,
          name: p.name,
          seat: seatIdx,
          chips: p.chips,
          folded: p.folded,
          allIn: p.allIn,
          bustedOut: p.bustedOut,
          bustedPlace: p.bustedPlace,
          connected: p.connected,
          roundBet: p.roundBet,
          totalBetInHand: p.totalBetInHand,
          lastAction: p.lastAction,
          isMe,
          holeCards: showCards ? p.holeCards : p.holeCards.map(() => (p.folded ? null : 'back')),
        };
      }),
      standings: standings.map((p) => ({ id: p.id, name: p.name, chips: p.chips, bustedPlace: p.bustedPlace })),
      log: this.log.slice(-30),
      showdownResults: this.showdownResults || null,
      maxSeats: this.maxSeats,
      // What the requesting player currently holds ("Pair of Jacks"), like the readout
      // every modern client shows under your cards.
      myHand: this.describeHandFor(playerId),
      canUseTimeBank: this.canUseTimeBank(playerId),
    };
  }

  describeHandFor(playerId) {
    const player = this.players.get(playerId);
    if (!player || player.folded || player.bustedOut) return null;
    if (!player.holeCards || player.holeCards.length < 2) return null;
    const cards = [...player.holeCards, ...this.communityCards];
    if (cards.length < 5) {
      // Pre-flop there's no five-card hand yet — describe the hole cards instead.
      return describeHoleCards(player.holeCards);
    }
    try {
      return handEvaluator.describe(handEvaluator.solve(cards));
    } catch (e) {
      return null;
    }
  }

  canUseTimeBank(playerId) {
    const player = this.players.get(playerId);
    if (!player || this.dealingRunout) return false;
    if (!this.seats[this.actingSeat] || this.seats[this.actingSeat].id !== playerId) return false;
    return !player.timeBankUsedThisHand;
  }

  computePotsPreview() {
    // Live pot total (before final side-pot split, just for display during a hand).
    const total = this.seatsInOrder().reduce((s, p) => s + p.totalBetInHand, 0);
    return [{ amount: total }];
  }
}

module.exports = { Table, DEFAULT_BLIND_SCHEDULE };
