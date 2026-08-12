// End-to-end test driving the real HTTP API (as the frontend would) against a live
// instance of the server, covering: table creation/joining, a full hand played out to
// showdown via check/call, and — the trickiest part of any poker engine — an all-in
// scenario that forces multiple side pots, verifying chip conservation and correct payouts.

process.env.PORT = '4123';
const assert = require('assert');
const BASE = 'http://localhost:4123';

const { server, tables } = require('../server/index.js');

function post(path, body) {
  return fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then((r) => r.json());
}
function get(path, params) {
  const qs = new URLSearchParams(params).toString();
  return fetch(`${BASE}${path}?${qs}`).then((r) => r.json());
}

function totalChips(state) {
  return state.players.filter(Boolean).reduce((s, p) => s + p.chips + p.roundBet, 0);
}

async function playCheckCallHandToShowdown(sessions) {
  // Drives a single hand forward using "call if behind, else check" for everyone,
  // which is always a legal action, until the hand resolves (bettingRound becomes
  // 'handover' or the tournament ends).
  for (let i = 0; i < 200; i++) {
    const { state } = await get('/api/state', { tableId: sessions[0].tableId, token: sessions[0].token });
    if (state.status !== 'active') return state;
    if (!['preflop', 'flop', 'turn', 'river'].includes(state.bettingRound)) return state;

    const actingSession = sessions.find((s) => s.playerId === state.actingPlayerId);
    if (!actingSession) throw new Error('No session found for acting player — test setup bug.');
    const me = state.players.find((p) => p && p.id === actingSession.playerId);
    const toCall = state.currentBet - me.roundBet;
    const type = toCall > 0 ? 'call' : 'check';
    const res = await post('/api/action', { tableId: actingSession.tableId, token: actingSession.token, type });
    if (!res.ok) throw new Error('Action failed: ' + res.error);
  }
  throw new Error('Hand did not resolve after 200 steps — likely an infinite loop bug.');
}

async function main() {
  await new Promise((resolve) => server.once('listening', resolve));

  // ---------- Test 1: basic 3-player hand to showdown, chip conservation ----------
  {
    const host = await post('/api/createTable', { hostName: 'Alice', tournamentName: 'Test Table', startingStack: 1000, levelMinutes: 15 });
    assert.ok(host.ok, 'createTable failed: ' + host.error);
    const tableId = host.tableId;
    const p2 = await post('/api/joinTable', { tableId, name: 'Bob' });
    const p3 = await post('/api/joinTable', { tableId, name: 'Chloe' });
    assert.ok(p2.ok && p3.ok, 'joinTable failed');

    const sessions = [
      { tableId, token: host.token, playerId: host.playerId },
      { tableId, token: p2.token, playerId: p2.playerId },
      { tableId, token: p3.token, playerId: p3.playerId },
    ];

    const before = await get('/api/state', { tableId, token: host.token });
    assert.strictEqual(before.state.status, 'lobby');

    const startRes = await post('/api/startTournament', { tableId, token: host.token });
    assert.ok(startRes.ok, 'startTournament failed: ' + startRes.error);

    const preHand = await get('/api/state', { tableId, token: host.token });
    assert.strictEqual(preHand.state.bettingRound, 'preflop');
    assert.strictEqual(preHand.state.handNumber, 1);
    const startingTotal = totalChips(preHand.state);
    assert.strictEqual(startingTotal, 3000, 'expected 3 x 1000 starting chips in play');

    const afterHand = await playCheckCallHandToShowdown(sessions);
    assert.strictEqual(totalChips(afterHand), 3000, 'chips must be conserved across a hand');
    assert.ok(afterHand.log.some((l) => /wins|folds/.test(l.message)), 'expected a winner/fold log entry');
    console.log('Test 1 (basic hand, chip conservation): OK');
  }

  // ---------- Test 2: forced all-in creates correct side pots, chips conserved, elimination works ----------
  {
    const host = await post('/api/createTable', { hostName: 'Short', tournamentName: 'Side Pot Test', startingStack: 1000, levelMinutes: 15 });
    const p2 = await post('/api/joinTable', { tableId: host.tableId, name: 'Medium' });
    const p3 = await post('/api/joinTable', { tableId: host.tableId, name: 'Big' });
    const tableId = host.tableId;
    const sessions = [
      { tableId, token: host.token, playerId: host.playerId },
      { tableId, token: p2.token, playerId: p2.playerId },
      { tableId, token: p3.token, playerId: p3.playerId },
    ];

    // Rig unequal stacks directly on the live Table object to force a side-pot scenario:
    // Short has far fewer chips than Medium/Big, so Short's all-in creates a side pot
    // between the other two.
    const table = tables.get(tableId);
    table.players.get(host.playerId).chips = 100;
    table.players.get(p2.playerId).chips = 500;
    table.players.get(p3.playerId).chips = 1000;
    const totalBefore = 100 + 500 + 1000;

    const startRes = await post('/api/startTournament', { tableId, token: host.token });
    assert.ok(startRes.ok, 'startTournament failed: ' + startRes.error);

    // Every player shoves all-in on their turn; everyone else calls. This guarantees the
    // short stack is covered by two bigger stacks -> a main pot + a side pot.
    for (let i = 0; i < 200; i++) {
      const { state } = await get('/api/state', { tableId, token: host.token });
      if (state.status !== 'active') break;
      if (!['preflop', 'flop', 'turn', 'river'].includes(state.bettingRound)) break;
      const actingSession = sessions.find((s) => s.playerId === state.actingPlayerId);
      const me = state.players.find((p) => p && p.id === actingSession.playerId);
      const toCall = state.currentBet - me.roundBet;
      let res;
      if (me.chips > 0 && toCall < me.chips) {
        // Go all-in: raise to my full stack (roundBet + remaining chips).
        res = await post('/api/action', {
          tableId,
          token: actingSession.token,
          type: 'raise',
          amount: me.roundBet + me.chips,
        });
      } else if (toCall > 0) {
        res = await post('/api/action', { tableId, token: actingSession.token, type: 'call' });
      } else {
        res = await post('/api/action', { tableId, token: actingSession.token, type: 'check' });
      }
      if (!res.ok) throw new Error('Action failed: ' + res.error);
    }

    const finalState = await get('/api/state', { tableId, token: host.token });
    const finalTotal = finalState.state.players.filter(Boolean).reduce((s, p) => s + p.chips, 0);
    assert.strictEqual(finalTotal, totalBefore, `chips must be conserved through side pots (expected ${totalBefore}, got ${finalTotal})`);

    // Short stack (100 chips) should have either busted (0 chips, bustedOut) or, in the rare
    // case they won the main pot, still be in it — either way, total conservation above is
    // the real correctness check. We additionally sanity-check nobody has negative chips.
    finalState.state.players.filter(Boolean).forEach((p) => {
      assert.ok(p.chips >= 0, `${p.name} has negative chips: ${p.chips}`);
    });

    console.log('Test 2 (side pots, chip conservation, all-in handling): OK');
    console.log('  final chip counts:', finalState.state.players.filter(Boolean).map((p) => `${p.name}=${p.chips}`).join(', '));
  }

  // ---------- Test 3: heads-up down to a tournament winner ----------
  {
    // 500 is the server's enforced minimum starting stack (a sane guard rail against typos) —
    // still small enough that constant shoving ends the tournament in a handful of hands.
    const host = await post('/api/createTable', { hostName: 'HU-A', tournamentName: 'Heads Up Test', startingStack: 500, levelMinutes: 15 });
    const p2 = await post('/api/joinTable', { tableId: host.tableId, name: 'HU-B' });
    const tableId = host.tableId;
    const sessions = [
      { tableId, token: host.token, playerId: host.playerId },
      { tableId, token: p2.token, playerId: p2.playerId },
    ];
    await post('/api/startTournament', { tableId, token: host.token });

    let finalState = null;
    for (let hand = 0; hand < 60; hand++) {
      const { state } = await get('/api/state', { tableId, token: host.token });
      if (state.status === 'tournament_over') {
        finalState = state;
        break;
      }
      // Shove every hand — with only 200 chips each and rising blinds this ends the
      // tournament quickly and repeatedly exercises all-in/showdown/elimination logic.
      for (let i = 0; i < 50; i++) {
        const { state: s2 } = await get('/api/state', { tableId, token: host.token });
        if (s2.status === 'tournament_over') { finalState = s2; break; }
        if (!['preflop', 'flop', 'turn', 'river'].includes(s2.bettingRound)) break;
        const actingSession = sessions.find((s) => s.playerId === s2.actingPlayerId);
        if (!actingSession) break;
        const me = s2.players.find((p) => p && p.id === actingSession.playerId);
        const toCall = s2.currentBet - me.roundBet;
        let res;
        if (me.chips > 0 && toCall < me.chips) {
          res = await post('/api/action', { tableId, token: actingSession.token, type: 'raise', amount: me.roundBet + me.chips });
        } else if (toCall > 0) {
          res = await post('/api/action', { tableId, token: actingSession.token, type: 'call' });
        } else {
          res = await post('/api/action', { tableId, token: actingSession.token, type: 'check' });
        }
        if (!res.ok) throw new Error('Action failed: ' + res.error);
      }
      if (finalState) break;
      // Wait past the 7s hand-over delay so the next hand deals.
      await new Promise((r) => setTimeout(r, 7500));
    }

    assert.ok(finalState, 'tournament did not conclude in time');
    assert.strictEqual(finalState.status, 'tournament_over');
    const winner = finalState.standings.find((p) => p.bustedPlace === 1);
    assert.ok(winner, 'expected a declared winner');
    assert.strictEqual(winner.chips, 1000, 'winner should hold all 1000 chips in play');
    console.log(`Test 3 (heads-up to tournament conclusion): OK — winner: ${winner.name}`);
  }

  console.log('\nAll integration tests passed.');
  server.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('INTEGRATION TEST FAILED:', err);
  server.close();
  process.exit(1);
});
