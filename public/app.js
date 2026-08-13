(() => {
  'use strict';

  const SUIT_SYMBOL = { h: '♥', d: '♦', c: '♣', s: '♠' };
  const RED_SUITS = new Set(['h', 'd']);
  const STORAGE_KEY = 'cousinsPokerSession';
  const POLL_MS = 1000;
  const ACTION_TIMEOUT_MS = 60000;

  // ---------- session persistence ----------

  function loadSession() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY));
    } catch (e) {
      return null;
    }
  }
  function saveSession(s) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
  }
  function clearSession() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
  }

  let session = loadSession(); // { tableId, token, playerId }
  let state = null;
  let pollTimer = null;
  let raisePanelOpen = false;

  // Queued pre-action ('fold' | 'checkfold' | 'callany'), armed while it's someone else's turn.
  let preAction = null;
  let preActionHand = null; // the hand it was armed on, so it clears when a new hand starts

  // Tracked so we can tell what *changed* between polls and react (sounds, animations).
  const prev = {
    handNumber: null,
    communityCount: 0,
    bettingRound: null,
    logLength: 0,
    wasMyTurn: false,
    potAmount: 0,
    blindLevel: null,
    status: null,
  };

  // ---------- API ----------

  async function apiPost(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Request failed.');
    return data;
  }

  async function apiGet(path, params) {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${path}?${qs}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Request failed.');
    return data;
  }

  // ---------- UI helpers ----------

  let toastTimer = null;
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
  }

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : str;
    return div.innerHTML;
  }

  function ordinal(n) {
    if (!n) return '';
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function fmtClock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function fmtChips(n) {
    return (n || 0).toLocaleString();
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  // ---------- cards ----------

  function cardEl(code, index) {
    const div = document.createElement('div');
    div.className = 'card';
    if (index != null) div.style.animationDelay = `${index * 0.07}s`;

    if (code === 'back') {
      div.classList.add('back');
    } else if (!code) {
      div.classList.add('placeholder');
    } else {
      const rank = code[0] === 'T' ? '10' : code[0];
      const suit = code[1];
      const sym = SUIT_SYMBOL[suit] || '';
      if (RED_SUITS.has(suit)) div.classList.add('red');
      div.innerHTML = `<span class="rank">${rank}</span><span class="suit-sm">${sym}</span><span class="suit-lg">${sym}</span>`;
    }
    return div;
  }

  // ---------- polling ----------

  function startPolling() {
    stopPolling();
    fetchState();
    pollTimer = setInterval(fetchState, POLL_MS);
  }
  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  async function fetchState() {
    if (!session) return;
    try {
      const res = await apiGet('/api/state', { tableId: session.tableId, token: session.token });
      state = res.state;
      render(state);
    } catch (err) {
      stopPolling();
      clearSession();
      session = null;
      const el = document.getElementById('home-error');
      el.textContent = err.message;
      el.classList.remove('hidden');
      showScreen('screen-home');
    }
  }

  // ---------- reactions: sounds + banners driven by state deltas ----------

  function reactToChanges(s) {
    const me = s.players.find((p) => p && p.isMe);
    const isMyTurn = me && s.actingPlayerId === me.id;
    const communityCount = (s.communityCards || []).length;

    // New hand dealt
    if (prev.handNumber !== null && s.handNumber !== prev.handNumber) {
      Sounds.cardDeal();
      setTimeout(() => Sounds.cardDeal(), 130);
    }

    // New community cards appeared
    if (communityCount > prev.communityCount && prev.handNumber !== null) {
      const added = communityCount - prev.communityCount;
      for (let i = 0; i < added; i++) setTimeout(() => Sounds.cardFlip(), i * 150);

      const label = communityCount === 3 ? 'FLOP' : communityCount === 4 ? 'TURN' : communityCount === 5 ? 'RIVER' : null;
      if (label) showStreetBanner(label);
    }

    // Read the tail of the log for action sounds (the log is the server's source of truth
    // for what just happened, so we don't have to duplicate that logic client-side).
    if (prev.logLength && s.log.length > prev.logLength) {
      const fresh = s.log.slice(prev.logLength);
      for (const entry of fresh) {
        const m = entry.message;
        if (/all-in|moves all-in/i.test(m)) Sounds.allIn();
        else if (/raises to|bets/i.test(m)) Sounds.chips();
        else if (/calls/i.test(m)) Sounds.chips();
        else if (/checks/i.test(m)) Sounds.check();
        else if (/folds/i.test(m)) Sounds.fold();
        else if (/is eliminated/i.test(m)) Sounds.elimination();
        else if (/wins? \d/i.test(m)) {
          const iWon = me && m.startsWith(me.name);
          if (iWon) Sounds.win();
          else Sounds.potAwarded();
        }
      }
    }

    // Blinds went up
    if (prev.blindLevel !== null && s.blindLevel.level !== prev.blindLevel) {
      Sounds.blindsUp();
      toast(`Blinds up: ${s.blindLevel.smallBlind}/${s.blindLevel.bigBlind}`);
    }

    // Your turn just started
    if (isMyTurn && !prev.wasMyTurn) Sounds.yourTurn();

    // Pot grew
    if (s.pots[0] && s.pots[0].amount > prev.potAmount) {
      const potEl = document.querySelector('.pot-display');
      if (potEl) {
        potEl.classList.remove('bumped');
        void potEl.offsetWidth; // restart the animation
        potEl.classList.add('bumped');
      }
    }

    prev.handNumber = s.handNumber;
    prev.communityCount = communityCount;
    prev.bettingRound = s.bettingRound;
    prev.logLength = s.log.length;
    prev.wasMyTurn = isMyTurn;
    prev.potAmount = (s.pots[0] && s.pots[0].amount) || 0;
    prev.blindLevel = s.blindLevel.level;
    prev.status = s.status;
  }

  let bannerTimer = null;
  function showStreetBanner(text) {
    const el = document.getElementById('street-banner');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('hidden');
    void el.offsetWidth;
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => el.classList.add('hidden'), 1500);
  }

  // ---------- render: lobby ----------

  function renderLobby(s) {
    showScreen('screen-lobby');
    document.getElementById('lobby-title').textContent = s.tournamentName;
    document.getElementById('lobby-code').textContent = s.tableId;

    const list = document.getElementById('lobby-players');
    const players = s.players.filter(Boolean);
    list.innerHTML = '';
    players.forEach((p) => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${escapeHtml(p.name)}${p.isMe ? '<span class="you-tag">YOU</span>' : ''}</span><span class="chips-val">${fmtChips(p.chips)}</span>`;
      list.appendChild(li);
    });

    const isHost = s.hostPlayerId === session.playerId;
    document.getElementById('lobby-host-controls').classList.toggle('hidden', !isHost);
    document.getElementById('lobby-waiting').classList.toggle('hidden', isHost);
    document.getElementById('btn-start-tournament').disabled = players.length < 2;
  }

  // ---------- render: game ----------

  function renderGame(s) {
    showScreen('screen-game');

    document.getElementById('blind-level').textContent = s.blindLevel.level;
    document.getElementById('blind-amounts').textContent =
      `${s.blindLevel.smallBlind}/${s.blindLevel.bigBlind}` + (s.blindLevel.ante ? ` +${s.blindLevel.ante}` : '');
    const timerEl = document.getElementById('blind-timer');
    timerEl.textContent = fmtClock(s.blindLevel.timeRemainingMs);
    timerEl.parentElement.classList.toggle('urgent', s.blindLevel.timeRemainingMs < 60000);

    document.getElementById('pot-amount').textContent = fmtChips(s.pots[0] ? s.pots[0].amount : 0);

    // Cards that made the winning hand — highlighted once the hand is over.
    const winningCards = new Set();
    if (s.showdownResults && s.bettingRound === 'handover') {
      s.showdownResults.forEach((r) => (r.winningCards || []).forEach((c) => winningCards.add(c)));
    }

    const community = document.getElementById('community-cards');
    const cc = s.communityCards || [];
    const commSig = `${cc.length}|${[...winningCards].sort().join(',')}`;
    // Only rebuild when something changes, so existing cards don't re-animate every poll.
    if (community.dataset.sig !== commSig) {
      community.dataset.sig = commSig;
      community.innerHTML = '';
      for (let i = 0; i < 5; i++) {
        const el = cardEl(cc[i] || null, i < cc.length ? i : null);
        if (cc[i] && winningCards.has(cc[i])) el.classList.add('winning');
        community.appendChild(el);
      }
    }
    renderGame.winningCards = winningCards;

    renderSeats(s);
    renderActionBar(s);
    renderPreActions(s);
    renderHandStrength(s);
    renderShowdownBanner(s);
    renderLog(s);
    renderStandings(s);
  }

  function renderHandStrength(s) {
    const el = document.getElementById('hand-strength');
    const me = s.players.find((p) => p && p.isMe);
    const show = s.myHand && me && !me.folded && !me.bustedOut && s.bettingRound && s.bettingRound !== 'handover';
    el.classList.toggle('hidden', !show);
    if (show) el.textContent = s.myHand;
  }

  function renderShowdownBanner(s) {
    const el = document.getElementById('showdown-banner');
    const results = s.showdownResults;
    if (!results || !results.length || s.bettingRound !== 'handover') {
      el.classList.add('hidden');
      return;
    }
    const main = results[0];
    const names = (main.winnerNames || []).join(' & ');
    const text = `${names} — ${main.handName}`;
    if (el.dataset.txt !== text) {
      el.dataset.txt = text;
      el.textContent = text;
    }
    el.classList.remove('hidden');
  }

  // Pre-actions: arm a move while another player is thinking, then it fires the moment
  // the action reaches you — the out-of-turn checkboxes every online client has.
  function renderPreActions(s) {
    const bar = document.getElementById('preaction-bar');
    const me = s.players.find((p) => p && p.isMe);
    const inHand = me && !me.folded && !me.bustedOut && !me.allIn;
    const bettingLive = ['preflop', 'flop', 'turn', 'river'].includes(s.bettingRound) && !s.dealingRunout;
    const isMyTurn = me && s.actingPlayerId === me.id;

    // Clear a stale pre-action when a new hand starts.
    if (preActionHand !== null && preActionHand !== s.handNumber) {
      preAction = null;
      preActionHand = null;
    }

    const show = inHand && bettingLive && !isMyTurn;
    bar.classList.toggle('hidden', !show);
    if (!show) return;

    bar.querySelectorAll('.preaction').forEach((btn) => {
      btn.classList.toggle('armed', preAction === btn.dataset.pre);
    });
  }

  // Fire a queued pre-action as soon as it's our turn.
  function maybeFirePreAction(s, me) {
    if (!preAction) return false;
    const toCall = s.currentBet - me.roundBet;
    let type = null;
    if (preAction === 'fold') type = 'fold';
    else if (preAction === 'checkfold') type = toCall > 0 ? 'fold' : 'check';
    else if (preAction === 'callany') type = toCall > 0 ? 'call' : 'check';
    preAction = null;
    preActionHand = null;
    if (type) {
      sendAction(type);
      return true;
    }
    return false;
  }

  // Deterministic avatar colour per player, so everyone sees the same person in the same colour.
  const AVATAR_COLORS = [
    'linear-gradient(160deg,#e2483f,#9b241d)',
    'linear-gradient(160deg,#3b82c4,#1d4f80)',
    'linear-gradient(160deg,#2fbf71,#157a45)',
    'linear-gradient(160deg,#a56ad4,#5f3187)',
    'linear-gradient(160deg,#f0a04b,#b4661d)',
    'linear-gradient(160deg,#31b6bd,#146a70)',
    'linear-gradient(160deg,#d95c9c,#8e2a5f)',
    'linear-gradient(160deg,#7f8c9b,#48525d)',
    'linear-gradient(160deg,#c9b037,#8a7420)',
  ];
  function avatarStyle(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  }
  function initials(name) {
    const parts = String(name).trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  // Chip colour by bet size, the way physical denominations work.
  function chipColor(amount) {
    if (amount >= 5000) return '#c9a227';
    if (amount >= 1000) return '#8e44ad';
    if (amount >= 500) return '#2c3e50';
    if (amount >= 100) return '#27ae60';
    if (amount >= 25) return '#2980b9';
    return '#e2483f';
  }

  function renderSeats(s) {
    const table = document.getElementById('poker-table');
    const occupied = s.players.filter(Boolean);
    if (occupied.length === 0) return;

    // Rotate so the local player always sits at the bottom of the table.
    let myIndex = occupied.findIndex((p) => p.isMe);
    if (myIndex === -1) myIndex = 0;
    const ordered = occupied.slice(myIndex).concat(occupied.slice(0, myIndex));

    const n = ordered.length;
    const cx = 50, cy = 50;
    const rx = 40, ry = 39;      // seat ring
    const bx = 30, by = 27;      // bet-chip ring, just inside each player toward the pot
    const winnerIds = new Set();
    if (s.showdownResults) s.showdownResults.forEach((r) => (r.winnerIds || []).forEach((id) => winnerIds.add(id)));
    const winningCards = renderGame.winningCards || new Set();

    ordered.forEach((p, i) => {
      const theta = Math.PI / 2 + (i * (2 * Math.PI)) / n;
      const x = cx + rx * Math.cos(theta);
      const y = cy + ry * Math.sin(theta);

      let seat = table.querySelector(`.seat[data-pid="${p.id}"]`);
      if (!seat) {
        seat = document.createElement('div');
        seat.className = 'seat';
        seat.dataset.pid = p.id;
        table.appendChild(seat);
      }
      seat.style.left = `${x}%`;
      seat.style.top = `${y}%`;
      seat.classList.toggle('hero', !!p.isMe);
      seat.classList.toggle('acting', p.id === s.actingPlayerId);
      seat.classList.toggle('folded', !!p.folded && !p.bustedOut);
      seat.classList.toggle('busted', !!p.bustedOut);
      seat.classList.toggle('winner', winnerIds.has(p.id));

      const badges = [];
      if (p.seat === s.dealerSeat) badges.push({ t: 'D', c: 'd' });
      else if (p.seat === s.smallBlindSeat) badges.push({ t: 'SB', c: 'sb' });
      else if (p.seat === s.bigBlindSeat) badges.push({ t: 'BB', c: 'bb' });

      // Rebuild only when something visible actually changed, so card deal animations
      // aren't restarted on every poll.
      const signature = [
        p.chips, p.folded, p.allIn, p.bustedOut, p.bustedPlace, p.connected,
        p.lastAction, (p.holeCards || []).join(','), badges.map((b) => b.t).join(''),
        p.id === s.actingPlayerId, winnerIds.has(p.id),
        (p.holeCards || []).filter((c) => winningCards.has(c)).join(','),
      ].join('|');

      if (seat.dataset.sig !== signature) {
        seat.dataset.sig = signature;

        const actionLabel = p.bustedOut
          ? ''
          : p.folded
            ? 'Fold'
            : p.allIn
              ? 'All In'
              : (p.lastAction || '');
        const labelClass = p.allIn && !p.folded
          ? 'allin'
          : p.folded
            ? 'fold'
            : /raise|bet/i.test(actionLabel)
              ? 'aggressive'
              : '';

        seat.innerHTML = `
          <div class="seat-cards"></div>
          <div class="pod">
            <div class="avatar" style="background:${avatarStyle(p.id)}">
              ${escapeHtml(initials(p.name))}
              <span class="status-dot ${p.connected ? 'online' : 'away'}"></span>
            </div>
            <div class="pod-info">
              <div class="pod-name">${escapeHtml(p.name)}${p.isMe ? ' (you)' : ''}</div>
              <div class="pod-stack ${p.bustedOut ? 'out' : ''}">${p.bustedOut ? `Out · ${ordinal(p.bustedPlace)}` : fmtChips(p.chips)}</div>
            </div>
            ${p.id === s.actingPlayerId ? '<div class="pod-timer"><div class="pod-timer-fill"></div></div>' : ''}
          </div>
          ${badges.length ? `<div class="seat-badge ${badges[0].c}">${badges[0].t}</div>` : ''}
          ${actionLabel ? `<div class="action-label ${labelClass}">${escapeHtml(actionLabel)}</div>` : ''}
        `;

        const cardsWrap = seat.querySelector('.seat-cards');
        (p.holeCards || []).forEach((c, ci) => {
          const el = cardEl(c, ci);
          if (c && winningCards.has(c)) el.classList.add('winning');
          cardsWrap.appendChild(el);
        });
      }

      // Live turn timer (updated every poll without rebuilding the pod).
      if (p.id === s.actingPlayerId && s.actionDeadlineMs != null) {
        const fill = seat.querySelector('.pod-timer-fill');
        if (fill) {
          const pct = clamp((s.actionDeadlineMs / ACTION_TIMEOUT_MS) * 100, 0, 100);
          fill.style.width = `${pct}%`;
          fill.classList.toggle('low', pct < 25);
        }
      }

      // Bet chips sitting on the felt between the player and the pot. Once the hand is
      // over they've been swept into the pot, so they come off the felt.
      const betId = `bet-${p.id}`;
      let betEl = table.querySelector(`.bet-stack[data-pid="${p.id}"]`);
      if (p.roundBet > 0 && s.bettingRound !== 'handover') {
        const bxp = cx + bx * Math.cos(theta);
        const byp = cy + by * Math.sin(theta);
        if (!betEl) {
          betEl = document.createElement('div');
          betEl.className = 'bet-stack';
          betEl.dataset.pid = p.id;
          betEl.id = betId;
          table.appendChild(betEl);
        }
        betEl.style.left = `${bxp}%`;
        betEl.style.top = `${byp}%`;
        if (betEl.dataset.amt !== String(p.roundBet)) {
          betEl.dataset.amt = String(p.roundBet);
          const col = chipColor(p.roundBet);
          const stackCount = Math.min(4, 1 + Math.floor(Math.log10(Math.max(1, p.roundBet)) ));
          let chips = '';
          for (let c = 0; c < stackCount; c++) {
            chips += `<span class="chip" style="--chip-c:${col}; bottom:${c * 3}px"></span>`;
          }
          betEl.innerHTML = `<span class="chip-stack">${chips}</span><span class="bet-amount">${fmtChips(p.roundBet)}</span>`;
        }
      } else if (betEl) {
        betEl.remove();
      }
    });

    // Clean up seats/bets for players no longer at the table.
    table.querySelectorAll('.seat').forEach((el) => {
      if (!occupied.some((p) => p.id === el.dataset.pid)) el.remove();
    });
    table.querySelectorAll('.bet-stack').forEach((el) => {
      if (!occupied.some((p) => p.id === el.dataset.pid)) el.remove();
    });
  }

  function renderActionBar(s) {
    const me = s.players.find((p) => p && p.isMe);
    const bar = document.getElementById('action-bar');
    const isMyTurn = me && s.actingPlayerId === me.id && ['preflop', 'flop', 'turn', 'river'].includes(s.bettingRound);

    // The table makes room for the floating action panel while you're on the clock.
    document.getElementById('screen-game').classList.toggle('acting', !!isMyTurn);

    if (!isMyTurn) {
      bar.classList.add('hidden');
      raisePanelOpen = false;
      document.getElementById('raise-controls').classList.add('hidden');
      return;
    }

    // If a pre-action was armed, play it immediately instead of showing the panel.
    if (maybeFirePreAction(s, me)) {
      bar.classList.add('hidden');
      return;
    }

    bar.classList.remove('hidden');

    const tbBtn = document.getElementById('btn-timebank');
    tbBtn.classList.toggle('hidden', !s.canUseTimeBank);

    // Turn countdown bar along the top of the action bar.
    if (s.actionDeadlineMs != null) {
      const fill = document.getElementById('action-timer-fill');
      const pct = clamp((s.actionDeadlineMs / ACTION_TIMEOUT_MS) * 100, 0, 100);
      fill.style.width = `${pct}%`;
      fill.classList.toggle('low', pct < 25);
    }

    const toCall = s.currentBet - me.roundBet;
    const minTotal = Math.min(me.chips + me.roundBet, s.currentBet + s.minRaiseAmount);
    const maxTotal = me.chips + me.roundBet;
    const canRaise = maxTotal > s.currentBet && me.chips > 0;

    // Rebuild buttons only when the available actions actually change.
    const btnSig = [toCall, minTotal, maxTotal, canRaise, raisePanelOpen].join('|');
    const buttons = document.getElementById('action-buttons');
    if (buttons.dataset.sig !== btnSig) {
      buttons.dataset.sig = btnSig;
      buttons.innerHTML = '';

      if (raisePanelOpen) {
        buttons.appendChild(makeBtn('Cancel', 'fold', () => {
          raisePanelOpen = false;
          document.getElementById('raise-controls').classList.add('hidden');
          buttons.dataset.sig = '';
          renderActionBar(s);
        }));
        buttons.appendChild(makeBtn('Confirm raise', 'confirm', () => {
          const amount = clamp(parseInt(document.getElementById('raise-amount').value, 10) || minTotal, minTotal, maxTotal);
          sendAction('raise', amount);
        }));
      } else {
        buttons.appendChild(makeBtn('Fold', 'fold', () => sendAction('fold')));
        if (toCall <= 0) {
          buttons.appendChild(makeBtn('Check', 'check', () => sendAction('check')));
        } else {
          const callAmt = Math.min(toCall, me.chips);
          buttons.appendChild(makeBtn(`Call ${fmtChips(callAmt)}`, 'call', () => sendAction('call')));
        }
        if (canRaise) {
          const label = s.currentBet > 0 ? 'Raise' : 'Bet';
          buttons.appendChild(makeBtn(label, 'raise', () => openRaisePanel(s, me, minTotal, maxTotal)));
        }
      }
    }
  }

  function makeBtn(label, cls, onClick) {
    const btn = document.createElement('button');
    btn.className = `btn ${cls}`;
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  // Raise panel state, kept outside render so the slider isn't reset on every poll.
  let raiseCtx = { min: 0, max: 0, pot: 0, currentBet: 0, step: 1 };

  function openRaisePanel(s, me, minTotal, maxTotal) {
    raisePanelOpen = true;
    const potTotal = (s.pots[0] && s.pots[0].amount) || 0;
    raiseCtx = {
      min: minTotal,
      max: maxTotal,
      pot: potTotal,
      currentBet: s.currentBet,
      // Step in big blinds so the slider and wheel move in sensible poker increments.
      step: Math.max(1, Math.round(s.blindLevel.bigBlind / 2)),
    };

    const panel = document.getElementById('raise-controls');
    panel.classList.remove('hidden');

    const slider = document.getElementById('raise-slider');
    slider.min = minTotal;
    slider.max = maxTotal;
    slider.step = 1;

    setRaiseValue(minTotal);
    document.getElementById('action-buttons').dataset.sig = '';
    renderActionBar(s);
  }

  function setRaiseValue(v) {
    const val = clamp(Math.round(v), raiseCtx.min, raiseCtx.max);
    const slider = document.getElementById('raise-slider');
    const input = document.getElementById('raise-amount');
    slider.value = val;
    input.value = val;
    const pct = raiseCtx.max > raiseCtx.min ? ((val - raiseCtx.min) / (raiseCtx.max - raiseCtx.min)) * 100 : 0;
    slider.style.setProperty('--fill', `${pct}%`);
  }

  function currentRaiseValue() {
    return parseInt(document.getElementById('raise-amount').value, 10) || raiseCtx.min;
  }

  async function sendAction(type, amount) {
    raisePanelOpen = false;
    document.getElementById('raise-controls').classList.add('hidden');
    document.getElementById('action-bar').classList.add('hidden');
    document.getElementById('action-buttons').dataset.sig = '';
    try {
      await apiPost('/api/action', { tableId: session.tableId, token: session.token, type, amount });
      fetchState();
    } catch (err) {
      toast(err.message);
      fetchState();
    }
  }

  function renderLog(s) {
    const list = document.getElementById('log-list');
    if (list.dataset.len === String(s.log.length)) return;
    list.dataset.len = String(s.log.length);

    const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 30;
    list.innerHTML = '';
    (s.log || []).forEach((entry) => {
      const li = document.createElement('li');
      li.textContent = entry.message;
      if (/wins?|eliminated|All-in/i.test(entry.message)) li.classList.add('highlight');
      list.appendChild(li);
    });
    if (atBottom) list.scrollTop = list.scrollHeight;
  }

  function renderStandings(s) {
    const list = document.getElementById('standings-list');
    const sig = s.standings.map((p) => `${p.id}:${p.chips}:${p.bustedPlace}`).join('|');
    if (list.dataset.sig === sig) return;
    list.dataset.sig = sig;

    list.innerHTML = '';
    s.standings.forEach((p) => {
      const li = document.createElement('li');
      if (p.bustedPlace) li.classList.add('out');
      li.innerHTML = `<span class="nm">${escapeHtml(p.name)}</span><span class="ch">${p.bustedPlace ? ordinal(p.bustedPlace) : fmtChips(p.chips)}</span>`;
      list.appendChild(li);
    });
  }

  function renderOver(s) {
    showScreen('screen-over');
    if (prev.status !== 'tournament_over') Sounds.victory();

    const winner = s.standings.find((p) => p.bustedPlace === 1);
    document.getElementById('over-winner-name').textContent = winner ? `${winner.name} wins!` : 'Tournament over';
    document.getElementById('over-winner').textContent = winner
      ? `Took it down with ${fmtChips(winner.chips)} chips.`
      : '';

    const list = document.getElementById('over-standings');
    list.innerHTML = '';
    s.standings.forEach((p) => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${escapeHtml(p.name)}</span><span class="chips-val">${ordinal(p.bustedPlace)}</span>`;
      list.appendChild(li);
    });
    prev.status = s.status;
    stopPolling();
  }

  function render(s) {
    if (s.status === 'lobby') {
      renderLobby(s);
      prev.status = s.status;
      return;
    }
    if (s.status === 'tournament_over') {
      reactToChanges(s);
      renderOver(s);
      return;
    }
    renderGame(s);
    reactToChanges(s);
  }

  // ---------- wiring ----------

  function initHomeScreen() {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
        document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
        document.getElementById(`form-${btn.dataset.tab}`).classList.add('active');
      });
    });

    const joinCode = new URLSearchParams(location.search).get('join');
    if (joinCode) {
      document.getElementById('join-code').value = joinCode.toUpperCase();
      document.querySelector('.tab-btn[data-tab="join"]').click();
      setTimeout(() => document.getElementById('join-name').focus(), 200);
    }

    document.getElementById('form-join').addEventListener('submit', async (e) => {
      e.preventDefault();
      Sounds.unlock();
      const tableId = document.getElementById('join-code').value.trim().toUpperCase();
      const name = document.getElementById('join-name').value.trim();
      if (!tableId || !name) return toast('Enter a table code and your name.');
      try {
        const res = await apiPost('/api/joinTable', { tableId, name });
        session = { tableId: res.tableId, token: res.token, playerId: res.playerId };
        saveSession(session);
        startPolling();
      } catch (err) {
        showHomeError(err.message);
      }
    });

    document.getElementById('form-create').addEventListener('submit', async (e) => {
      e.preventDefault();
      Sounds.unlock();
      const hostName = document.getElementById('create-hostname').value.trim();
      if (!hostName) return toast('Enter your name.');
      try {
        const res = await apiPost('/api/createTable', {
          hostName,
          tournamentName: document.getElementById('create-tname').value.trim(),
          startingStack: document.getElementById('create-stack').value,
          levelMinutes: document.getElementById('create-level').value,
        });
        session = { tableId: res.tableId, token: res.token, playerId: res.playerId };
        saveSession(session);
        startPolling();
      } catch (err) {
        showHomeError(err.message);
      }
    });
  }

  function showHomeError(msg) {
    const el = document.getElementById('home-error');
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  function initLobbyScreen() {
    document.getElementById('btn-start-tournament').addEventListener('click', async () => {
      Sounds.unlock();
      try {
        await apiPost('/api/startTournament', { tableId: session.tableId, token: session.token });
        fetchState();
      } catch (err) {
        toast(err.message);
      }
    });

    document.getElementById('btn-copy-link').addEventListener('click', async () => {
      const link = `${location.origin}/?join=${session.tableId}`;
      try {
        await navigator.clipboard.writeText(link);
        toast('Invite link copied!');
      } catch (e) {
        toast(link);
      }
    });
  }

  function initGameScreen() {
    const logPanel = document.getElementById('log-panel');
    const standingsPanel = document.getElementById('standings-panel');

    document.getElementById('btn-toggle-log').addEventListener('click', () => {
      logPanel.classList.toggle('hidden');
      standingsPanel.classList.add('hidden');
    });
    document.getElementById('btn-close-log').addEventListener('click', () => logPanel.classList.add('hidden'));
    document.getElementById('btn-standings').addEventListener('click', () => {
      standingsPanel.classList.toggle('hidden');
      logPanel.classList.add('hidden');
    });
    document.getElementById('btn-close-standings').addEventListener('click', () => standingsPanel.classList.add('hidden'));

    // Sound toggle (also starts/stops the ambient bed).
    const soundBtn = document.getElementById('btn-sound');
    function syncSoundBtn() {
      const on = Sounds.isEnabled();
      soundBtn.textContent = on ? '🔊' : '🔇';
      soundBtn.classList.toggle('off', !on);
    }
    syncSoundBtn();
    soundBtn.addEventListener('click', () => {
      Sounds.unlock();
      Sounds.toggle();
      syncSoundBtn();
      if (Sounds.isEnabled()) Sounds.yourTurn();
    });

    document.getElementById('form-chat').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('chat-input');
      const message = input.value.trim();
      if (!message) return;
      input.value = '';
      try {
        await apiPost('/api/chat', { tableId: session.tableId, token: session.token, message });
        fetchState();
      } catch (err) {
        toast(err.message);
      }
    });

    // Pre-action toggles (arm / disarm).
    document.querySelectorAll('.preaction').forEach((btn) => {
      btn.addEventListener('click', () => {
        const val = btn.dataset.pre;
        preAction = preAction === val ? null : val;
        preActionHand = preAction ? (state ? state.handNumber : null) : null;
        if (state) renderPreActions(state);
      });
    });

    document.getElementById('btn-timebank').addEventListener('click', async () => {
      try {
        await apiPost('/api/timeBank', { tableId: session.tableId, token: session.token });
        toast('+30 seconds');
        fetchState();
      } catch (err) {
        toast(err.message);
      }
    });

    initRaiseControls();
  }

  function initRaiseControls() {
    const slider = document.getElementById('raise-slider');
    const input = document.getElementById('raise-amount');
    const panel = document.getElementById('raise-controls');

    slider.addEventListener('input', () => setRaiseValue(parseInt(slider.value, 10)));
    input.addEventListener('input', () => {
      const v = parseInt(input.value, 10);
      if (!Number.isNaN(v)) setRaiseValue(v);
    });
    input.addEventListener('blur', () => setRaiseValue(currentRaiseValue()));

    document.getElementById('raise-minus').addEventListener('click', () => setRaiseValue(currentRaiseValue() - raiseCtx.step));
    document.getElementById('raise-plus').addEventListener('click', () => setRaiseValue(currentRaiseValue() + raiseCtx.step));

    // Scroll wheel anywhere over the raise panel nudges the amount — much faster than
    // dragging a slider mid-hand, which is what you asked for.
    panel.addEventListener('wheel', (e) => {
      if (panel.classList.contains('hidden')) return;
      e.preventDefault();
      const dir = e.deltaY > 0 ? -1 : 1;
      const mult = e.shiftKey ? 5 : 1; // hold shift for bigger jumps
      setRaiseValue(currentRaiseValue() + dir * raiseCtx.step * mult);
    }, { passive: false });

    panel.querySelectorAll('[data-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const { min, max, pot, currentBet } = raiseCtx;
        let target;
        if (btn.dataset.preset === 'min') target = min;
        else if (btn.dataset.preset === 'half') target = currentBet + Math.round(pot * 0.5);
        else if (btn.dataset.preset === 'twothirds') target = currentBet + Math.round(pot * 0.667);
        else if (btn.dataset.preset === 'pot') target = currentBet + pot;
        else target = max;
        setRaiseValue(target);
      });
    });

    // Keyboard shortcuts for the impatient: F fold, C check/call, R open raise, Enter confirm.
    document.addEventListener('keydown', (e) => {
      if (document.getElementById('action-bar').classList.contains('hidden')) return;
      if (e.target.tagName === 'INPUT') {
        if (e.key === 'Enter' && !panel.classList.contains('hidden')) {
          e.preventDefault();
          sendAction('raise', clamp(currentRaiseValue(), raiseCtx.min, raiseCtx.max));
        }
        return;
      }
      const key = e.key.toLowerCase();
      if (key === 'f') document.querySelector('#action-buttons .fold')?.click();
      else if (key === 'c') document.querySelector('#action-buttons .check, #action-buttons .call')?.click();
      else if (key === 'r') document.querySelector('#action-buttons .raise')?.click();
      else if (key === 'enter') document.querySelector('#action-buttons .confirm')?.click();
      else if (key === 'arrowup') { e.preventDefault(); setRaiseValue(currentRaiseValue() + raiseCtx.step); }
      else if (key === 'arrowdown') { e.preventDefault(); setRaiseValue(currentRaiseValue() - raiseCtx.step); }
    });
  }

  function init() {
    initHomeScreen();
    initLobbyScreen();
    initGameScreen();

    // Unlock audio on the first interaction anywhere (browser autoplay policy).
    const unlockOnce = () => {
      Sounds.unlock();
      document.removeEventListener('pointerdown', unlockOnce);
      document.removeEventListener('keydown', unlockOnce);
    };
    document.addEventListener('pointerdown', unlockOnce);
    document.addEventListener('keydown', unlockOnce);

    if (session && session.tableId && session.token) startPolling();
    else showScreen('screen-home');
  }

  document.addEventListener('DOMContentLoaded', init);
})();
