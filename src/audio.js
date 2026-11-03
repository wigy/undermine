// All sound is synthesised at runtime. The walking tune only advances while the player moves.
(function (root) {
  const NOTE = (n) => 440 * Math.pow(2, (n - 69) / 12);
  // An original bouncy march; 0 is a rest. MIDI note numbers, eighth notes.
  const LEAD = [
    76, 79, 81, 79, 76, 0, 72, 74,
    76, 79, 81, 84, 81, 79, 76, 0,
    77, 81, 84, 81, 79, 76, 72, 76,
    74, 76, 74, 71, 72, 0, 67, 0,
  ];
  const BASS = [
    48, 0, 55, 0, 48, 0, 55, 0,
    48, 0, 55, 0, 52, 0, 55, 0,
    53, 0, 60, 0, 48, 0, 55, 0,
    55, 0, 50, 0, 48, 0, 43, 0,
  ];
  const STEP = 0.135;

  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.muted = false;
      this.step = 0;
      this.nextTime = 0;
      this.walking = false;
    }

    unlock() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        const c = this.ctx;
        this.master = c.createGain();
        this.master.gain.value = this.muted ? 0 : 0.7;
        const comp = c.createDynamicsCompressor();
        this.master.connect(comp);
        comp.connect(c.destination);
        // Short slap-back gives the small synth voices a sense of being underground.
        this.delay = c.createDelay(0.5);
        this.delay.delayTime.value = 0.17;
        const fb = c.createGain();
        fb.gain.value = 0.28;
        const damp = c.createBiquadFilter();
        damp.type = 'lowpass';
        damp.frequency.value = 1800;
        this.delay.connect(damp);
        damp.connect(fb);
        fb.connect(this.delay);
        damp.connect(this.master);
        this.noiseBuf = c.createBuffer(1, c.sampleRate * 1.2, c.sampleRate);
        const d = this.noiseBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
    }

    setMuted(m) {
      this.muted = m;
      if (this.master) this.master.gain.value = m ? 0 : 0.7;
    }

    tone(freq, dur, opts = {}) {
      if (!this.ctx) return;
      const c = this.ctx;
      const t = opts.at ?? c.currentTime;
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = opts.type || 'square';
      o.frequency.setValueAtTime(freq, t);
      if (opts.to) o.frequency.exponentialRampToValueAtTime(Math.max(20, opts.to), t + dur);
      const vol = opts.vol ?? 0.12;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g);
      g.connect(this.master);
      if (opts.echo) g.connect(this.delay);
      o.start(t);
      o.stop(t + dur + 0.02);
    }

    noise(dur, opts = {}) {
      if (!this.ctx) return;
      const c = this.ctx;
      const t = opts.at ?? c.currentTime;
      const s = c.createBufferSource();
      s.buffer = this.noiseBuf;
      const f = c.createBiquadFilter();
      f.type = opts.filter || 'lowpass';
      f.frequency.setValueAtTime(opts.freq || 900, t);
      if (opts.to) f.frequency.exponentialRampToValueAtTime(opts.to, t + dur);
      const g = c.createGain();
      g.gain.setValueAtTime(opts.vol ?? 0.2, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(f);
      f.connect(g);
      g.connect(this.master);
      if (opts.echo) g.connect(this.delay);
      s.start(t, Math.random() * 0.5, dur + 0.05);
    }

    // Called every frame. Schedules a small window ahead so stopping is almost immediate.
    tick(walking) {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      if (!walking) {
        this.walking = false;
        return;
      }
      if (!this.walking) {
        this.walking = true;
        this.nextTime = now + 0.01;
      }
      while (this.nextTime < now + 0.05) {
        const lead = LEAD[this.step];
        const bass = BASS[this.step];
        if (lead) this.tone(NOTE(lead), STEP * 0.9, { type: 'square', vol: 0.05, at: this.nextTime, echo: true });
        if (bass) this.tone(NOTE(bass), STEP * 1.3, { type: 'triangle', vol: 0.14, at: this.nextTime });
        this.step = (this.step + 1) % LEAD.length;
        this.nextTime += STEP;
      }
    }

    jingle(notes, step, opts = {}) {
      if (!this.ctx) return;
      const t0 = this.ctx.currentTime;
      notes.forEach((n, i) => {
        if (n) this.tone(NOTE(n), step * 1.5, { at: t0 + i * step, vol: 0.09, echo: true, ...opts });
      });
    }

    onEvent(e) {
      if (!this.ctx) return;
      switch (e.t) {
        case 'pump_fire': this.tone(900, 0.1, { to: 1800, type: 'sawtooth', vol: 0.05 }); break;
        case 'pump_hit': this.tone(320, 0.08, { type: 'square', vol: 0.1 }); break;
        case 'pump':
          this.tone(260 + e.stage * 150, 0.13, { to: 420 + e.stage * 170, type: 'triangle', vol: 0.2 });
          break;
        case 'pop':
          this.noise(0.18, { freq: 3000, to: 300, vol: 0.35, echo: true });
          this.tone(800, 0.12, { to: 100, type: 'square', vol: 0.12 });
          break;
        case 'rock_wiggle': this.noise(0.5, { freq: 500, vol: 0.09 }); break;
        case 'rock_fall': this.tone(500, 0.5, { to: 90, type: 'sine', vol: 0.12 }); break;
        case 'rock_land':
          this.tone(110, 0.3, { to: 35, type: 'sine', vol: 0.4 });
          this.noise(0.3, { freq: 700, to: 120, vol: 0.4, echo: true });
          break;
        case 'crush': this.tone(240, 0.14, { to: 60, type: 'square', vol: 0.12 }); break;
        case 'fire_charge': this.tone(120, 0.6, { to: 420, type: 'sawtooth', vol: 0.05 }); break;
        case 'fire': this.noise(0.8, { freq: 1400, to: 300, filter: 'bandpass', vol: 0.45 }); break;
        case 'ghost_start': this.tone(620, 0.3, { to: 240, type: 'sine', vol: 0.05, echo: true }); break;
        case 'death': {
          const t0 = this.ctx.currentTime;
          [76, 74, 72, 69, 67, 64, 60, 55].forEach((n, i) => {
            this.tone(NOTE(n), 0.16, { at: t0 + i * 0.11, vol: 0.08, echo: true });
          });
          break;
        }
        case 'veg': this.jingle([84, 88, 91], 0.07, { type: 'triangle', vol: 0.12 }); break;
        case 'veg_take': this.jingle([79, 84, 88, 91, 96], 0.06, { type: 'triangle', vol: 0.14 }); break;
        case 'extra_life': this.jingle([72, 76, 79, 84, 79, 84, 88], 0.08); break;
        case 'round_start': this.jingle([60, 64, 67, 72, 0, 67, 72], 0.1, { type: 'triangle', vol: 0.14 }); break;
        case 'round_clear': this.jingle([72, 72, 76, 79, 0, 76, 79, 84, 84], 0.11); break;
        case 'gameover': this.jingle([67, 0, 64, 0, 60, 59, 57, 55, 48], 0.17, { type: 'triangle', vol: 0.14 }); break;
      }
    }
  }

  root.AudioEngine = AudioEngine;
})(globalThis);
