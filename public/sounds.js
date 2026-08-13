// Poker table sound effects, synthesized live with the Web Audio API.
// No audio files to download or host — every sound below is generated from oscillators and
// filtered noise, which keeps the whole app dependency-free and instant to load.
(() => {
  'use strict';

  let ctx = null;
  let masterGain = null;
  let enabled = true;
  let musicNodes = null;

  try {
    enabled = localStorage.getItem('cousinsPokerSound') !== 'off';
  } catch (e) {
    enabled = true;
  }

  function ensureContext() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      masterGain = ctx.createGain();
      masterGain.gain.value = 0.5;
      masterGain.connect(ctx.destination);
    }
    // Browsers suspend audio until a user gesture; resume on first interaction.
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // A short burst of filtered noise — the basis of card and chip sounds.
  function noiseBurst({ duration = 0.12, filterFreq = 2000, filterQ = 1, gain = 0.3, type = 'bandpass', sweepTo = null }) {
    const c = ensureContext();
    if (!c) return;
    const bufferSize = Math.floor(c.sampleRate * duration);
    const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      // Exponential decay envelope baked into the noise itself.
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 2.2);
    }
    const src = c.createBufferSource();
    src.buffer = buffer;

    const filter = c.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = filterFreq;
    filter.Q.value = filterQ;
    if (sweepTo) {
      filter.frequency.setValueAtTime(filterFreq, c.currentTime);
      filter.frequency.exponentialRampToValueAtTime(sweepTo, c.currentTime + duration);
    }

    const g = c.createGain();
    g.gain.value = gain;

    src.connect(filter);
    filter.connect(g);
    g.connect(masterGain);
    src.start();
    src.stop(c.currentTime + duration);
  }

  function tone({ freq = 440, duration = 0.15, gain = 0.2, type = 'sine', delay = 0, glideTo = null }) {
    const c = ensureContext();
    if (!c) return;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    const start = c.currentTime + delay;
    osc.frequency.setValueAtTime(freq, start);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, start + duration);

    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(gain, start + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    osc.connect(g);
    g.connect(masterGain);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  const Sounds = {
    isEnabled() {
      return enabled;
    },

    toggle() {
      enabled = !enabled;
      try {
        localStorage.setItem('cousinsPokerSound', enabled ? 'on' : 'off');
      } catch (e) {
        /* storage unavailable — setting just won't persist */
      }
      if (!enabled) Sounds.stopMusic();
      return enabled;
    },

    // Called on first user gesture so the audio context is unlocked and ready.
    unlock() {
      ensureContext();
    },

    // A card sliding across felt.
    cardDeal() {
      if (!enabled) return;
      noiseBurst({ duration: 0.13, filterFreq: 3200, filterQ: 0.8, gain: 0.22, sweepTo: 900 });
    },

    // Flipping a card face-up — slightly sharper and brighter.
    cardFlip() {
      if (!enabled) return;
      noiseBurst({ duration: 0.1, filterFreq: 4200, filterQ: 1.2, gain: 0.26, sweepTo: 1400 });
      tone({ freq: 780, duration: 0.06, gain: 0.05, type: 'triangle', delay: 0.02 });
    },

    // Chips pushed into the pot.
    chips() {
      if (!enabled) return;
      for (let i = 0; i < 4; i++) {
        setTimeout(() => {
          noiseBurst({ duration: 0.07, filterFreq: 2400 + Math.random() * 1800, filterQ: 6, gain: 0.2 });
        }, i * 38 + Math.random() * 18);
      }
    },

    // Knuckles on the table.
    check() {
      if (!enabled) return;
      noiseBurst({ duration: 0.09, filterFreq: 320, filterQ: 3, gain: 0.32, type: 'lowpass' });
    },

    // Cards mucked.
    fold() {
      if (!enabled) return;
      noiseBurst({ duration: 0.22, filterFreq: 1600, filterQ: 0.6, gain: 0.16, sweepTo: 500 });
    },

    // Big moment — someone shoves.
    allIn() {
      if (!enabled) return;
      tone({ freq: 220, duration: 0.5, gain: 0.16, type: 'sawtooth', glideTo: 440 });
      tone({ freq: 330, duration: 0.55, gain: 0.1, type: 'triangle', delay: 0.05, glideTo: 660 });
      Sounds.chips();
    },

    // It's your turn — a gentle two-note nudge.
    yourTurn() {
      if (!enabled) return;
      tone({ freq: 660, duration: 0.14, gain: 0.16, type: 'sine' });
      tone({ freq: 880, duration: 0.2, gain: 0.14, type: 'sine', delay: 0.13 });
    },

    // You won the pot — a bright major arpeggio.
    win() {
      if (!enabled) return;
      const notes = [523.25, 659.25, 783.99, 1046.5];
      notes.forEach((f, i) => tone({ freq: f, duration: 0.42, gain: 0.15, type: 'triangle', delay: i * 0.09 }));
    },

    // Someone else took it down.
    potAwarded() {
      if (!enabled) return;
      Sounds.chips();
      tone({ freq: 392, duration: 0.28, gain: 0.1, type: 'sine', delay: 0.1 });
      tone({ freq: 523.25, duration: 0.3, gain: 0.09, type: 'sine', delay: 0.2 });
    },

    // A player busts out.
    elimination() {
      if (!enabled) return;
      tone({ freq: 400, duration: 0.5, gain: 0.14, type: 'sine', glideTo: 150 });
    },

    // Blinds go up.
    blindsUp() {
      if (!enabled) return;
      tone({ freq: 587.33, duration: 0.18, gain: 0.13, type: 'square' });
      tone({ freq: 880, duration: 0.26, gain: 0.11, type: 'square', delay: 0.16 });
    },

    // Tournament winner fanfare.
    victory() {
      if (!enabled) return;
      const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
      notes.forEach((f, i) => tone({ freq: f, duration: 0.6, gain: 0.16, type: 'triangle', delay: i * 0.13 }));
    },

    // Low, slow ambient pad — deliberately understated so it sits under conversation.
    startMusic() {
      if (!enabled || musicNodes) return;
      const c = ensureContext();
      if (!c) return;

      const gain = c.createGain();
      gain.gain.value = 0;
      gain.gain.linearRampToValueAtTime(0.055, c.currentTime + 3);
      gain.connect(masterGain);

      const filter = c.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 620;
      filter.connect(gain);

      // A quiet, slowly-drifting minor chord.
      const freqs = [110, 164.81, 220, 277.18];
      const oscs = freqs.map((f, i) => {
        const osc = c.createOscillator();
        osc.type = i % 2 === 0 ? 'sine' : 'triangle';
        osc.frequency.value = f;

        // Slow detune drift keeps it from sounding static/synthetic.
        const lfo = c.createOscillator();
        const lfoGain = c.createGain();
        lfo.frequency.value = 0.05 + i * 0.017;
        lfoGain.gain.value = 1.6;
        lfo.connect(lfoGain);
        lfoGain.connect(osc.detune);
        lfo.start();

        osc.connect(filter);
        osc.start();
        return { osc, lfo };
      });

      musicNodes = { gain, oscs };
    },

    stopMusic() {
      if (!musicNodes) return;
      const c = ctx;
      const { gain, oscs } = musicNodes;
      musicNodes = null;
      if (!c) return;
      gain.gain.cancelScheduledValues(c.currentTime);
      gain.gain.setValueAtTime(gain.gain.value, c.currentTime);
      gain.gain.linearRampToValueAtTime(0, c.currentTime + 1.2);
      setTimeout(() => {
        oscs.forEach(({ osc, lfo }) => {
          try {
            osc.stop();
            lfo.stop();
          } catch (e) {
            /* already stopped */
          }
        });
      }, 1400);
    },

    isMusicPlaying() {
      return !!musicNodes;
    },
  };

  window.Sounds = Sounds;
})();
