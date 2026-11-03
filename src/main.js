// Wires input, the fixed-step simulation, rendering and audio together.
(function () {
  const canvas = document.getElementById('game');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const seed = (Date.now() ^ (Math.random() * 1e9)) >>> 0;
  const game = new Sim.Game(seed);
  const renderer = new Renderer(canvas, reducedMotion);
  const audio = new AudioEngine();
  const HI_KEY = 'undermine.best';
  const STEP = 1 / 60;

  try {
    game.hi = Number(localStorage.getItem(HI_KEY)) || 0;
  } catch (_) { /* private mode: best score just won't persist */ }
  const saveHi = () => {
    try {
      localStorage.setItem(HI_KEY, String(game.hi));
    } catch (_) { /* see above */ }
  };

  renderer.startTitle(seed);

  // ---- input ---------------------------------------------------------
  const KEY_DIR = {
    ArrowUp: 'U', ArrowDown: 'D', ArrowLeft: 'L', ArrowRight: 'R',
    KeyW: 'U', KeyS: 'D', KeyA: 'L', KeyD: 'R',
  };
  const PUMP_KEYS = new Set(['Space', 'KeyZ', 'KeyX', 'Enter']);
  const held = []; // most recently pressed direction wins
  let keyPump = false;
  let touchDir = null;
  let touchPump = false;
  let padPump = false;
  let padDir = null;
  let padStart = false;
  let touchUsed = window.matchMedia('(pointer: coarse)').matches;
  let paused = false;

  function startOrContinue() {
    audio.unlock();
    if (game.state === 'idle') {
      if (renderer.title && !renderer.title.done) {
        renderer.finishTitle();
        return;
      }
      game.newGame();
    } else if (game.state === 'over' && game.timer <= 2.6) {
      game.newGame();
    }
  }

  window.addEventListener('keydown', (e) => {
    if (KEY_DIR[e.code] || PUMP_KEYS.has(e.code)) e.preventDefault();
    if (e.repeat) return;
    audio.unlock();
    const dir = KEY_DIR[e.code];
    if (dir) {
      const i = held.indexOf(dir);
      if (i >= 0) held.splice(i, 1);
      held.push(dir);
    }
    if (PUMP_KEYS.has(e.code)) {
      keyPump = true;
      startOrContinue();
    }
    if (e.code === 'KeyP' || e.code === 'Escape') togglePause();
    if (e.code === 'KeyM') audio.setMuted(!audio.muted);
  });
  window.addEventListener('keyup', (e) => {
    const dir = KEY_DIR[e.code];
    if (dir) {
      const i = held.indexOf(dir);
      if (i >= 0) held.splice(i, 1);
    }
    if (PUMP_KEYS.has(e.code)) keyPump = false;
  });

  function togglePause() {
    if (['play', 'ready'].includes(game.state)) paused = !paused;
  }

  window.addEventListener('blur', () => {
    held.length = 0;
    keyPump = false;
    if (game.state === 'play') paused = true;
  });

  // Touch: drag anywhere on the left to steer, hold anywhere on the right to pump.
  const stick = { id: null, x: 0, y: 0 };
  let pumpTouch = null;
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    audio.unlock();
    if (e.pointerType !== 'mouse') touchUsed = true;
    if (paused) {
      paused = false;
      return;
    }
    if (game.state === 'idle' || game.state === 'over') {
      startOrContinue();
      return;
    }
    if (e.pointerType === 'mouse') return;
    if (e.clientX < window.innerWidth * 0.55 && stick.id === null) {
      stick.id = e.pointerId;
      stick.x = e.clientX;
      stick.y = e.clientY;
    } else if (pumpTouch === null) {
      pumpTouch = e.pointerId;
      touchPump = true;
    }
    canvas.setPointerCapture?.(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== stick.id) return;
    const dx = e.clientX - stick.x;
    const dy = e.clientY - stick.y;
    if (Math.hypot(dx, dy) > 12) {
      touchDir = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'L' : 'R') : dy < 0 ? 'U' : 'D';
    }
  });
  const endPointer = (e) => {
    if (e.pointerId === stick.id) {
      stick.id = null;
      touchDir = null;
    }
    if (e.pointerId === pumpTouch) {
      pumpTouch = null;
      touchPump = false;
    }
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  function pollGamepad() {
    padDir = null;
    padPump = false;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (!pad) continue;
      const ax = pad.axes[0] || 0;
      const ay = pad.axes[1] || 0;
      const b = pad.buttons;
      if (b[12]?.pressed) padDir = 'U';
      else if (b[13]?.pressed) padDir = 'D';
      else if (b[14]?.pressed) padDir = 'L';
      else if (b[15]?.pressed) padDir = 'R';
      else if (Math.hypot(ax, ay) > 0.4) padDir = Math.abs(ax) > Math.abs(ay) ? (ax < 0 ? 'L' : 'R') : ay < 0 ? 'U' : 'D';
      padPump = !!(b[0]?.pressed || b[1]?.pressed || b[2]?.pressed);
      const start = !!b[9]?.pressed;
      if (start && !padStart) togglePause();
      padStart = start;
      break;
    }
    if (padPump && (game.state === 'idle' || game.state === 'over') && !pollGamepad.wasDown) startOrContinue();
    pollGamepad.wasDown = padPump;
  }

  // ---- loop ----------------------------------------------------------
  let last = performance.now();
  let acc = 0;
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => renderer.resize(), 120);
  });

  // If the machine can't hold about 40 fps, render fewer pixels. The rules keep real time regardless.
  let slowSum = 0;
  let slowCount = 0;
  function watchFrameRate(raw) {
    if (raw > 0.25) return; // tab was hidden
    slowSum += raw;
    if (++slowCount < 90) return;
    if (slowSum / slowCount > 1 / 40) renderer.lowerQuality();
    slowSum = 0;
    slowCount = 0;
  }

  function frame(now) {
    const raw = (now - last) / 1000;
    const dt = Math.min(0.1, raw);
    last = now;
    watchFrameRate(raw);
    pollGamepad();
    if (!paused) {
      acc += dt;
      const input = {
        dir: held[held.length - 1] || touchDir || padDir || null,
        pump: keyPump || touchPump || padPump,
      };
      let steps = 0;
      while (acc >= STEP && steps < 6) {
        game.step(STEP, input);
        for (const ev of game.drainEvents()) {
          renderer.onEvent(ev, game);
          audio.onEvent(ev);
          if (ev.t === 'gameover' || ev.t === 'round_clear') saveHi();
        }
        acc -= STEP;
        steps++;
      }
      if (steps === 6) acc = 0;
    }
    audio.tick(!paused && game.state === 'play' && game.player.moving);
    renderer.draw(game, paused ? 0 : dt, { paused, touch: touchUsed });
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  window.__undermine = { game, renderer, audio };
})();
