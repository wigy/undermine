const test = require('node:test');
const assert = require('node:assert');
const { Game, COLS, ROWS, START } = require('../src/sim.js');

const DT = 1 / 60;
const run = (g, seconds, input = {}) => {
  for (let i = 0; i < seconds * 60; i++) g.step(DT, { dir: null, pump: false, ...input });
};

// A round with one known enemy and no rocks, already in play.
function arena(seed = 7) {
  const g = new Game(seed);
  g.newGame();
  g.state = 'play';
  g.rocks = [];
  g.enemies = [g.makeEnemy('puff', 10, 6, 0), g.makeEnemy('puff', 1, 11, 1)];
  g.enemies.forEach((e) => { e.ghostT = 999; });
  return g;
}

test('every generated round is fair across many rounds and seeds', () => {
  for (let seed = 1; seed <= 25; seed++) {
    for (const round of [1, 2, 5, 10, 20]) {
      const g = new Game(seed);
      g.newGame();
      g.startRound(round);
      assert.ok(g.enemies.length >= 4, 'has enemies');
      assert.ok(g.rocks.length >= 3, `round ${round} seed ${seed} has rocks, got ${g.rocks.length}`);
      assert.ok(g.isDug(START.x, START.y), 'player spawn is open');
      assert.ok(g.isDug(START.x, 0.4), 'shaft reaches surface');
      for (const e of g.enemies) {
        assert.ok(g.isDug(e.x, e.y), 'enemy spawns in a tunnel');
        assert.ok(Math.abs(e.x - START.x) + Math.abs(e.y - START.y) >= 4, 'enemy not on top of player');
      }
      for (const r of g.rocks) {
        assert.ok(!g.isDug(r.x, r.y), 'rock in solid dirt');
        assert.ok(!g.isDug(r.x, r.y + 0.75), 'rock does not fall on its own');
      }
    }
  }
});

test('player digs through dirt and stays on lanes when cornering', () => {
  const g = arena();
  assert.ok(!g.isDug(9, 6.5));
  run(g, 0.5, { dir: 'D' });
  const y = g.player.y;
  assert.ok(y > START.y, 'moved down');
  assert.ok(g.isDug(START.x, y), 'dug where it stands');
  run(g, 0.5, { dir: 'R' });
  assert.strictEqual(g.player.y, Math.round(g.player.y), 'on a row lane');
  assert.ok(g.player.x > START.x);
});

test('player cannot leave the field', () => {
  const g = arena();
  g.player.x = 0;
  g.player.y = 0;
  run(g, 0.5, { dir: 'L' });
  run(g, 0.5, { dir: 'U' });
  assert.deepStrictEqual([g.player.x, g.player.y], [0, 0]);
  g.player.x = COLS - 1;
  g.player.y = ROWS - 1;
  run(g, 0.5, { dir: 'R' });
  run(g, 0.5, { dir: 'D' });
  assert.deepStrictEqual([g.player.x, g.player.y], [COLS - 1, ROWS - 1]);
});

test('harpoon stops at solid dirt', () => {
  const g = arena();
  g.player.x = START.x;
  g.player.y = START.y;
  g.player.face = 'D';
  g.step(DT, { dir: null, pump: true });
  run(g, 0.5);
  assert.strictEqual(g.player.pump, null, 'retracted');
  assert.ok(g.enemies.every((e) => e.state !== 'inflated'));
});

test('holding pump inflates and pops an enemy, then scores by depth', () => {
  const g = arena();
  g.carve([[7, 6], [8, 6], [9, 6], [10, 6]]);
  const e = g.enemies[0];
  e.tx = e.x = 8;
  e.ty = e.y = 6;
  g.player.face = 'R';
  run(g, 1.6, { pump: true });
  assert.ok(['pop', 'dead'].includes(e.state), `popped, was ${e.state}`);
  assert.strictEqual(g.score, 300); // row 6 is the second stratum
});

test('horizontal pop on a fire drake doubles the score', () => {
  const g = arena();
  g.carve([[7, 6], [8, 6], [9, 6]]);
  g.enemies[0].type = 'cinder';
  const e = g.enemies[0];
  e.tx = e.x = 8;
  e.ty = e.y = 6;
  e.fireCd = 99;
  g.player.face = 'R';
  run(g, 1.6, { pump: true });
  assert.strictEqual(g.score, 600);
});

test('an enemy left alone deflates and walks again', () => {
  const g = arena();
  g.carve([[7, 6], [8, 6], [9, 6]]);
  const e = g.enemies[0];
  e.tx = e.x = 8;
  e.ty = e.y = 6;
  g.player.face = 'R';
  g.step(DT, { dir: null, pump: true });
  run(g, 0.2);
  assert.strictEqual(e.state, 'inflated');
  run(g, 3);
  assert.notStrictEqual(e.state, 'inflated');
});

test('touching a walking enemy kills; an inflated one does not', () => {
  const g = arena();
  const e = g.enemies[0];
  e.x = e.tx = g.player.x + 0.3;
  e.y = e.ty = g.player.y;
  e.state = 'inflated';
  e.inflate = 2;
  e.pumpT = 5;
  g.step(DT, { dir: null, pump: false });
  assert.strictEqual(g.state, 'play');
  e.state = 'walk';
  g.step(DT, { dir: null, pump: false });
  assert.strictEqual(g.state, 'dying');
});

test('rock drops after dirt below is dug, crushes enemies, pays the table', () => {
  const g = arena();
  g.carve([[3, 5], [3, 6], [3, 7], [3, 8]]);
  const e = g.enemies[0];
  e.x = e.tx = 3;
  e.y = e.ty = 6;
  e.state = 'inflated';
  e.inflate = 3;
  e.pumpT = 99;
  g.rocks = [{ id: 0, x: 3, y: 4, state: 'idle', timer: 0, toRow: 4, carried: [] }];
  g.fine.fill(0, 0, 0);
  run(g, 3);
  assert.strictEqual(g.rocks[0].state, 'dead');
  assert.strictEqual(e.state, 'dead');
  assert.strictEqual(g.score, 1000);
});

test('rock waits while the player stands right under it', () => {
  const g = arena();
  g.carve([[3, 5], [4, 5], [5, 5]]);
  g.rocks = [{ id: 0, x: 3, y: 4, state: 'idle', timer: 0, toRow: 4, carried: [] }];
  g.player.x = 3;
  g.player.y = 5;
  run(g, 1);
  assert.strictEqual(g.rocks[0].state, 'idle');
  run(g, 0.5, { dir: 'R' });
  assert.notStrictEqual(g.rocks[0].state, 'idle');
});

test('player cannot walk into a resting rock', () => {
  const g = arena();
  g.rocks = [{ id: 0, x: 6, y: 8, state: 'idle', timer: 0, toRow: 8, carried: [] }];
  run(g, 2, { dir: 'D' });
  assert.ok(g.player.y <= 7.1, `stopped above, at ${g.player.y}`);
});

test('falling rock kills the player and costs a life', () => {
  const g = arena();
  g.carve([[3, 5], [3, 6], [3, 7]]);
  g.rocks = [{ id: 0, x: 3, y: 4, state: 'wiggle', timer: 0.01, toRow: 4, carried: [] }];
  g.player.x = 3;
  g.player.y = 7;
  const before = g.lives;
  run(g, 4);
  assert.strictEqual(g.lives, before - 1);
  assert.ok(['ready', 'play'].includes(g.state));
});

test('fire reaches through dirt along the row, not across rows', () => {
  const g = arena();
  const e = g.enemies[0];
  e.type = 'cinder';
  e.x = e.tx = START.x + 2;
  e.y = e.ty = START.y;
  e.state = 'breathe';
  e.face = -1;
  e.timer = 1;
  e.flameLen = 0;
  g.player.y = START.y + 1;
  g.player.x = START.x;
  run(g, 0.3);
  assert.strictEqual(g.state, 'play', 'other row is safe');
  g.player.y = START.y;
  g.player.x = START.x;
  e.x = START.x + 2;
  run(g, 0.2);
  assert.strictEqual(g.state, 'dying');
});

test('ghost crosses dirt to reach a player in another tunnel', () => {
  const g = arena();
  g.enemies.pop();
  const e = g.enemies[0];
  g.enemies.push(g.makeEnemy('puff', 1, 11, 9)); // keep two alive so nobody flees
  g.enemies[1].ghostT = 999;
  e.ghostT = 0;
  run(g, 0.05);
  assert.strictEqual(e.state, 'ghost');
  const d0 = Math.hypot(e.x - g.player.x, e.y - g.player.y);
  run(g, 0.5);
  assert.ok(Math.hypot(e.x - g.player.x, e.y - g.player.y) < d0, 'closing in');
});

test('last enemy runs for the surface and clears the round when it escapes', () => {
  const g = arena();
  g.player.x = 13;
  g.player.y = 12;
  g.enemies[1].state = 'dead';
  g.updateFleeFlag();
  assert.ok(g.enemies[0].flee);
  // 6 rows up and 11 tiles across at 2.8 tiles/s, before the next round replaces the list.
  run(g, 7);
  assert.strictEqual(g.enemies[0].state, 'dead');
  assert.strictEqual(g.state, 'clear');
  assert.strictEqual(g.score, 0, 'an escape pays nothing');
});

test('round advances after all enemies are gone', () => {
  const g = arena();
  g.enemies.forEach((e) => { e.state = 'dead'; });
  run(g, 3);
  assert.strictEqual(g.round, 2);
});

test('extra life at 10,000 then at 40,000', () => {
  const g = arena();
  const start = g.lives;
  g.addScore(10000);
  assert.strictEqual(g.lives, start + 1);
  g.addScore(20000);
  assert.strictEqual(g.lives, start + 1);
  g.addScore(10000);
  assert.strictEqual(g.lives, start + 2);
});

test('game ends when the last life goes', () => {
  const g = arena();
  g.lives = 1;
  g.killPlayer('caught');
  run(g, 2.1);
  assert.strictEqual(g.state, 'over');
});

test('a random-input soak never leaves the field or throws', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const g = new Game(seed);
    g.newGame();
    const rand = (() => { let s = seed * 97; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
    let dir = null;
    for (let i = 0; i < 60 * 240; i++) {
      if (i % 25 === 0) dir = [null, 'U', 'D', 'L', 'R', 'D', 'L'][Math.floor(rand() * 7)];
      g.step(DT, { dir, pump: rand() < 0.3 });
      g.drainEvents();
      const p = g.player;
      assert.ok(p.x >= 0 && p.x <= COLS - 1 && p.y >= 0 && p.y <= ROWS - 1 + 0.6);
      assert.ok(Math.abs(p.x - Math.round(p.x)) < 1e-3 || Math.abs(p.y - Math.round(p.y)) < 1e-3 || p.dead, 'on a lane');
      if (g.state === 'over') g.newGame();
    }
  }
});
