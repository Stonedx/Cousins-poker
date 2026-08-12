(() => {
  'use strict';

  const SUIT_SYMBOL = { h: '♥', d: '♦', c: '♣', s: '♠' };
  const RED_SUITS = new Set(['h', 'd']);
  const STORAGE_KEY = 'cousinsPokerSession';
  const POLL_MS = 1200;

  // ---------- session persistence ----------

  function loadSession() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY));
    } catch (e) {
      return null;
    }
  }
  function saveSession(s) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  }
  function clearSession() {
    localStorage.removeItem(STORAGE_KEY);
  }

  let session = loadSession(); // { tableId, token, playerId }
  let latestState = null;
  let pollTimer = null;
  let raisePanelOpen = false;

  // ---------- tiny API client ----------

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

  // ---------- toast ----------

  let toastTimer = null;
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
  }

  // ---------- screens ----------

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
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
      const { state } = await apiGet('/api/state', { tableId: session.tableId, token: session.token });
      latestState = state;
      render(state);
    } catch (err) {
      stopPolling();
      clearSession();
      session = null;
      document.getElementById('home-error').textContent = err.message;
      document.getElementById('home-error').classList.remove('hidden');
      showScreen('screen-home');
    }
  }

  // ---------- card rendering ----------

  function cardEl(code, sizeClass) {
    const div = document.createElement('div');
    div.className = 'card' + (sizeClass ? ' ' + sizeClass : '');
    if (code === 'back') {
      div.classList.add('back');
    } else if (!code) {
      div.classList.add('placeholder');
    } else {
      const rank = code[0] === 'T' ? '10' : code[0];
      const suit = code[1];
      if (RED_SUITS.has(suit)) div.classList.add('red');
      div.innerHTML = `${rank}<span>${SUIT_SYMBOL[suit] || ''}</span>`;
    }
    return div;
  }

  function fmtClock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // ---------- render: lobby ----------

  function renderLobby(state) {
    showScreen('screen-lobby');
    document.getElementById('lobby-title').textContent = state.tournamentName;
    document.getElementById('lobby-code').textContent = state.tableId;

    const list = document.getElementById('lobby-players');
    list.innerHTML = '';
    state.players.filter(Boolean).forEach((p) => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${escapeHtml(p.name)}${p.isMe ? '<span class="you-tag">YOU</span>' : ''}</span><span>${p.chips.toLocaleString()} chips</span>`;
      list.appendChild(li);
    });

    const isHost = state.hostPlayerId === session.playerId;
    document.getElementById('lobby-host-controls').classList.toggle('hidden', !isHost);
    document.getElementById('lobby-waiting').classList.toggle('hidden', isHost);
    const startBtn = document.getElementById('btn-start-tournament');
    startBtn.disabled = state.players.filter(Boolean).length < 2;
  }

  // ---------- render: game ----------

  function renderGame(state) {
    showScreen('screen-game');

    document.getElementById('blind-level').textContent = `Level ${state.blindLevel.level}`;
    document.getElementById('blind-amounts').textContent =
      `${state.blindLevel.smallBlind}/${state.blindLevel.bigBlind}` + (state.blindLevel.ante ? ` (ante ${state.blindLevel.ante})` : '');
    document.getElementById('blind-timer').textContent = fmtClock(state.blindLevel.timeRemainingMs);

    document.getElementById('pot-amount').textContent = `Pot: ${(state.pots[0]?.amount || 0).toLocaleString()}`;

    const community = document.getElementById('community-cards');
    community.innerHTML = '';
    const cc = state.communityCards || [];
    for (let i = 0; i < 5; i++) {
      community.appendChild(cardEl(cc[i] || null));
    }

    renderSeats(state);
    renderActionBar(state);
    renderLog(state);
    renderStandings(state);
  }

  function renderSeats(state) {
    const table = document.getElementById('poker-table');
    table.querySelectorAll('.seat').forEach((el) => el.remove());

    const occupied = state.players.filter(Boolean);
    if (occupied.length === 0) return;

    let myIndex = occupied.findIndex((p) => p.isMe);
    if (myIndex === -1) myIndex = 0;
    const ordered = occupied.slice(myIndex).concat(occupied.slice(0, myIndex));

    const n = ordered.length;
    const cx = 50, cy = 50, rx = 42, ry = 37;

    ordered.forEach((p, i) => {
      const theta = Math.PI / 2 + (i * (2 * Math.PI)) / n;
      const x = cx + rx * Math.cos(theta);
      const y = cy + ry * Math.sin(theta);

      const seat = document.createElement('div');
      seat.className = 'seat';
      seat.style.left = `${x}%`;
      seat.style.top = `${y}%`;
      if (p.id === state.actingPlayerId) seat.classList.add('acting');
      if (p.folded) seat.classList.add('folded');
      if (p.bustedOut) seat.classList.add('busted');

      const badges = [];
      if (p.seat === state.dealerSeat) badges.push('D');
      if (p.seat === state.smallBlindSeat) badges.push('SB');
      if (p.seat === state.bigBlindSeat) badges.push('BB');

      const box = document.createElement('div');
      box.className = 'seat-box';
      box.innerHTML = `
        ${badges.length ? `<div class="seat-badge">${badges[0]}</div>` : ''}
        <div class="seat-name"><span class="dot ${p.connected ? 'online' : 'away'}"></span>${escapeHtml(p.name)}${p.isMe ? ' (you)' : ''}</div>
        <div class="seat-chips">${p.bustedOut ? `Out — ${ordinal(p.bustedPlace)}` : p.chips.toLocaleString()}</div>
        <div class="seat-status">${p.folded ? 'Folded' : escapeHtml(p.lastAction || '')}</div>
      `;

      const cardsWrap = document.createElement('div');
      cardsWrap.className = 'seat-cards';
      (p.holeCards || []).forEach((c) => cardsWrap.appendChild(cardEl(c)));
      box.appendChild(cardsWrap);

      if (p.roundBet > 0) {
        const bet = document.createElement('div');
        bet.className = 'seat-bet';
        bet.textContent = p.roundBet.toLocaleString();
        box.appendChild(bet);
      }

      seat.appendChild(box);
      table.appendChild(seat);
    });
  }

  function renderActionBar(state) {
    const me = state.players.find((p) => p && p.isMe);
    const actionBar = document.getElementById('action-bar');
    const isMyTurn = me && state.actingPlayerId === me.id && ['preflop', 'flop', 'turn', 'river'].includes(state.bettingRound);

    const holeWrap = document.getElementById('my-hole-cards');
    holeWrap.innerHTML = '';
    if (me) (me.holeCards || []).forEach((c) => holeWrap.appendChild(cardEl(c, '')));

    if (!isMyTurn) {
      actionBar.classList.add('hidden');
      raisePanelOpen = false;
      document.getElementById('raise-controls').classList.add('hidden');
      return;
    }
    actionBar.classList.remove('hidden');

    const toCall = state.currentBet - me.roundBet;
    const buttons = document.getElementById('action-buttons');
    buttons.innerHTML = '';

    buttons.appendChild(makeActionButton('Fold', 'fold', () => sendAction('fold')));

    if (toCall <= 0) {
      buttons.appendChild(makeActionButton('Check', 'check', () => sendAction('check')));
    } else {
      const callAmt = Math.min(toCall, me.chips);
      buttons.appendChild(makeActionButton(`Call ${callAmt.toLocaleString()}`, 'call', () => sendAction('call')));
    }

    const minTotal = Math.min(me.chips + me.roundBet, state.currentBet + state.minRaiseAmount);
    const maxTotal = me.chips + me.roundBet;
    const canRaise = maxTotal > Math.max(state.currentBet, minTotal - 1) && me.chips > 0;
    if (canRaise) {
      const label = state.currentBet > 0 ? 'Raise' : 'Bet';
      buttons.appendChild(
        makeActionButton(label, 'raise', () => openRaisePanel(state, me, minTotal, maxTotal))
      );
    }

    if (!raisePanelOpen) {
      document.getElementById('raise-controls').classList.add('hidden');
    }
  }

  function makeActionButton(label, cls, onClick) {
    const btn = document.createElement('button');
    btn.className = `btn ${cls}`;
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function openRaisePanel(state, me, minTotal, maxTotal) {
    raisePanelOpen = true;
    const panel = document.getElementById('raise-controls');
    panel.classList.remove('hidden');
    const slider = document.getElementById('raise-slider');
    const amountInput = document.getElementById('raise-amount');
    slider.min = minTotal;
    slider.max = maxTotal;
    slider.step = 1;
    slider.value = minTotal;
    amountInput.min = minTotal;
    amountInput.max = maxTotal;
    amountInput.value = minTotal;

    slider.oninput = () => { amountInput.value = slider.value; };
    amountInput.oninput = () => {
      const v = clamp(parseInt(amountInput.value || minTotal, 10), minTotal, maxTotal);
      slider.value = v;
    };

    const potTotal = state.pots[0]?.amount || 0;
    panel.querySelectorAll('[data-preset]').forEach((btn) => {
      btn.onclick = () => {
        let target;
        if (btn.dataset.preset === 'min') target = minTotal;
        else if (btn.dataset.preset === 'half') target = state.currentBet + Math.round(potTotal / 2);
        else if (btn.dataset.preset === 'pot') target = state.currentBet + potTotal;
        else target = maxTotal;
        target = clamp(target, minTotal, maxTotal);
        slider.value = target;
        amountInput.value = target;
      };
    });

    document.getElementById('btn-confirm-raise').onclick = () => {
      const amount = clamp(parseInt(amountInput.value || minTotal, 10), minTotal, maxTotal);
      sendAction('raise', amount);
    };
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  async function sendAction(type, amount) {
    raisePanelOpen = false;
    document.getElementById('action-bar').classList.add('hidden');
    try {
      await apiPost('/api/action', { tableId: session.tableId, token: session.token, type, amount });
      fetchState();
    } catch (err) {
      toast(err.message);
      fetchState();
    }
  }

  function renderLog(state) {
    const list = document.getElementById('log-list');
    const wasScrolledToBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 20;
    list.innerHTML = '';
    (state.log || []).forEach((entry) => {
      const li = document.createElement('li');
      li.textContent = entry.message;
      list.appendChild(li);
    });
    if (wasScrolledToBottom) list.scrollTop = list.scrollHeight;
  }

  function renderStandings(state) {
    const list = document.getElementById('standings-list');
    list.innerHTML = '';
    state.standings.forEach((p) => {
      const li = document.createElement('li');
      const label = p.bustedPlace ? ` — ${ordinal(p.bustedPlace)}` : '';
      li.textContent = `${p.name}: ${p.chips.toLocaleString()} chips${label}`;
      list.appendChild(li);
    });
  }

  function renderOver(state) {
    showScreen('screen-over');
    const winner = state.standings.find((p) => p.bustedPlace === 1);
    document.getElementById('over-winner').textContent = winner ? `${winner.name} takes it all! 🏆` : '';
    const list = document.getElementById('over-standings');
    list.innerHTML = '';
    state.standings.forEach((p) => {
      const li = document.createElement('li');
      li.textContent = `${p.name} — ${p.bustedPlace ? ordinal(p.bustedPlace) : ''} (${p.chips.toLocaleString()} chips)`;
      list.appendChild(li);
    });
    stopPolling();
  }

  function render(state) {
    if (state.status === 'lobby') renderLobby(state);
    else if (state.status === 'tournament_over') renderOver(state);
    else renderGame(state);
  }

  // ---------- helpers ----------

  function ordinal(n) {
    if (!n) return '';
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : str;
    return div.innerHTML;
  }

  // ---------- home screen wiring ----------

  function initHomeScreen() {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
        document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
        document.getElementById(`form-${btn.dataset.tab}`).classList.add('active');
      });
    });

    const params = new URLSearchParams(location.search);
    const joinCode = params.get('join');
    if (joinCode) {
      document.getElementById('join-code').value = joinCode.toUpperCase();
      document.querySelector('.tab-btn[data-tab="join"]').click();
    }

    document.getElementById('form-join').addEventListener('submit', async (e) => {
      e.preventDefault();
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
    document.getElementById('btn-toggle-log').addEventListener('click', () => {
      document.getElementById('log-panel').classList.toggle('hidden');
      document.getElementById('standings-panel').classList.add('hidden');
    });
    document.getElementById('btn-close-log').addEventListener('click', () => {
      document.getElementById('log-panel').classList.add('hidden');
    });
    document.getElementById('btn-standings').addEventListener('click', () => {
      document.getElementById('standings-panel').classList.toggle('hidden');
      document.getElementById('log-panel').classList.add('hidden');
    });
    document.getElementById('btn-close-standings').addEventListener('click', () => {
      document.getElementById('standings-panel').classList.add('hidden');
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
  }

  // ---------- boot ----------

  function init() {
    initHomeScreen();
    initLobbyScreen();
    initGameScreen();

    if (session && session.tableId && session.token) {
      startPolling();
    } else {
      showScreen('screen-home');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
