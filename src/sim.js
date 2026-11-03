// Game rules. No DOM in here, so the whole game can be exercised from Node.
// Coordinates are in tiles; tile centres sit on integers. Row 0 is the surface lane.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Sim = api;
})(globalThis, function () {
  const COLS = 14;
  const ROWS = 13;
  const SUB = 8; // dig-mask cells per tile
  const FW = COLS * SUB;
  const FH = ROWS * SUB;
  const DIG_RADIUS = 0.42;
  const WALK_SPEED = 3.6;
  const DIG_SPEED = 3.0;
  const HARPOON_SPEED = 15;
  const HARPOON_RANGE = 3.25;
  const PUMP_INTERVAL = 0.26;
  const POP_STAGE = 4;
  const ROCK_SPEED = 7;
  const START = { x: 6, y: 6 };
  const DIRS = {
    U: { x: 0, y: -1 },
    D: { x: 0, y: 1 },
    L: { x: -1, y: 0 },
    R: { x: 1, y: 0 },
  };
  const ROCK_SCORES = [0, 1000, 2500, 4000, 6000, 8000, 10000, 12000, 15000];
  const OPPOSITE = { U: 'D', D: 'U', L: 'R', R: 'L' };

  function mulberry(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  class Game {
    constructor(seed = Date.now()) {
      this.seed = seed;
      this.rng = mulberry(seed);
      this.fine = new Uint8Array(FW * FH);
      this.events = [];
      this.state = 'idle';
      this.timer = 0;
      this.t = 0;
      this.score = 0;
      this.hi = 0;
      this.lives = 0;
      this.round = 0;
      this.enemies = [];
      this.rocks = [];
      this.veg = null;
      this.player = this.makePlayer();
    }

    makePlayer() {
      return {
        x: START.x, y: START.y, face: 'R', moving: false, digging: false,
        pump: null, prevPump: false, fireCd: 0, walkT: 0,
        dead: false, deathKind: null, carriedBy: null,
      };
    }

    emit(t, data) {
      this.events.push(Object.assign({ t }, data));
    }

    drainEvents() {
      const e = this.events;
      this.events = [];
      return e;
    }

    newGame() {
      this.score = 0;
      this.lives = 3;
      this.nextLife = 10000;
      this.startRound(1);
    }

    // ---- dig mask -------------------------------------------------------
    isDug(x, y) {
      const fx = Math.floor((x + 0.5) * SUB);
      const fy = Math.floor((y + 0.5) * SUB);
      if (fx < 0 || fy < 0 || fx >= FW || fy >= FH) return false;
      return this.fine[fy * FW + fx] === 1;
    }

    dig(x, y, r, live) {
      let fresh = 0;
      const x0 = Math.max(0, Math.floor((x - r + 0.5) * SUB));
      const x1 = Math.min(FW - 1, Math.floor((x + r + 0.5) * SUB));
      const y0 = Math.max(0, Math.floor((y - r + 0.5) * SUB));
      const y1 = Math.min(FH - 1, Math.floor((y + r + 0.5) * SUB));
      for (let fy = y0; fy <= y1; fy++) {
        for (let fx = x0; fx <= x1; fx++) {
          const cx = (fx + 0.5) / SUB - 0.5;
          const cy = (fy + 0.5) / SUB - 0.5;
          if ((cx - x) ** 2 + (cy - y) ** 2 <= r * r) {
            const i = fy * FW + fx;
            if (!this.fine[i]) {
              this.fine[i] = 1;
              fresh++;
            }
          }
        }
      }
      if (fresh && y > 0.02) this.emit('dig', { x, y, r, live: !!live });
      return fresh;
    }

    carve(tiles) {
      for (let i = 0; i < tiles.length; i++) {
        const [x, y] = tiles[i];
        this.dig(x, y, DIG_RADIUS, false);
        if (i + 1 < tiles.length) {
          const [nx, ny] = tiles[i + 1];
          for (let k = 1; k < 8; k++) {
            this.dig(x + ((nx - x) * k) / 8, y + ((ny - y) * k) / 8, DIG_RADIUS, false);
          }
        }
      }
    }

    // Can something walk straight between two neighbouring tile centres?
    passable(ax, ay, bx, by) {
      if (bx < 0 || bx >= COLS || by < 0 || by >= ROWS) return false;
      for (const k of [0.2, 0.35, 0.5, 0.65, 0.8]) {
        if (!this.isDug(ax + (bx - ax) * k, ay + (by - ay) * k)) return false;
      }
      return !this.rockAt(bx, by);
    }

    rockAt(x, y) {
      return this.rocks.some(
        (r) => r.state !== 'dead' && r.state !== 'break' && Math.abs(r.x - x) < 0.6 && Math.abs(r.y - y) < 0.6,
      );
    }

    // ---- round setup ----------------------------------------------------
    startRound(round) {
      this.round = round;
      this.fine.fill(0);
      for (let i = 0; i < FW * SUB; i++) this.fine[i] = 1;
      this.enemies = [];
      this.rocks = [];
      this.veg = null;
      this.rocksDropped = 0;
      this.chain = 0;
      this.player = this.makePlayer();
      this.emit('round_start', { round });

      const shaft = [];
      for (let y = 0; y <= START.y; y++) shaft.push([START.x, y]);
      this.carve(shaft);
      this.carve([[START.x - 1, START.y], [START.x, START.y], [START.x + 1, START.y]]);

      const taken = new Set();
      const mark = (x, y) => taken.add(x + ',' + y);
      for (let y = 0; y <= START.y; y++) mark(START.x, y);
      mark(START.x - 1, START.y);
      mark(START.x + 1, START.y);
      const near = (x, y, pad) => {
        for (let dy = -pad; dy <= pad; dy++) {
          for (let dx = -pad; dx <= pad; dx++) {
            if (taken.has(x + dx + ',' + (y + dy))) return true;
          }
        }
        return false;
      };

      const count = Math.min(4 + Math.floor((round - 1) * 0.7), 10);
      const cinders = Math.max(1, Math.floor(count * 0.35));
      for (let n = 0; n < count; n++) {
        let placed = false;
        for (let tries = 0; tries < 400 && !placed; tries++) {
          const len = tries < 250 ? 3 + Math.floor(this.rng() * 2) : 2;
          const horiz = this.rng() < 0.6;
          const x = Math.floor(this.rng() * (COLS - (horiz ? len : 0)));
          const y = 2 + Math.floor(this.rng() * (ROWS - 2 - (horiz ? 0 : len)));
          const cells = [];
          for (let k = 0; k < len; k++) cells.push(horiz ? [x + k, y] : [x, y + k]);
          if (cells.some(([cx, cy]) => cy >= ROWS || cx >= COLS || near(cx, cy, 1))) continue;
          if (cells.some(([cx, cy]) => Math.abs(cx - START.x) + Math.abs(cy - START.y) < 4)) continue;
          this.carve(cells);
          cells.forEach(([cx, cy]) => mark(cx, cy));
          const [ex, ey] = cells[Math.floor(len / 2)];
          this.enemies.push(this.makeEnemy(n < cinders ? 'cinder' : 'puff', ex, ey, n));
          placed = true;
        }
      }

      const rockCount = 3 + Math.min(Math.floor(round / 3), 3);
      const rockPlaced = [];
      for (let tries = 0; tries < 600 && rockPlaced.length < rockCount; tries++) {
        const x = Math.floor(this.rng() * COLS);
        const y = 1 + Math.floor(this.rng() * 10);
        if (near(x, y, 0) || near(x, y + 1, 0)) continue;
        if (rockPlaced.some((r) => Math.abs(r.x - x) + Math.abs(r.y - y) < 3)) continue;
        rockPlaced.push({ x, y });
      }
      this.rocks = rockPlaced.map((r, i) => ({
        id: i, x: r.x, y: r.y, state: 'idle', timer: 0, toRow: r.y, carried: [],
      }));

      this.state = 'ready';
      this.timer = 2.0;
      this.updateFleeFlag();
    }

    makeEnemy(type, x, y, id) {
      return {
        id, type, x, y, tx: x, ty: y, spawnX: x, spawnY: y,
        state: 'walk', dir: null, face: this.rng() < 0.5 ? -1 : 1,
        inflate: 0, pumpT: 0, timer: 0, flameLen: 0, flee: false, ghostT: this.ghostDelay(),
        fireCd: 2 + this.rng() * 3, carriedBy: null, pumpedHoriz: false, idle: 0,
      };
    }

    ghostDelay() {
      const base = Math.max(3, 9 - this.round * 0.5);
      return base + this.rng() * base;
    }

    enemySpeed() {
      return Math.min(1.9 + this.round * 0.1, 3.1);
    }

    // ---- stepping -------------------------------------------------------
    step(dt, input) {
      this.t += dt;
      if (this.state === 'ready') {
        this.timer -= dt;
        if (this.timer <= 0) this.state = 'play';
      } else if (this.state === 'play') {
        this.updatePlayer(dt, input);
        this.updateRocks(dt);
        for (const e of this.enemies) this.updateEnemy(e, dt);
        this.checkHits();
        this.updateVeg(dt);
        this.checkRoundEnd();
      } else if (this.state === 'dying') {
        this.updateRocks(dt);
        const p = this.player;
        if (p.carriedBy) p.y = p.carriedBy.y + 0.5;
        this.timer -= dt;
        if (this.timer <= 0 && !(p.carriedBy && p.carriedBy.state === 'fall')) this.afterDeath();
      } else if (this.state === 'clear') {
        this.timer -= dt;
        if (this.timer <= 0) this.startRound(this.round + 1);
      } else if (this.state === 'over') {
        this.timer -= dt;
      }
    }

    updatePlayer(dt, input) {
      const p = this.player;
      const pressed = input.pump && !p.prevPump;
      p.prevPump = input.pump;
      p.fireCd -= dt;
      p.moving = false;
      p.digging = false;
      if (p.pump) {
        this.updatePump(dt, input, pressed);
        return;
      }
      if (input.pump && (pressed || p.fireCd <= 0)) {
        p.pump = { state: 'ext', len: 0.1, target: null, timer: 0, gap: 0 };
        p.fireCd = 0.35;
        this.emit('pump_fire', {});
        return;
      }
      if (input.dir) this.movePlayer(dt, input.dir);
    }

    movePlayer(dt, dir) {
      const p = this.player;
      const d = DIRS[dir];
      const EPS = 1e-4;
      let remain;
      const peek = this.isDug(p.x + d.x * 0.55, p.y + d.y * 0.55);
      remain = (peek ? WALK_SPEED : DIG_SPEED) * dt;
      for (let guard = 0; guard < 3 && remain > EPS; guard++) {
        const offAxis = d.x !== 0 ? p.y - Math.round(p.y) : p.x - Math.round(p.x);
        if (Math.abs(offAxis) > EPS) {
          // Corner: slide to the nearest lane first, then turn.
          const s = Math.min(Math.abs(offAxis), remain);
          const step = -Math.sign(offAxis) * s;
          const nx = d.x !== 0 ? p.x : p.x + step;
          const ny = d.x !== 0 ? p.y + step : p.y;
          if (this.rockBlocks(nx, ny, p.x, p.y)) break;
          p.x = nx;
          p.y = ny;
          p.face = d.x !== 0 ? (step < 0 ? 'U' : 'D') : step < 0 ? 'L' : 'R';
          if (Math.abs(offAxis) <= remain + EPS) {
            if (d.x !== 0) p.y = Math.round(p.y);
            else p.x = Math.round(p.x);
          }
          remain -= s;
          p.moving = true;
          continue;
        }
        if (d.x !== 0) p.y = Math.round(p.y);
        else p.x = Math.round(p.x);
        const nx = Math.max(0, Math.min(COLS - 1, p.x + d.x * remain));
        const ny = Math.max(0, Math.min(ROWS - 1, p.y + d.y * remain));
        p.face = dir;
        if ((nx === p.x && ny === p.y) || this.rockBlocks(nx, ny, p.x, p.y)) break;
        p.x = nx;
        p.y = ny;
        p.moving = true;
        remain = 0;
      }
      if (p.moving) {
        p.walkT += dt;
        if (p.y > 0.02 && this.dig(p.x, p.y, DIG_RADIUS, true) > 0) p.digging = true;
      }
    }

    rockBlocks(nx, ny, ox, oy) {
      for (const r of this.rocks) {
        if (r.state === 'dead' || r.state === 'break' || r.state === 'fall') continue;
        if (Math.abs(nx - r.x) < 0.92 && Math.abs(ny - r.y) < 0.92) {
          const before = Math.abs(ox - r.x) + Math.abs(oy - r.y);
          const after = Math.abs(nx - r.x) + Math.abs(ny - r.y);
          if (after < before) return true;
        }
      }
      return false;
    }

    updatePump(dt, input, pressed) {
      const p = this.player;
      const h = p.pump;
      const d = DIRS[p.face];
      if (h.state === 'ext') {
        h.len += HARPOON_SPEED * dt;
        const tx = p.x + d.x * h.len;
        const ty = p.y + d.y * h.len;
        const hit = this.enemies.find(
          (e) => this.pumpable(e) && Math.hypot(e.x - tx, e.y - ty) < 0.5,
        );
        if (hit) {
          h.state = 'hold';
          h.target = hit;
          h.len = Math.max(0.2, Math.hypot(hit.x - p.x, hit.y - p.y) - 0.3);
          h.timer = PUMP_INTERVAL;
          h.gap = 0.1;
          hit.state = 'inflated';
          hit.inflate = 1;
          hit.pumpT = 0.8;
          hit.flameLen = 0;
          hit.pumpedHoriz = d.y === 0;
          this.emit('pump_hit', { x: hit.x, y: hit.y });
        } else if (
          h.len >= HARPOON_RANGE ||
          !this.isDug(tx, ty) ||
          this.rocks.some((r) => r.state !== 'dead' && r.state !== 'break' && Math.hypot(r.x - tx, r.y - ty) < 0.5)
        ) {
          h.state = 'ret';
        }
      } else if (h.state === 'ret') {
        h.len -= HARPOON_SPEED * 1.4 * dt;
        if (h.len <= 0) p.pump = null;
      } else if (h.state === 'hold') {
        const t = h.target;
        if (!t || t.state !== 'inflated') {
          h.state = 'ret';
          h.target = null;
          return;
        }
        h.timer -= dt;
        h.gap -= dt;
        if ((input.pump && h.timer <= 0) || (pressed && h.gap <= 0)) {
          t.inflate = Math.floor(t.inflate) + 1;
          t.pumpT = 0.8;
          h.timer = PUMP_INTERVAL;
          h.gap = 0.1;
          this.emit('pump', { stage: t.inflate, x: t.x, y: t.y });
          if (t.inflate >= POP_STAGE) {
            this.popEnemy(t);
            h.state = 'ret';
            h.target = null;
          }
        } else if (input.dir && !input.pump) {
          h.state = 'ret';
          h.target = null;
        }
      }
    }

    pumpable(e) {
      return ['walk', 'ghost', 'flee', 'charge', 'breathe'].includes(e.state);
    }

    pointsFor(e) {
      const row = Math.round(e.y);
      const band = Math.max(0, Math.min(3, Math.floor((row - 1) / 3)));
      let pts = 200 + band * 100;
      if (e.type === 'cinder' && e.pumpedHoriz) pts *= 2;
      return pts;
    }

    popEnemy(e) {
      const pts = this.pointsFor(e);
      e.state = 'pop';
      e.timer = 0.3;
      this.addScore(pts, e.x, e.y);
      this.emit('pop', { x: e.x, y: e.y, type: e.type });
      this.updateFleeFlag();
    }

    addScore(pts, x, y) {
      this.score += pts;
      if (x !== undefined) this.emit('score', { x, y, pts });
      if (this.score > this.hi) this.hi = this.score;
      if (this.score >= this.nextLife) {
        this.lives++;
        this.nextLife = this.nextLife === 10000 ? 40000 : this.nextLife + 40000;
        this.emit('extra_life', {});
      }
    }

    updateFleeFlag() {
      const active = this.enemies.filter((e) => !['dead', 'pop', 'squash', 'crushed'].includes(e.state));
      if (active.length === 1 && this.enemies.length > 1) active[0].flee = true;
    }

    // ---- rocks ----------------------------------------------------------
    updateRocks(dt) {
      const p = this.player;
      for (const r of this.rocks) {
        if (r.state === 'idle') {
          const under = Math.abs(p.x - r.x) < 0.6 && p.y > r.y && p.y - r.y < 1.3;
          if (r.y < ROWS - 1 && this.isDug(r.x, r.y + 0.75) && !under) {
            r.state = 'wiggle';
            r.timer = 0.6;
            this.emit('rock_wiggle', { x: r.x, y: r.y });
          }
        } else if (r.state === 'wiggle') {
          r.timer -= dt;
          if (r.timer <= 0) {
            r.state = 'fall';
            r.toRow = r.y + 1;
            r.carried = [];
            this.emit('rock_fall', { x: r.x, y: r.y });
          }
        } else if (r.state === 'fall') {
          r.y += ROCK_SPEED * dt;
          this.dig(r.x, r.y, 0.44, false);
          this.crushCheck(r);
          if (r.y >= r.toRow) {
            const blockedByRock = this.rocks.some(
              (o) => o !== r && o.state !== 'dead' && o.state !== 'break' && Math.abs(o.x - r.x) < 0.5 && Math.abs(o.y - (r.toRow + 1)) < 0.6,
            );
            if (r.toRow < ROWS - 1 && this.isDug(r.x, r.toRow + 0.75) && !blockedByRock) {
              r.toRow++;
            } else {
              r.y = r.toRow;
              this.landRock(r);
            }
          }
        } else if (r.state === 'break') {
          r.timer -= dt;
          if (r.timer <= 0) r.state = 'dead';
        }
      }
    }

    crushCheck(r) {
      const p = this.player;
      for (const e of this.enemies) {
        if (e.state === 'crushed') {
          if (e.carriedBy === r) e.y = r.y + 0.55;
          continue;
        }
        if (!['walk', 'inflated', 'charge', 'breathe', 'flee'].includes(e.state)) continue;
        if (Math.abs(e.x - r.x) < 0.7 && e.y > r.y && e.y - r.y < 1.0) {
          e.state = 'crushed';
          e.carriedBy = r;
          e.flameLen = 0;
          r.carried.push(e);
          this.emit('crush', { x: e.x, y: e.y });
          this.updateFleeFlag();
        }
      }
      if (!p.dead && Math.abs(p.x - r.x) < 0.7 && p.y > r.y && p.y - r.y < 1.0) {
        this.killPlayer('crushed');
        p.carriedBy = r;
      }
    }

    landRock(r) {
      r.state = 'break';
      r.timer = 0.45;
      this.emit('rock_land', { x: r.x, y: r.y, kills: r.carried.length });
      if (r.carried.length) {
        const pts = ROCK_SCORES[Math.min(r.carried.length, ROCK_SCORES.length - 1)];
        this.addScore(pts, r.x, r.y);
        for (const e of r.carried) {
          e.state = 'squash';
          e.y = r.y + 0.3;
          e.timer = 0.7;
          e.carriedBy = null;
        }
      }
      this.rocksDropped++;
      if (this.rocksDropped === 2 && this.state === 'play') {
        this.veg = { x: START.x, y: START.y, t: 10, kind: (this.round - 1) % 4 };
        this.emit('veg', { x: START.x, y: START.y });
      }
    }

    // ---- enemies --------------------------------------------------------
    updateEnemy(e, dt) {
      switch (e.state) {
        case 'walk': this.enemyWalk(e, dt); break;
        case 'ghost': this.enemyGhost(e, dt); break;
        case 'flee': this.enemyFlee(e, dt); break;
        case 'charge':
          e.timer -= dt;
          if (e.timer <= 0) {
            e.state = 'breathe';
            e.timer = 0.85;
            e.flameLen = 0;
            this.emit('fire', { x: e.x, y: e.y });
          }
          break;
        case 'breathe':
          e.timer -= dt;
          e.flameLen = Math.min(3.2, e.flameLen + dt * 12);
          if (e.timer <= 0) {
            e.state = 'walk';
            e.flameLen = 0;
            e.fireCd = 2.5 + this.rng() * 3;
          }
          break;
        case 'inflated':
          e.pumpT -= dt;
          if (e.pumpT <= 0) {
            e.inflate -= dt * 1.4;
            if (e.inflate <= 0) this.recover(e);
          }
          break;
        case 'pop':
        case 'squash':
          e.timer -= dt;
          if (e.timer <= 0) e.state = 'dead';
          break;
      }
    }

    recover(e) {
      e.inflate = 0;
      const cx = Math.round(e.x);
      const cy = Math.round(e.y);
      if (this.isDug(e.x, e.y)) {
        e.state = 'walk';
        if (this.isDug(cx, cy) && !this.rockAt(cx, cy)) {
          e.tx = cx;
          e.ty = cy;
        } else {
          e.tx = e.x;
          e.ty = e.y;
        }
      } else {
        this.startGhost(e);
      }
    }

    startGhost(e) {
      e.state = 'ghost';
      e.timer = 0;
      this.emit('ghost_start', { x: e.x, y: e.y });
    }

    enemyWalk(e, dt) {
      const p = this.player;
      let dist = this.enemySpeed() * dt;
      e.ghostT -= dt;
      e.fireCd -= dt;
      if (e.flee) {
        e.state = 'flee';
        return;
      }
      for (let guard = 0; guard < 2 && dist > 1e-6; guard++) {
        if (e.x === e.tx && e.y === e.ty) {
          if (e.ghostT <= 0) {
            e.ghostT = this.ghostDelay();
            this.startGhost(e);
            return;
          }
          if (e.type === 'cinder' && e.fireCd <= 0 && Math.abs(p.y - e.y) < 0.5 && Math.abs(p.x - e.x) <= 5) {
            e.state = 'charge';
            e.timer = 0.6;
            e.face = p.x < e.x ? -1 : 1;
            this.emit('fire_charge', { x: e.x, y: e.y });
            return;
          }
          const dir = this.chooseDir(e);
          if (!dir) {
            e.idle += dt;
            e.ghostT -= dt * 2;
            return;
          }
          e.idle = 0;
          e.dir = dir;
          e.tx = e.x + DIRS[dir].x;
          e.ty = e.y + DIRS[dir].y;
          if (DIRS[dir].x) e.face = DIRS[dir].x;
        }
        const dx = e.tx - e.x;
        const dy = e.ty - e.y;
        const len = Math.abs(dx) + Math.abs(dy);
        const s = Math.min(len, dist);
        if (len > 0) {
          e.x += (dx / len) * s;
          e.y += (dy / len) * s;
        }
        dist -= s;
        if (s >= len - 1e-6) {
          e.x = e.tx;
          e.y = e.ty;
        }
      }
    }

    chooseDir(e) {
      const p = this.player;
      let best = null;
      let bestScore = -Infinity;
      for (const k of ['U', 'D', 'L', 'R']) {
        const nx = e.x + DIRS[k].x;
        const ny = e.y + DIRS[k].y;
        if (!this.passable(e.x, e.y, nx, ny)) continue;
        let score = -(Math.abs(nx - p.x) + Math.abs(ny - p.y)) + this.rng() * 2.5;
        if (e.dir && k === OPPOSITE[e.dir]) score -= 3;
        if (score > bestScore) {
          bestScore = score;
          best = k;
        }
      }
      return best;
    }

    enemyGhost(e, dt) {
      const p = this.player;
      e.timer += dt;
      if (e.flee) {
        e.state = 'flee';
        return;
      }
      const speed = this.enemySpeed() * 0.85;
      const dx = p.x - e.x;
      const dy = p.y - e.y;
      const len = Math.hypot(dx, dy) || 1;
      e.x = Math.max(0, Math.min(COLS - 1, e.x + (dx / len) * speed * dt));
      e.y = Math.max(0, Math.min(ROWS - 1, e.y + (dy / len) * speed * dt));
      if (dx) e.face = dx < 0 ? -1 : 1;
      const cx = Math.round(e.x);
      const cy = Math.round(e.y);
      if (e.timer > 0.9 && Math.hypot(cx - e.x, cy - e.y) < 0.2 && this.isDug(cx, cy) && !this.rockAt(cx, cy)) {
        e.x = e.tx = cx;
        e.y = e.ty = cy;
        e.dir = null;
        e.state = 'walk';
        this.emit('ghost_end', { x: cx, y: cy });
      }
    }

    enemyFlee(e, dt) {
      const speed = 2.8;
      if (e.y > 0) {
        e.y = Math.max(0, e.y - speed * dt);
      } else {
        e.face = -1;
        e.x -= speed * dt;
        if (e.x < -1.2) {
          e.state = 'dead';
          this.emit('escaped', {});
        }
      }
    }

    // ---- collisions and pickups ----------------------------------------
    checkHits() {
      const p = this.player;
      if (p.dead) return;
      for (const e of this.enemies) {
        if (['walk', 'ghost', 'flee', 'charge', 'breathe'].includes(e.state)) {
          const reach = e.state === 'ghost' ? 0.6 : 0.68;
          if (Math.hypot(e.x - p.x, e.y - p.y) < reach) {
            this.killPlayer('caught');
            return;
          }
        }
        if (e.state === 'breathe' && e.flameLen > 0) {
          const near = e.x + e.face * 0.4;
          const far = near + e.face * e.flameLen;
          const lo = Math.min(near, far);
          const hi = Math.max(near, far);
          if (Math.abs(p.y - e.y) < 0.42 && p.x > lo - 0.2 && p.x < hi + 0.2) {
            this.killPlayer('burned');
            return;
          }
        }
      }
    }

    killPlayer(kind) {
      const p = this.player;
      p.dead = true;
      p.deathKind = kind;
      p.moving = false;
      p.pump = null;
      this.state = 'dying';
      this.timer = 2.0;
      for (const e of this.enemies) e.flameLen = 0;
      this.emit('death', { kind, x: p.x, y: p.y });
    }

    afterDeath() {
      this.lives--;
      if (this.lives <= 0) {
        this.state = 'over';
        this.timer = 4;
        this.emit('gameover', {});
        return;
      }
      for (const r of this.rocks) {
        if (r.state === 'fall' || r.state === 'wiggle') r.state = 'dead';
      }
      for (const e of this.enemies) {
        if (e.state === 'crushed' || e.state === 'pop' || e.state === 'squash') e.state = 'dead';
        if (e.state === 'dead') continue;
        Object.assign(e, {
          x: e.spawnX, y: e.spawnY, tx: e.spawnX, ty: e.spawnY, state: 'walk',
          inflate: 0, flameLen: 0, dir: null, ghostT: this.ghostDelay(),
          fireCd: 2 + this.rng() * 3, carriedBy: null,
        });
      }
      this.player = this.makePlayer();
      this.veg = null;
      this.state = 'ready';
      this.timer = 1.8;
      this.emit('respawn', {});
      this.checkRoundEnd();
    }

    updateVeg(dt) {
      const v = this.veg;
      if (!v) return;
      v.t -= dt;
      const p = this.player;
      if (Math.hypot(v.x - p.x, v.y - p.y) < 0.6) {
        const pts = 400 + Math.min(this.round, 18) * 200;
        this.addScore(pts, v.x, v.y);
        this.emit('veg_take', { x: v.x, y: v.y });
        this.veg = null;
      } else if (v.t <= 0) {
        this.veg = null;
      }
    }

    checkRoundEnd() {
      if (this.player.dead || !this.enemies.length) return;
      if (this.enemies.every((e) => e.state === 'dead')) {
        const p = this.player;
        p.pump = null;
        p.moving = false;
        this.veg = null;
        this.state = 'clear';
        this.timer = 2.6;
        this.emit('round_clear', { round: this.round });
      }
    }
  }

  return { Game, COLS, ROWS, DIRS, DIG_RADIUS, START, POP_STAGE, ROCK_SCORES };
});
