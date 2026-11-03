// Regenerates the README images: staged scenes drawn by the real renderer, plus level thumbnails.
//
//   NODE_PATH=$(npm root -g) node scripts/capture-screenshots.js
//
// Needs Playwright (npm i -g playwright), Chrome and ImageMagick's `convert`.
const { chromium } = require('playwright');
const { execFileSync } = require('node:child_process');
const { mkdirSync } = require('node:fs');
const { join, resolve } = require('node:path');

const root = resolve(__dirname, '..');
const outDir = join(root, 'docs/screenshots');
const levelDir = join(outDir, 'levels');
const thumbDir = join(levelDir, 'thumbs');
const LEVELS = ['01-dawn', '02-noon', '03-dusk', '04-night'];

// Runs in the page. Freezes the rules so each scene holds still for its picture.
function installStage() {
  const { game: g, renderer: r } = window.__undermine;
  r.lowerQuality = () => false; // keep pictures sharp on slow capture machines
  const flush = () => { for (const ev of g.drainEvents()) r.onEvent(ev, g); };
  const dig = (cells) => {
    g.carve(cells);
    for (const rock of g.rocks) {
      if (cells.some(([x, y]) => x === rock.x && y === rock.y)) rock.state = 'dead';
    }
  };
  const row = (y, a, b) => {
    const cells = [];
    for (let x = Math.min(a, b); x <= Math.max(a, b); x++) cells.push([x, y]);
    return cells;
  };
  const col = (x, a, b) => {
    const cells = [];
    for (let y = Math.min(a, b); y <= Math.max(a, b); y++) cells.push([x, y]);
    return cells;
  };
  const begin = (round, score) => {
    delete g.step;
    g.lives = 3;
    g.nextLife = 1e9;
    g.startRound(round);
    g.score = score;
    g.hi = Math.max(g.hi, score + 5200);
    g.state = 'play';
    g.step = () => {};
    r.irisOpening = false;
    flush();
  };
  // The miner has tunnelled over from the start and is pumping a puff.
  const pumpScene = (stage) => {
    const e = g.enemies.find((n) => n.type === 'puff');
    const side = e.x >= 4 ? -1 : 1;
    const px = e.x + side * 3;
    dig(col(6, 6, e.y));
    dig(row(e.y, 6, px));
    dig(row(e.y, px, e.x));
    Object.assign(e, { state: 'inflated', inflate: stage, pumpT: 99, tx: e.x, ty: e.y });
    Object.assign(g.player, {
      x: px, y: e.y, face: side < 0 ? 'R' : 'L',
      pump: { state: 'hold', len: 2.7, target: e, timer: 0.2, gap: 0 },
    });
    return e;
  };
  const breathe = (c, len) => {
    const face = c.x > 6 ? -1 : 1;
    dig(row(c.y, c.x, c.x + face * 4));
    Object.assign(c, { state: 'breathe', face, flameLen: len, timer: 99, tx: c.x, ty: c.y });
    return c;
  };
  window.__stage = {
    level(round) {
      begin(round, 1400 * round);
      pumpScene(2.2);
      const c = g.enemies.find((n) => n.type === 'cinder');
      if (c) breathe(c, 3);
      flush();
    },
    hero() {
      begin(1, 8600);
      pumpScene(2.8);
      breathe(g.enemies.find((n) => n.type === 'cinder'), 3.2);
      const ghost = g.enemies.find((n) => n.type === 'puff' && n.state === 'walk');
      Object.assign(ghost, { state: 'ghost', x: 3.4, y: 4.4, timer: 0, face: 1 });
      g.veg = { x: 6, y: 6, t: 99, kind: 0 };
      flush();
    },
    fire() {
      begin(3, 12300);
      const c = g.enemies.find((n) => n.type === 'cinder');
      breathe(c, 3.2);
      const px = c.x + c.face * 5;
      dig(row(c.y, c.x, px));
      dig(col(6, 6, c.y));
      dig(row(c.y, 6, px));
      Object.assign(g.player, { x: px, y: c.y, face: c.face < 0 ? 'R' : 'L' });
      flush();
    },
    rock() {
      begin(2, 6100);
      // Pick the rock with the emptiest ground below it, so the drop reads clearly.
      const clutter = (n) => g.enemies.filter((m) => Math.abs(m.x - n.x) < 4 && m.y > n.y - 1 && m.y < n.y + 7).length
        + (Math.abs(n.x - 6) < 2 ? 5 : 0) + (n.y > 6 ? 5 : 0);
      const rock = [...g.rocks].sort((a, b) => clutter(a) - clutter(b))[0];
      const e = g.enemies.find((m) => m.type === 'puff');
      dig(col(rock.x, rock.y + 1, rock.y + 5));
      const side = rock.x > 6 ? -1 : 1;
      const floor = rock.y + 4;
      dig(row(floor, rock.x, rock.x + side * 3));
      rock.state = 'fall';
      rock.y += 2.2;
      rock.carried = [e];
      Object.assign(e, { state: 'crushed', x: rock.x, y: rock.y + 0.55, carriedBy: rock });
      Object.assign(g.player, { x: rock.x + side * 3, y: floor, face: side < 0 ? 'R' : 'L' });
      r.crumbs(rock.x, rock.y - 0.5, 16, 0.8);
      flush();
    },
    pop() {
      begin(4, 24800);
      const e = pumpScene(3);
      flush();
      e.state = 'dead';
      g.player.pump = { state: 'ret', len: 2.2, target: null, timer: 0, gap: 0 };
      r.onEvent({ t: 'pop', x: e.x, y: e.y, type: e.type }, g);
      r.onEvent({ t: 'score', x: e.x, y: e.y, pts: g.pointsFor(e) }, g);
      // Slow the burst down: capture machines may render only a few frames a second.
      for (const p of r.particles) {
        p.life *= 6;
        p.max *= 6;
        p.vx *= 0.3;
        p.vy *= 0.3;
        p.size *= 1.3;
      }
    },
  };
}

(async () => {
  mkdirSync(thumbDir, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // A fixed seed gives the same layouts on every capture.
  await page.addInitScript(() => {
    Date.now = () => 20261103;
    let s = 42;
    Math.random = () => {
      s = (s * 16807) % 2147483647;
      return s / 2147483647;
    };
  });
  await page.goto('file://' + join(root, 'index.html'));
  await page.evaluate(() => window.__undermine.renderer.finishTitle());
  await page.evaluate(installStage);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(outDir, 'title.png') });

  const shoot = async (fn, arg, path, wait = 700) => {
    await page.evaluate(([f, a]) => window.__stage[f](a), [fn, arg]);
    await page.waitForTimeout(wait);
    await page.screenshot({ path });
  };
  await shoot('hero', null, join(outDir, 'gameplay.png'));
  await shoot('fire', null, join(outDir, 'fire.png'));
  await shoot('rock', null, join(outDir, 'rock.png'));
  await shoot('pop', null, join(outDir, 'pop.png'), 350);
  for (let i = 0; i < LEVELS.length; i++) {
    const file = join(levelDir, LEVELS[i] + '.png');
    await shoot('level', i + 1, file);
    execFileSync('convert', [file, '-resize', '400x', '-strip', '-quality', '85', join(thumbDir, LEVELS[i] + '.jpg')]);
  }
  await browser.close();
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('done');
})();
