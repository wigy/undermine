// Everything visual. Soil is painted once per round from a procedural height field, then tunnels
// are erased from it. Each frame composites sky, back wall, cast shadow, soil, sprites, a multiplied
// light map and an additive bloom pass.
(function (root) {
  const { COLS } = root.Sim;
  const Font = root.Font;
  const GROUND_Y = 0.5; // top of the soil, in tile coordinates
  const FIELD_TOP = -2.5;
  const FIELD_BOTTOM = 12.5;

  const BIOMES = [
    {
      name: 'dawn',
      sky: ['#27457a', '#8d6a96', '#ee9a72', '#ffdc9c'],
      sun: { x: 10.4, y: -0.4, r: 0.8, color: '#fff2c4', glow: 'rgba(255,190,120,' },
      hills: ['#b98a95', '#8d6f8a', '#5a5a74'],
      grass: ['#6eae3e', '#3f7d2c'],
      strata: [[118, 76, 46], [176, 122, 60], [146, 70, 46], [66, 52, 96]],
      ambient: [0.86, 0.56],
      accent: [255, 214, 130],
      deep: 'amethyst',
    },
    {
      name: 'noon',
      sky: ['#1668c2', '#3f9be0', '#8fd2ef', '#d9f2f4'],
      sun: { x: 3.2, y: -1.5, r: 0.6, color: '#fffbe6', glow: 'rgba(255,250,210,' },
      hills: ['#a3d4d0', '#6db59a', '#3f8f66'],
      grass: ['#8bd03f', '#4f9a2c'],
      strata: [[102, 66, 42], [200, 164, 100], [62, 116, 108], [38, 50, 100]],
      ambient: [0.92, 0.54],
      accent: [190, 255, 235],
      deep: 'aquamarine',
    },
    {
      name: 'dusk',
      sky: ['#21154a', '#6e2a78', '#cf4a6a', '#ffab5e'],
      sun: { x: 4.4, y: 0.1, r: 1.05, color: '#ffd28a', glow: 'rgba(255,120,80,' },
      hills: ['#8c3a6a', '#5c2860', '#321a48'],
      grass: ['#a39a3a', '#5f6226'],
      strata: [[136, 60, 62], [196, 100, 52], [116, 36, 46], [44, 26, 42]],
      ambient: [0.8, 0.46],
      accent: [255, 150, 70],
      deep: 'lava',
    },
    {
      name: 'night',
      sky: ['#050a22', '#0f1c4a', '#223a70', '#4a6a96'],
      sun: { x: 11.2, y: -1.8, r: 0.55, color: '#eef4ff', glow: 'rgba(170,200,255,' },
      hills: ['#2c4470', '#1c2f56', '#111f3e'],
      grass: ['#6fb3a6', '#2f6b6a'],
      strata: [[96, 88, 116], [68, 96, 126], [88, 66, 118], [30, 36, 76]],
      ambient: [0.62, 0.4],
      accent: [150, 225, 255],
      deep: 'ice',
      stars: true,
    },
  ];
  const DEEP_COLORS = {
    amethyst: ['#caa2ff', '#7b4fd0'],
    aquamarine: ['#9dffe6', '#2aa59a'],
    lava: ['#ffc06a', '#e8431f'],
    ice: ['#cdf3ff', '#5fb4e8'],
  };

  // ---- noise ------------------------------------------------------------
  const PERM = new Uint8Array(512);
  const hash2 = (x, y) => PERM[(PERM[x & 255] + y) & 255] / 255;
  function seedNoise(seed) {
    let s = seed >>> 0 || 1;
    const p = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) {
      s = (Math.imul(s, 48271) & 0x7fffffff) >>> 0;
      const j = s % (i + 1);
      [p[i], p[j]] = [p[j], p[i]];
    }
    for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
  }
  function vnoise(x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const u = fx * fx * (3 - 2 * fx);
    const v = fy * fy * (3 - 2 * fy);
    const a = hash2(xi, yi);
    const b = hash2(xi + 1, yi);
    const c = hash2(xi, yi + 1);
    const d = hash2(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function fbm(x, y, oct) {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    for (let i = 0; i < oct; i++) {
      sum += amp * vnoise(x, y);
      norm += amp;
      amp *= 0.5;
      x = x * 2.03 + 17.1;
      y = y * 2.03 - 9.3;
    }
    return sum / norm;
  }
  // Returns [F1, F2] distances to the two nearest jittered points.
  const WORLEY = [0, 0];
  function worley(x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    let f1 = 9;
    let f2 = 9;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = xi + dx;
        const cy = yi + dy;
        const px = cx + hash2(cx, cy);
        const py = cy + hash2(cy + 31, cx + 57);
        const d = (px - x) * (px - x) + (py - y) * (py - y);
        if (d < f1) {
          f2 = f1;
          f1 = d;
        } else if (d < f2) {
          f2 = d;
        }
      }
    }
    WORLEY[0] = Math.sqrt(f1);
    WORLEY[1] = Math.sqrt(f2);
    return WORLEY;
  }
  const smooth = (a, b, x) => {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  function rngFrom(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const makeCanvas = (w, h) => {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  };

  // ---- renderer ----------------------------------------------------------
  class Renderer {
    constructor(canvas, reducedMotion) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: false });
      this.reducedMotion = reducedMotion;
      this.particles = [];
      this.floats = [];
      this.shake = 0;
      this.flash = 0;
      this.stampLog = [];
      this.biomeIndex = 0;
      this.worldSeed = 1;
      this.needsEdges = true;
      this.edgeWait = 0;
      this.time = 0;
      this.glints = [];
      this.clouds = [];
      this.rockShapes = new Map();
      this.title = null;
      this.quality = 1;
      this.resize();
    }

    // Trades sharpness for frame rate; the canvas is stretched back up by CSS.
    lowerQuality() {
      if (this.quality <= 0.55) return false;
      this.quality = this.quality > 0.8 ? 0.75 : 0.55;
      this.resize();
      return true;
    }

    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      let w = window.innerWidth * dpr * this.quality;
      let h = window.innerHeight * dpr * this.quality;
      const cap = Math.sqrt(3200000 / (w * h));
      if (cap < 1) {
        w *= cap;
        h *= cap;
      }
      this.W = Math.round(w);
      this.H = Math.round(h);
      this.canvas.width = this.W;
      this.canvas.height = this.H;
      const wide = this.W / this.H > 1.2;
      this.wide = wide;
      if (wide) {
        this.s = Math.min(this.H / 15.3, this.W / 23);
        this.ox = (this.W - 14 * this.s) / 2;
        this.oy = (this.H - 15 * this.s) / 2;
      } else {
        this.s = Math.min(this.W / 14.3, this.H / 18);
        this.ox = (this.W - 14 * this.s) / 2;
        this.oy = Math.max(1.9 * this.s, (this.H - 16.9 * this.s) / 2 + 1.9 * this.s);
      }
      this.fx = makeCanvas(this.W / 2, this.H / 2);
      this.fxCtx = this.fx.getContext('2d');
      this.bloomA = makeCanvas(this.W / 8, this.H / 8);
      this.bloomACtx = this.bloomA.getContext('2d');
      this.bloomB = makeCanvas(this.W / 16, this.H / 16);
      this.bloomBCtx = this.bloomB.getContext('2d');
      this.light = makeCanvas(this.W / 3, this.H / 3);
      this.lightCtx = this.light.getContext('2d');
      this.titleTint = null;
      this.buildWorld();
    }

    // Tile space → canvas pixels for a context of `scale` × the main canvas.
    apply(ctx, scale = 1) {
      const s = this.s * scale;
      ctx.setTransform(s, 0, 0, s, (this.ox + 0.5 * this.s) * scale, (this.oy + 2.5 * this.s) * scale);
    }
    sx(x) { return this.ox + (x + 0.5) * this.s; }
    sy(y) { return this.oy + (y + 2.5) * this.s; }

    setRound(round, seed) {
      this.biomeIndex = (round - 1) % BIOMES.length;
      this.worldSeed = seed + round * 101;
      this.stampLog = [];
      this.rockShapes.clear();
      this.particles.length = 0;
      this.floats.length = 0;
      this.title = null;
      this.irisOpening = true;
      this.buildWorld();
    }

    // ---- world painting ------------------------------------------------
    buildWorld() {
      const biome = BIOMES[this.biomeIndex];
      seedNoise(this.worldSeed);
      this.buildSky(biome);
      this.buildSoil(biome);
      this.buildAmbient(biome);
      this.buildFrame();
      const log = this.stampLog;
      this.holes = makeCanvas(this.W, this.H);
      this.holesCtx = this.holes.getContext('2d');
      this.apply(this.holesCtx);
      this.holesCtx.fillStyle = '#fff';
      this.soilCtx = this.soil.getContext('2d');
      this.apply(this.soilCtx);
      for (const st of log) this.eraseAt(st.x, st.y, st.r);
      this.edges = makeCanvas(this.W, this.H);
      this.edgesCtx = this.edges.getContext('2d');
      this.tmp = makeCanvas(this.W, this.H);
      this.tmpCtx = this.tmp.getContext('2d');
      this.shadow = makeCanvas(this.W / 6, this.H / 6);
      this.shadowCtx = this.shadow.getContext('2d');
      this.shadowSmall = makeCanvas(this.W / 14, this.H / 14);
      this.shadowSmallCtx = this.shadowSmall.getContext('2d');
      this.needsEdges = true;
      this.ambientMotes(biome);
    }

    buildSky(b) {
      const c = makeCanvas(this.W, this.H);
      const g = c.getContext('2d');
      const horizon = this.sy(GROUND_Y);
      const grad = g.createLinearGradient(0, 0, 0, horizon);
      grad.addColorStop(0, b.sky[0]);
      grad.addColorStop(0.45, b.sky[1]);
      grad.addColorStop(0.8, b.sky[2]);
      grad.addColorStop(1, b.sky[3]);
      g.fillStyle = grad;
      g.fillRect(0, 0, this.W, horizon + 4);
      const rng = rngFrom(this.worldSeed ^ 0x51ed);
      if (b.stars) {
        for (let i = 0; i < 260; i++) {
          const y = rng() * horizon * 0.85;
          g.fillStyle = `rgba(255,255,255,${0.2 + rng() * 0.7})`;
          const r = rng() < 0.08 ? 1.6 : 0.8;
          g.beginPath();
          g.arc(rng() * this.W, y, r * Math.max(1, this.s / 50), 0, 7);
          g.fill();
        }
      }
      this.apply(g);
      const sun = b.sun;
      const glow = g.createRadialGradient(sun.x, sun.y, sun.r * 0.5, sun.x, sun.y, sun.r * 6);
      glow.addColorStop(0, sun.glow + '0.65)');
      glow.addColorStop(0.35, sun.glow + '0.2)');
      glow.addColorStop(1, sun.glow + '0)');
      g.fillStyle = glow;
      g.fillRect(sun.x - sun.r * 6, sun.y - sun.r * 6, sun.r * 12, sun.r * 12);
      g.fillStyle = sun.color;
      g.beginPath();
      g.arc(sun.x, sun.y, sun.r, 0, 7);
      g.fill();
      if (b.stars) {
        // Moon craters and terminator
        g.fillStyle = 'rgba(150,170,210,0.35)';
        for (const [dx, dy, r] of [[-0.2, -0.1, 0.12], [0.18, 0.16, 0.09], [0.05, -0.28, 0.07]]) {
          g.beginPath();
          g.arc(sun.x + dx, sun.y + dy, r, 0, 7);
          g.fill();
        }
      }
      // Three ranges of hills, nearer ones darker and more detailed.
      const left = -this.ox / this.s - 1;
      const right = (this.W - this.ox) / this.s;
      b.hills.forEach((color, i) => {
        const base = -0.9 + i * 0.55;
        const amp = 1.0 - i * 0.22;
        g.fillStyle = color;
        g.beginPath();
        g.moveTo(left, GROUND_Y + 0.2);
        for (let x = left; x <= right + 0.2; x += 0.12) {
          const n = fbm(x * (0.22 + i * 0.1) + i * 9, i * 3.3, 4);
          g.lineTo(x, base + (0.5 - n) * amp * 2.2);
        }
        g.lineTo(right + 0.2, GROUND_Y + 0.2);
        g.closePath();
        g.fill();
        if (i === 2) this.paintTrees(g, rng, left, right, base, amp, color);
      });
      this.sky = c;
      this.clouds = [];
      const span = right - left;
      for (let i = 0; i < 7; i++) {
        this.clouds.push({
          x: left + rng() * span,
          y: -2.3 + rng() * 1.5,
          w: 1 + rng() * 1.6,
          speed: 0.05 + rng() * 0.09,
          sprite: this.cloudSprite(b, rng),
        });
      }
      this.skyLeft = left;
      this.skySpan = span + 4;
    }

    paintTrees(g, rng, left, right, base, amp, color) {
      for (let x = left; x < right; x += 0.45 + rng() * 1.3) {
        const n = fbm(x * 0.42 + 18, 6.6, 4);
        const y = base + (0.5 - n) * amp * 2.2;
        const h = 0.3 + rng() * 0.45;
        g.fillStyle = color;
        g.beginPath();
        g.moveTo(x - h * 0.34, y + 0.06);
        g.lineTo(x, y - h);
        g.lineTo(x + h * 0.34, y + 0.06);
        g.closePath();
        g.fill();
      }
    }

    cloudSprite(b, rng) {
      const size = Math.ceil(this.s * 2.4);
      const c = makeCanvas(size, size * 0.6);
      const g = c.getContext('2d');
      const tint = b.stars ? '150,175,220' : b.name === 'dusk' ? '255,170,150' : b.name === 'dawn' ? '255,226,205' : '255,255,255';
      for (let i = 0; i < 14; i++) {
        const t = i / 13;
        const x = size * (0.16 + t * 0.68) + (rng() - 0.5) * size * 0.05;
        const y = size * 0.36 - Math.sin(t * Math.PI) * size * 0.1 * rng();
        const r = size * (0.05 + Math.sin(t * Math.PI) * 0.11 * (0.6 + rng() * 0.5));
        const grad = g.createRadialGradient(x, y, 0, x, y, r);
        const a = b.stars ? 0.22 : 0.45;
        grad.addColorStop(0, `rgba(${tint},${a})`);
        grad.addColorStop(1, `rgba(${tint},0)`);
        g.fillStyle = grad;
        g.fillRect(x - r, y - r, r * 2, r * 2);
      }
      return c;
    }

    buildSoil(b) {
      const res = Math.min(0.6, Math.sqrt(800000 / (this.W * this.H)));
      const pw = Math.ceil(this.W * res);
      const ph = Math.ceil(this.H * res);
      const heights = new Float32Array(pw * ph);
      const bands = new Int8Array(pw * ph);
      const mix = new Float32Array(pw * ph);
      const lows = new Float32Array(pw * ph);
      const top = GROUND_Y - 0.1;
      const toX = 1 / (res * this.s);
      const x0 = -this.ox / this.s - 0.5;
      const y0 = -this.oy / this.s - 2.5;

      for (let py = 0; py < ph; py++) {
        const wy = y0 + py * toX;
        if (wy < top) continue;
        for (let px = 0; px < pw; px++) {
          const wx = x0 + px * toX;
          const i = py * pw + px;
          const warp = (fbm(wx * 0.32 + 3.1, wy * 0.32, 3) - 0.5) * 1.3;
          const pos = Math.max(0, (wy - GROUND_Y + warp) / 3);
          const band = Math.min(3, Math.floor(pos));
          const frac = pos - band;
          const n1 = fbm(wx * 0.9, wy * 0.9, 3);
          const n2 = fbm(wx * 4.3, wy * 4.3, 3);
          lows[i] = n1;
          bands[i] = band;
          mix[i] = band < 3 ? smooth(0.93, 1, frac) : 0;
          let h;
          if (band === 0) {
            const w = worley(wx * 3.4, wy * 3.4);
            h = 0.55 * (1 - Math.min(1, w[0] * 1.2)) + 0.35 * n2 + 0.1 * n1;
          } else if (band === 1) {
            const streak = vnoise(wx * 0.9 + n1 * 2, wy * 11);
            const w = worley(wx * 7, wy * 7);
            h = 0.55 * streak + 0.3 * n2 + 0.15 * (1 - Math.min(1, w[0]));
          } else if (band === 2) {
            const w = worley(wx * 2.4 + n1, wy * 2.4);
            const crack = smooth(0.0, 0.1, w[1] - w[0]);
            h = 0.62 * crack + 0.28 * n2 + 0.1 * n1;
          } else {
            const w = worley(wx * 1.5 + n1 * 0.7, wy * 1.5);
            const facet = 1 - Math.min(1, w[0]);
            const crack = smooth(0.0, 0.07, w[1] - w[0]);
            h = 0.42 * facet + 0.3 * crack + 0.28 * n2;
          }
          heights[i] = h;
        }
      }

      const soilImg = new ImageData(pw, ph);
      const wallImg = new ImageData(pw, ph);
      const sd = soilImg.data;
      const wd = wallImg.data;
      const strata = b.strata;
      const lx = -0.6;
      const ly = -0.8;
      for (let py = 1; py < ph - 1; py++) {
        const wy = y0 + py * toX;
        if (wy < top) continue;
        for (let px = 1; px < pw - 1; px++) {
          const wx = x0 + px * toX;
          const i = py * pw + px;
          const edgeNoise = 0.03 * (vnoise(wx * 7, 3.7) - 0.5);
          const alpha = smooth(GROUND_Y - 0.03, GROUND_Y + 0.01, wy + edgeNoise);
          if (alpha <= 0) continue;
          const band = bands[i];
          const m = mix[i];
          const c0 = strata[band];
          const c1 = strata[Math.min(3, band + 1)];
          let r = c0[0] + (c1[0] - c0[0]) * m;
          let g = c0[1] + (c1[1] - c0[1]) * m;
          let bl = c0[2] + (c1[2] - c0[2]) * m;
          const low = lows[i];
          const tone = 0.82 + 0.42 * low;
          const h = heights[i];
          const hx = heights[i + 1] - heights[i - 1];
          const hy = heights[i + pw] - heights[i - pw];
          const slope = hx * lx + hy * ly;
          const L = Math.max(0.2, Math.min(1.75, tone * (0.72 + 0.6 * (h - 0.45)) + slope * 3.2));
          // Shadows lean cool, highlights lean warm.
          const warm = (L - 0.9) * 0.14;
          r *= L * (1 + warm);
          g *= L;
          bl *= L * (1 - warm);
          const k = i * 4;
          sd[k] = Math.min(255, r);
          sd[k + 1] = Math.min(255, g);
          sd[k + 2] = Math.min(255, bl);
          sd[k + 3] = 255 * alpha;
          // Back wall: same strata, far darker and bluer.
          const wL = 0.36 + 0.24 * h + 0.1 * low;
          wd[k] = (c0[0] * 0.8 + 8) * wL;
          wd[k + 1] = (c0[1] * 0.75 + 8) * wL;
          wd[k + 2] = (c0[2] * 0.85 + 22) * wL;
          wd[k + 3] = 255;
        }
      }
      const small = makeCanvas(pw, ph);
      const sg = small.getContext('2d');
      sg.putImageData(soilImg, 0, 0);
      const wallSmall = makeCanvas(pw, ph);
      wallSmall.getContext('2d').putImageData(wallImg, 0, 0);

      this.soil = makeCanvas(this.W, this.H);
      const s = this.soil.getContext('2d');
      s.imageSmoothingQuality = 'high';
      s.drawImage(small, 0, 0, this.W, this.H);
      this.wall = makeCanvas(this.W, this.H);
      const wc = this.wall.getContext('2d');
      wc.imageSmoothingQuality = 'high';
      wc.drawImage(wallSmall, 0, 0, this.W, this.H);

      this.grain(s);
      this.paintSoilDetail(s, b);
      this.paintGrass(s, b);
    }

    grain(s) {
      // Fine speckle at device resolution, since the height field above is sampled coarser.
      const size = 256;
      const c = makeCanvas(size, size);
      const g = c.getContext('2d');
      const img = g.createImageData(size, size);
      let seed = 12345;
      for (let i = 0; i < img.data.length; i += 4) {
        seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
        const v = (seed >> 16) & 255;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 34;
      }
      g.putImageData(img, 0, 0);
      s.save();
      s.globalCompositeOperation = 'source-atop';
      s.fillStyle = s.createPattern(c, 'repeat');
      s.globalCompositeOperation = 'overlay';
      s.fillRect(0, 0, this.W, this.H);
      s.restore();
      // Overlay can tint the transparent sky band; clean it.
      s.save();
      s.globalCompositeOperation = 'destination-out';
      s.setTransform(1, 0, 0, 1, 0, 0);
      s.fillStyle = '#000';
      s.fillRect(0, 0, this.W, this.sy(GROUND_Y - 0.04));
      s.restore();
    }

    paintSoilDetail(s, b) {
      const rng = rngFrom(this.worldSeed ^ 0x77aa);
      this.apply(s);
      const left = -this.ox / this.s - 0.5;
      const right = (this.W - this.ox) / this.s - 0.5;
      const bottom = (this.H - this.oy) / this.s - 2.5;
      const area = (right - left) * (bottom - GROUND_Y);

      this.paintRoots(s, rng, left, right);

      // Pebbles embedded in the soil, each with its own contact shadow.
      const pebbleCount = Math.floor(area * 1.5);
      for (let i = 0; i < pebbleCount; i++) {
        const x = left + rng() * (right - left);
        const y = GROUND_Y + 0.25 + rng() * (bottom - GROUND_Y - 0.25);
        const r = 0.035 + rng() * rng() * 0.13;
        const rot = rng() * 3.14;
        const hue = 25 + rng() * 25;
        const light = 45 + rng() * 25;
        s.save();
        s.translate(x, y);
        s.rotate(rot);
        s.fillStyle = 'rgba(15,8,12,0.45)';
        s.beginPath();
        s.ellipse(r * 0.18, r * 0.22, r * 1.1, r * 0.78, 0, 0, 7);
        s.fill();
        const g = s.createRadialGradient(-r * 0.35, -r * 0.35, 0, 0, 0, r * 1.2);
        g.addColorStop(0, `hsl(${hue},14%,${light + 18}%)`);
        g.addColorStop(1, `hsl(${hue + 200},10%,${light - 22}%)`);
        s.fillStyle = g;
        s.beginPath();
        s.ellipse(0, 0, r, r * 0.72, 0, 0, 7);
        s.fill();
        s.restore();
      }

      // Fossils in the middle strata.
      const fossils = Math.max(4, Math.floor(area * 0.035));
      for (let i = 0; i < fossils; i++) {
        const x = left + rng() * (right - left);
        const y = 3.6 + rng() * Math.max(1, bottom - 5);
        const size = 0.2 + rng() * 0.16;
        if (rng() < 0.55) this.paintAmmonite(s, x, y, size, rng() * 6.28);
        else this.paintBone(s, x, y, size * 1.5, rng() * 6.28);
      }

      // Crystal clusters and veins in the deepest stratum.
      this.glints = [];
      const colors = DEEP_COLORS[b.deep];
      const deepStart = 9.8;
      if (b.deep === 'lava') {
        this.paintLavaVeins(s, rng, left, right, deepStart, bottom);
      }
      const clusters = Math.max(6, Math.floor((right - left) * Math.max(1, bottom - deepStart) * 0.09));
      for (let i = 0; i < clusters; i++) {
        const x = left + rng() * (right - left);
        const y = deepStart + rng() * Math.max(0.5, bottom - deepStart);
        this.paintCrystals(s, rng, x, y, colors);
        if (x > -0.5 && x < COLS - 0.5) this.glints.push({ x, y, phase: rng() * 6.28, color: colors[0] });
      }
    }

    paintRoots(s, rng, left, right) {
      s.lineCap = 'round';
      const branch = (x, y, angle, len, w, depth) => {
        s.lineWidth = w;
        s.strokeStyle = `rgba(${44 + depth * 8},${28 + depth * 5},${20 + depth * 2},0.75)`;
        s.beginPath();
        s.moveTo(x, y);
        let px = x;
        let py = y;
        for (let i = 0; i < 5; i++) {
          angle += (rng() - 0.5) * 0.6;
          px += Math.cos(angle) * (len / 5);
          py += Math.sin(angle) * (len / 5);
          s.lineTo(px, py);
        }
        s.stroke();
        if (depth > 0) {
          const kids = 1 + Math.floor(rng() * 2);
          for (let k = 0; k < kids; k++) {
            branch(px, py, angle + (rng() - 0.5) * 1.4, len * 0.65, w * 0.65, depth - 1);
          }
        }
      };
      for (let x = left; x < right; x += 0.8 + rng() * 1.8) {
        branch(x, GROUND_Y + 0.02, Math.PI / 2 + (rng() - 0.5) * 0.5, 0.5 + rng() * 0.5, 0.045, 2);
      }
    }

    paintAmmonite(s, x, y, size, rot) {
      s.save();
      s.translate(x, y);
      s.rotate(rot);
      s.fillStyle = 'rgba(232,214,180,0.2)';
      s.beginPath();
      s.arc(0, 0, size, 0, 7);
      s.fill();
      s.strokeStyle = 'rgba(244,228,196,0.55)';
      s.lineWidth = size * 0.07;
      s.beginPath();
      for (let a = 0; a < 15; a += 0.2) {
        const r = size * (a / 15);
        const px = Math.cos(a) * r;
        const py = Math.sin(a) * r;
        if (a === 0) s.moveTo(px, py);
        else s.lineTo(px, py);
      }
      s.stroke();
      s.strokeStyle = 'rgba(30,16,20,0.35)';
      s.lineWidth = size * 0.04;
      for (let a = 3; a < 15; a += 0.55) {
        const r = size * (a / 15);
        s.beginPath();
        s.moveTo(Math.cos(a) * r * 0.76, Math.sin(a) * r * 0.76);
        s.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        s.stroke();
      }
      s.restore();
    }

    paintBone(s, x, y, size, rot) {
      s.save();
      s.translate(x, y);
      s.rotate(rot);
      s.strokeStyle = 'rgba(238,224,192,0.5)';
      s.lineCap = 'round';
      s.lineWidth = size * 0.14;
      s.beginPath();
      s.moveTo(-size * 0.5, 0);
      s.lineTo(size * 0.5, 0);
      s.stroke();
      s.fillStyle = 'rgba(238,224,192,0.5)';
      for (const [dx, dy] of [[-0.5, -0.09], [-0.5, 0.09], [0.5, -0.09], [0.5, 0.09]]) {
        s.beginPath();
        s.arc(dx * size, dy * size, size * 0.12, 0, 7);
        s.fill();
      }
      s.restore();
    }

    paintCrystals(s, rng, x, y, colors) {
      const n = 3 + Math.floor(rng() * 4);
      const base = rng() * 6.28;
      for (let i = 0; i < n; i++) {
        const a = base + (i - n / 2) * 0.45;
        const len = 0.14 + rng() * 0.22;
        const w = 0.035 + rng() * 0.035;
        s.save();
        s.translate(x, y);
        s.rotate(a);
        const g = s.createLinearGradient(0, -w, 0, w);
        g.addColorStop(0, colors[0]);
        g.addColorStop(0.5, colors[1]);
        g.addColorStop(1, 'rgba(10,8,30,0.8)');
        s.fillStyle = g;
        s.beginPath();
        s.moveTo(0, -w);
        s.lineTo(len * 0.75, -w);
        s.lineTo(len, 0);
        s.lineTo(len * 0.75, w);
        s.lineTo(0, w);
        s.closePath();
        s.fill();
        s.restore();
      }
    }

    paintLavaVeins(s, rng, left, right, top, bottom) {
      s.lineCap = 'round';
      s.lineJoin = 'round';
      const n = Math.floor((right - left) * 0.8);
      for (let i = 0; i < n; i++) {
        let x = left + rng() * (right - left);
        let y = top + rng() * Math.max(0.5, bottom - top);
        let a = rng() * 6.28;
        const pts = [[x, y]];
        for (let k = 0; k < 6; k++) {
          a += (rng() - 0.5) * 1.4;
          x += Math.cos(a) * 0.26;
          y += Math.sin(a) * 0.26;
          pts.push([x, y]);
        }
        for (const [w, c] of [[0.09, 'rgba(232,67,31,0.35)'], [0.035, '#ffb05a']]) {
          s.lineWidth = w;
          s.strokeStyle = c;
          s.beginPath();
          pts.forEach(([px, py], j) => (j ? s.lineTo(px, py) : s.moveTo(px, py)));
          s.stroke();
        }
      }
    }

    paintGrass(s, b) {
      const rng = rngFrom(this.worldSeed ^ 0x1234);
      this.apply(s);
      const left = -this.ox / this.s - 0.5;
      const right = (this.W - this.ox) / this.s;
      // Turf lip across the soil's top edge.
      const lip = s.createLinearGradient(0, GROUND_Y - 0.03, 0, GROUND_Y + 0.16);
      lip.addColorStop(0, b.grass[0]);
      lip.addColorStop(1, b.grass[1]);
      s.fillStyle = lip;
      s.beginPath();
      s.moveTo(left, GROUND_Y - 0.02);
      for (let x = left; x <= right; x += 0.05) {
        s.lineTo(x, GROUND_Y + 0.1 + (vnoise(x * 6, 9.1) - 0.5) * 0.08);
      }
      s.lineTo(right, GROUND_Y - 0.02);
      s.closePath();
      s.fill();
      s.lineCap = 'round';
      for (let x = left; x < right; x += 0.022) {
        const h = 0.07 + rng() * 0.16;
        const lean = (rng() - 0.5) * 0.12;
        s.strokeStyle = rng() < 0.45 ? b.grass[0] : b.grass[1];
        s.lineWidth = 0.014 + rng() * 0.012;
        s.beginPath();
        s.moveTo(x, GROUND_Y + 0.03);
        s.quadraticCurveTo(x, GROUND_Y - h * 0.6, x + lean, GROUND_Y - h);
        s.stroke();
      }
    }

    buildAmbient(b) {
      const c = makeCanvas(this.light.width, this.light.height);
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, c.width, c.height);
      const toLight = (y) => this.sy(y) / 3;
      const grad = g.createLinearGradient(0, toLight(GROUND_Y), 0, toLight(FIELD_BOTTOM));
      const shade = (v) => {
        const r = Math.round(255 * v);
        const gr = Math.round(255 * v * 0.97);
        const bl = Math.round(255 * Math.min(1, v * 1.1));
        return `rgb(${r},${gr},${bl})`;
      };
      grad.addColorStop(0, shade(b.ambient[0]));
      grad.addColorStop(1, shade(b.ambient[1]));
      g.fillStyle = grad;
      g.fillRect(0, toLight(GROUND_Y + 0.02), c.width, c.height);
      this.ambient = c;
    }

    buildFrame() {
      // Soil and sky run past the field; this dims the overscan and adds a vignette.
      const c = makeCanvas(this.W, this.H);
      const g = c.getContext('2d');
      const left = this.sx(-0.5);
      const right = this.sx(COLS - 0.5);
      const fade = this.s * 2.2;
      const dim = 'rgba(6,4,14,0.5)';
      const clear = 'rgba(6,4,14,0)';
      let grad = g.createLinearGradient(left - fade, 0, left, 0);
      grad.addColorStop(0, dim);
      grad.addColorStop(1, clear);
      g.fillStyle = dim;
      g.fillRect(0, 0, Math.max(0, left - fade), this.H);
      g.fillStyle = grad;
      g.fillRect(left - fade, 0, fade, this.H);
      grad = g.createLinearGradient(right, 0, right + fade, 0);
      grad.addColorStop(0, clear);
      grad.addColorStop(1, dim);
      g.fillStyle = grad;
      g.fillRect(right, 0, fade, this.H);
      g.fillStyle = dim;
      g.fillRect(right + fade, 0, this.W, this.H);
      const bottom = this.sy(FIELD_BOTTOM);
      if (bottom < this.H) {
        grad = g.createLinearGradient(0, bottom, 0, bottom + fade);
        grad.addColorStop(0, clear);
        grad.addColorStop(1, dim);
        g.fillStyle = grad;
        g.fillRect(0, bottom, this.W, this.H - bottom);
      }
      const cx = this.W / 2;
      const cy = this.H / 2;
      const r = Math.hypot(cx, cy);
      const vig = g.createRadialGradient(cx, cy, r * 0.55, cx, cy, r);
      vig.addColorStop(0, 'rgba(4,2,10,0)');
      vig.addColorStop(1, 'rgba(4,2,10,0.5)');
      g.fillStyle = vig;
      g.fillRect(0, 0, this.W, this.H);
      this.frame = c;
    }

    ambientMotes() {
      this.motes = [];
      const rng = rngFrom(this.worldSeed ^ 0x9e37);
      for (let i = 0; i < 26; i++) {
        this.motes.push({ x: rng() * COLS - 0.5, y: 1 + rng() * 11, p: rng() * 6.28, sp: 0.04 + rng() * 0.07 });
      }
    }

    // ---- tunnels -----------------------------------------------------------
    eraseAt(x, y, r) {
      const s = this.soilCtx;
      s.globalCompositeOperation = 'destination-out';
      s.fillStyle = '#000';
      s.beginPath();
      s.arc(x, y, r, 0, 7);
      s.fill();
      s.globalCompositeOperation = 'source-over';
      const h = this.holesCtx;
      h.beginPath();
      h.arc(x, y, r, 0, 7);
      h.fill();
    }

    stamp(x, y, r) {
      this.stampLog.push({ x, y, r });
      this.eraseAt(x, y, r);
      this.needsEdges = true;
    }

    // Rebuilt only when a tunnel changes: lit floor lip, dark roof lip, and the shadow on the back wall.
    refreshEdges() {
      const W = this.W;
      const H = this.H;
      const px = Math.max(1, this.s * 0.05);
      const e = this.edgesCtx;
      const t = this.tmpCtx;
      e.setTransform(1, 0, 0, 1, 0, 0);
      e.clearRect(0, 0, W, H);

      const lip = (dx, dy, color) => {
        t.setTransform(1, 0, 0, 1, 0, 0);
        t.globalCompositeOperation = 'copy';
        t.drawImage(this.holes, dx, dy);
        t.globalCompositeOperation = 'source-in';
        t.fillStyle = color;
        t.fillRect(0, 0, W, H);
        t.globalCompositeOperation = 'destination-out';
        t.drawImage(this.holes, 0, 0);
        t.globalCompositeOperation = 'source-over';
        e.drawImage(this.tmp, 0, 0);
      };
      lip(0, px * 1.5, 'rgba(255,226,170,0.42)');
      lip(0, -px, 'rgba(12,6,16,0.75)');
      lip(px, 0, 'rgba(12,6,16,0.35)');
      lip(-px, 0, 'rgba(12,6,16,0.35)');

      e.globalCompositeOperation = 'destination-in';
      e.drawImage(this.soil, 0, 0);
      e.globalCompositeOperation = 'source-over';

      // Cast shadow: blur the soil's silhouette by shrinking and regrowing it.
      const sm = this.shadowSmallCtx;
      const sw = this.shadowSmall.width;
      const sh = this.shadowSmall.height;
      sm.globalCompositeOperation = 'copy';
      sm.imageSmoothingEnabled = true;
      sm.drawImage(this.soil, 0, 0, sw, sh);
      sm.globalCompositeOperation = 'source-in';
      sm.fillStyle = 'rgba(4,2,12,1)';
      sm.fillRect(0, 0, sw, sh);
      sm.globalCompositeOperation = 'source-over';
      const sc = this.shadowCtx;
      const cw = this.shadow.width;
      const ch = this.shadow.height;
      sc.clearRect(0, 0, cw, ch);
      sc.imageSmoothingQuality = 'high';
      sc.drawImage(this.shadowSmall, 0, this.s * 0.11 / 6, cw, ch);
    }

    // ---- title ---------------------------------------------------------
    startTitle(seed) {
      this.biomeIndex = 0;
      this.worldSeed = seed;
      this.stampLog = [];
      this.particles.length = 0;
      this.floats.length = 0;
      this.buildWorld();
      const cap = 2.65;
      const w1 = Font.width('UNDER', cap);
      const w2 = Font.width('MINE', cap);
      const strokes = [
        ...Font.strokes('UNDER', (COLS - 1 - w1) / 2, 1.9, cap),
        ...Font.strokes('MINE', (COLS - 1 - w2) / 2, 5.7, cap),
      ];
      const pen = [];
      for (const line of strokes) {
        for (let i = 0; i + 1 < line.length; i++) {
          const [ax, ay] = line[i];
          const [bx, by] = line[i + 1];
          const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.06));
          for (let k = 0; k <= n; k++) pen.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
        }
      }
      this.title = { pen, i: 0, done: false, age: 0, doneAt: 0 };
      if (this.reducedMotion) this.finishTitle();
    }

    finishTitle() {
      const t = this.title;
      if (!t) return;
      while (t.i < t.pen.length) {
        const [x, y] = t.pen[t.i++];
        this.stamp(x, y, 0.23);
      }
      t.done = true;
      t.doneAt = this.time;
    }

    updateTitle(dt) {
      const t = this.title;
      if (!t) return;
      t.age += dt;
      if (t.done || t.age < 0.5) return;
      const n = Math.ceil(dt * 260);
      for (let k = 0; k < n && t.i < t.pen.length; k++) {
        const [x, y] = t.pen[t.i++];
        this.stamp(x, y, 0.23);
        if (k === 0) this.crumbs(x, y, 1, 0.5);
      }
      if (t.i >= t.pen.length) {
        t.done = true;
        t.doneAt = this.time;
        this.shake = Math.max(this.shake, 0.08);
        this.flash = 0.35;
      }
    }

    // ---- particles -----------------------------------------------------
    spawn(p) {
      if (this.particles.length > 520) this.particles.shift();
      this.particles.push(p);
    }

    soilColor(y) {
      const strata = BIOMES[this.biomeIndex].strata;
      const band = Math.max(0, Math.min(3, Math.floor((y - GROUND_Y) / 3)));
      return strata[band];
    }

    crumbs(x, y, n, power = 1) {
      const c = this.soilColor(y);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * 6.28;
        const v = (0.5 + Math.random() * 1.8) * power;
        const shade = 0.7 + Math.random() * 0.7;
        this.spawn({
          x: x + (Math.random() - 0.5) * 0.4, y: y + (Math.random() - 0.5) * 0.4,
          vx: Math.cos(a) * v, vy: Math.sin(a) * v - 1, g: 7,
          life: 0.35 + Math.random() * 0.4, max: 0.75,
          size: 0.025 + Math.random() * 0.05,
          color: `rgb(${c[0] * shade | 0},${c[1] * shade | 0},${c[2] * shade | 0})`,
          square: true,
        });
      }
    }

    sparks(x, y, n, color, power = 1) {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * 6.28;
        const v = (1 + Math.random() * 4) * power;
        this.spawn({
          x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 3, drag: 2,
          life: 0.25 + Math.random() * 0.45, max: 0.7,
          size: 0.02 + Math.random() * 0.045, color, glow: true,
        });
      }
    }

    onEvent(e, game) {
      switch (e.t) {
        case 'round_start':
          this.setRound(e.round, game.seed);
          break;
        case 'dig':
          this.stamp(e.x, e.y, e.r);
          if (e.live && Math.random() < 0.5) this.crumbs(e.x, e.y, 2);
          break;
        case 'pump':
          this.sparks(e.x, e.y, 4, '#ffe9a8', 0.5);
          break;
        case 'pop': {
          const skin = e.type === 'cinder' ? '#7dffa0' : '#ff9d8c';
          this.sparks(e.x, e.y, 30, skin, 1.3);
          this.sparks(e.x, e.y, 12, '#fff5d0', 1.8);
          this.lightBurst(e.x, e.y, 0.35, skin);
          this.bump(0.08);
          break;
        }
        case 'rock_wiggle':
          this.crumbs(e.x, e.y + 0.45, 5, 0.3);
          break;
        case 'rock_land':
          this.crumbs(e.x, e.y + 0.3, 26, 1.8);
          this.rubble(e.x, e.y);
          this.bump(0.16 + e.kills * 0.05);
          break;
        case 'fire':
          this.bump(0.03);
          break;
        case 'death':
          this.sparks(e.x, e.y, 18, '#ffffff', 1);
          this.bump(0.12);
          break;
        case 'score':
          this.floats.push({ x: e.x, y: e.y - 0.3, text: String(e.pts), life: 1.2 });
          break;
        case 'veg_take':
          this.sparks(e.x, e.y, 24, '#fff3a0', 1.2);
          break;
        case 'veg':
          this.sparks(e.x, e.y, 10, '#fff3a0', 0.8);
          break;
        case 'extra_life':
          this.flash = 0.25;
          this.floats.push({ x: 6.5, y: 5, text: 'EXTRA LIFE', life: 2, big: true });
          break;
      }
    }

    bump(amount) {
      if (!this.reducedMotion) this.shake = Math.min(0.3, this.shake + amount);
    }

    lightBurst(x, y, life, color) {
      this.bursts = this.bursts || [];
      this.bursts.push({ x, y, life, max: life, color });
    }

    rubble(x, y) {
      const n = 12;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * 6.28;
        const v = 1 + Math.random() * 2.2;
        const shade = 90 + Math.random() * 70;
        this.spawn({
          x: x + Math.cos(a) * 0.2, y: y + Math.sin(a) * 0.2,
          vx: Math.cos(a) * v, vy: Math.sin(a) * v - 2.2, g: 10,
          life: 0.5 + Math.random() * 0.3, max: 0.8, size: 0.06 + Math.random() * 0.07,
          color: `rgb(${shade + 8 | 0},${shade | 0},${shade + 16 | 0})`, square: true,
        });
      }
    }

    updateFx(dt) {
      this.time += dt;
      this.shake = Math.max(0, this.shake - dt * 0.9);
      this.flash = Math.max(0, this.flash - dt * 1.4);
      const list = this.particles;
      for (let i = list.length - 1; i >= 0; i--) {
        const p = list[i];
        p.life -= dt;
        if (p.life <= 0) {
          list[i] = list[list.length - 1];
          list.pop();
          continue;
        }
        if (p.drag) {
          p.vx *= 1 - p.drag * dt;
          p.vy *= 1 - p.drag * dt;
        }
        p.vy += (p.g || 0) * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }
      for (let i = this.floats.length - 1; i >= 0; i--) {
        const f = this.floats[i];
        f.life -= dt;
        f.y -= dt * 0.55;
        if (f.life <= 0) this.floats.splice(i, 1);
      }
      if (this.bursts) {
        for (let i = this.bursts.length - 1; i >= 0; i--) {
          this.bursts[i].life -= dt;
          if (this.bursts[i].life <= 0) this.bursts.splice(i, 1);
        }
      }
      for (const m of this.motes || []) {
        m.y -= m.sp * dt;
        if (m.y < 1) m.y = 12;
      }
    }

    // ---- frame ----------------------------------------------------------
    draw(game, dt, opts = {}) {
      this.updateFx(dt);
      if (this.title) this.updateTitle(dt);
      const { ctx, W, H } = this;
      if (this.needsEdges && --this.edgeWait <= 0) {
        this.refreshEdges();
        this.needsEdges = false;
        this.edgeWait = 2;
      }

      const shakeX = this.shake ? (Math.random() - 0.5) * this.shake * this.s : 0;
      const shakeY = this.shake ? (Math.random() - 0.5) * this.shake * this.s : 0;

      // Base layers
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.drawImage(this.sky, 0, 0);
      this.drawClouds(ctx, game);
      ctx.setTransform(1, 0, 0, 1, shakeX, shakeY);
      ctx.drawImage(this.wall, 0, 0);
      this.drawTitleGlowUnder(ctx);
      ctx.globalAlpha = 0.9;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.shadow, 0, 0, W, H);
      ctx.globalAlpha = 1;
      ctx.drawImage(this.soil, 0, 0);
      ctx.drawImage(this.edges, 0, 0);

      // Sprites, in tile space
      const s = this.s;
      ctx.setTransform(s, 0, 0, s, this.ox + 0.5 * s + shakeX, this.oy + 2.5 * s + shakeY);

      const fx = this.fxCtx;
      fx.setTransform(1, 0, 0, 1, 0, 0);
      fx.clearRect(0, 0, this.fx.width, this.fx.height);
      this.apply(fx, 0.5);

      this.drawFlowers(ctx, game);
      if (game.state !== 'idle') {
        this.drawGhostTrails(game);
        if (game.veg) this.drawVeg(ctx, fx, game.veg);
        for (const r of game.rocks) this.drawRock(ctx, r);
        for (const e of game.enemies) this.drawEnemy(ctx, fx, e, game);
        this.drawPlayer(ctx, fx, game);
      } else {
        this.drawTitleCast(ctx, fx);
      }
      this.drawGlints(fx);
      this.drawParticles(ctx, fx);

      // Light map: multiply. Sky stays at full brightness.
      this.drawLights(game, opts);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'multiply';
      ctx.imageSmoothingQuality = 'medium';
      ctx.drawImage(this.light, 0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';

      // Bloom: sharp emissive layer plus two soft mips of it, added.
      this.bloomACtx.globalCompositeOperation = 'copy';
      this.bloomACtx.drawImage(this.fx, 0, 0, this.bloomA.width, this.bloomA.height);
      this.bloomBCtx.globalCompositeOperation = 'copy';
      this.bloomBCtx.drawImage(this.bloomA, 0, 0, this.bloomB.width, this.bloomB.height);
      ctx.globalCompositeOperation = 'lighter';
      ctx.setTransform(1, 0, 0, 1, shakeX, shakeY);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.fx, 0, 0, W, H);
      ctx.globalAlpha = 0.85;
      ctx.drawImage(this.bloomA, 0, 0, W, H);
      ctx.globalAlpha = 0.8;
      ctx.drawImage(this.bloomB, 0, 0, W, H);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';

      // Crisp items over the light map
      ctx.setTransform(s, 0, 0, s, this.ox + 0.5 * s + shakeX, this.oy + 2.5 * s + shakeY);
      if (game.state !== 'idle') for (const e of game.enemies) this.drawEnemyEyesLit(ctx, e, game);
      this.drawFloats(ctx);

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(this.frame, 0, 0);
      if (this.flash > 0) {
        ctx.fillStyle = `rgba(255,244,214,${this.flash * 0.5})`;
        ctx.fillRect(0, 0, W, H);
      }
      this.drawIris(ctx, game);

      this.apply(ctx);
      if (game.state === 'idle') this.drawTitleUI(ctx, game, opts);
      else this.drawHud(ctx, game);
      this.drawBanner(ctx, game, opts);
    }

    drawClouds(ctx, game) {
      const span = this.skySpan;
      const s = this.s;
      for (const c of this.clouds) {
        const x = this.skyLeft + ((c.x - this.skyLeft + this.time * c.speed) % span) - 2;
        const w = c.w * s * 2;
        ctx.drawImage(c.sprite, this.sx(x), this.sy(c.y), w, w * 0.6);
      }
      // A horizon-hugging cloud may hang past the ground line; soil draws over it next.
    }

    drawFlowers(ctx, game) {
      const round = game.state === 'idle' ? 3 : game.round;
      const big = Math.floor(round / 10);
      const small = round % 10;
      let x = COLS - 1.1;
      const sway = (i) => (this.reducedMotion ? 0 : Math.sin(this.time * 1.6 + i) * 0.06);
      for (let i = 0; i < big; i++, x -= 0.62) this.drawFlower(ctx, x, 0.5, 1.45, sway(i), '#ff6f91');
      for (let i = 0; i < small; i++, x -= 0.42) this.drawFlower(ctx, x, 0.5, 1, sway(i + big), i % 2 ? '#ffd24a' : '#fff4f0');
    }

    drawFlower(ctx, x, y, size, lean, color) {
      const h = 0.34 * size;
      ctx.save();
      ctx.translate(x, y);
      ctx.strokeStyle = '#3f8a30';
      ctx.lineWidth = 0.028 * size;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(0, -h * 0.6, lean, -h);
      ctx.stroke();
      ctx.fillStyle = '#4fa03a';
      ctx.beginPath();
      ctx.ellipse(0.05 * size, -h * 0.35, 0.06 * size, 0.024 * size, -0.5, 0, 7);
      ctx.fill();
      ctx.translate(lean, -h);
      ctx.fillStyle = color;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * 6.28;
        ctx.beginPath();
        ctx.ellipse(Math.cos(a) * 0.065 * size, Math.sin(a) * 0.065 * size, 0.05 * size, 0.034 * size, a, 0, 7);
        ctx.fill();
      }
      ctx.fillStyle = '#e8902a';
      ctx.beginPath();
      ctx.arc(0, 0, 0.038 * size, 0, 7);
      ctx.fill();
      ctx.restore();
    }

    drawGhostTrails(game) {
      for (const e of game.enemies) {
        if ((e.state === 'ghost' || e.state === 'flee') && !game.isDug(e.x, e.y) && Math.random() < 0.3) {
          this.crumbs(e.x, e.y, 1, 0.3);
        }
      }
    }

    // ---- rock ----------------------------------------------------------
    rockShape(r) {
      let shape = this.rockShapes.get(r.id);
      if (shape) return shape;
      const rng = rngFrom(this.worldSeed * 13 + r.id * 977);
      const points = [];
      const n = 10;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * 6.283;
        const rad = 0.4 + rng() * 0.09;
        points.push([Math.cos(a) * rad * 1.06, Math.sin(a) * rad * 0.94]);
      }
      const facets = [];
      for (let i = 0; i < 4; i++) {
        const a = rng() * 6.28;
        facets.push([Math.cos(a) * 0.2, Math.sin(a) * 0.2, rng() * 0.13 + 0.06, rng() * 3]);
      }
      shape = { points, facets, hue: 240 + rng() * 60 };
      this.rockShapes.set(r.id, shape);
      return shape;
    }

    drawRock(ctx, r) {
      if (r.state === 'dead') return;
      const shape = this.rockShape(r);
      ctx.save();
      let x = r.x;
      let alpha = 1;
      let sy = 1;
      if (r.state === 'wiggle' && !this.reducedMotion) x += Math.sin(this.time * 46) * 0.035;
      if (r.state === 'break') {
        alpha = Math.max(0, r.timer / 0.45);
        sy = 0.45 + alpha * 0.55;
      }
      ctx.globalAlpha = alpha;
      ctx.translate(x, r.y + (1 - sy) * 0.4);
      ctx.scale(1, sy);
      ctx.fillStyle = 'rgba(5,3,10,0.45)';
      ctx.beginPath();
      ctx.ellipse(0.02, 0.32, 0.42, 0.13, 0, 0, 7);
      ctx.fill();
      const path = new Path2D();
      shape.points.forEach(([px, py], i) => (i ? path.lineTo(px, py) : path.moveTo(px, py)));
      path.closePath();
      const g = ctx.createRadialGradient(-0.16, -0.2, 0.02, 0, 0, 0.6);
      g.addColorStop(0, `hsl(${shape.hue},9%,78%)`);
      g.addColorStop(0.55, `hsl(${shape.hue},10%,50%)`);
      g.addColorStop(1, `hsl(${shape.hue},18%,22%)`);
      ctx.fillStyle = g;
      ctx.fill(path);
      ctx.save();
      ctx.clip(path);
      for (const [fx, fy, fr, rot] of shape.facets) {
        ctx.save();
        ctx.translate(fx, fy);
        ctx.rotate(rot);
        ctx.fillStyle = 'rgba(255,255,255,0.1)';
        ctx.fillRect(-fr, -fr * 0.5, fr * 2, fr);
        ctx.fillStyle = 'rgba(10,6,24,0.22)';
        ctx.fillRect(-fr, fr * 0.5, fr * 2, fr * 0.6);
        ctx.restore();
      }
      ctx.restore();
      ctx.strokeStyle = 'rgba(16,10,26,0.9)';
      ctx.lineWidth = 0.028;
      ctx.lineJoin = 'round';
      ctx.stroke(path);
      if (r.state === 'wiggle' || r.state === 'break') {
        ctx.strokeStyle = 'rgba(12,8,20,0.85)';
        ctx.lineWidth = 0.025;
        ctx.beginPath();
        ctx.moveTo(-0.05, -0.36);
        ctx.lineTo(0.03, -0.1);
        ctx.lineTo(-0.1, 0.06);
        ctx.lineTo(0.05, 0.3);
        ctx.moveTo(0.03, -0.1);
        ctx.lineTo(0.24, 0.02);
        ctx.stroke();
      }
      ctx.restore();
    }

    // ---- enemies --------------------------------------------------------
    drawEnemy(ctx, fx, e, game) {
      if (e.state === 'dead' || e.state === 'pop') return;
      const inDirt = !game.isDug(e.x, e.y);
      if (inDirt && (e.state === 'ghost' || e.state === 'flee')) {
        this.drawGhostBody(ctx, fx, e);
        return;
      }
      ctx.save();
      ctx.translate(e.x, e.y);
      const stage = e.state === 'inflated' ? e.inflate : 0;
      let scale = 1 + stage * 0.33;
      let squashY = 1;
      let bob = 0;
      if (e.state === 'walk' || e.state === 'flee' || e.state === 'ghost') {
        bob = Math.abs(Math.sin(this.time * 9 + e.id)) * -0.035;
      }
      if (e.state === 'crushed') squashY = 0.65;
      if (e.state === 'squash') {
        squashY = 0.28;
        ctx.globalAlpha = Math.min(1, e.timer * 2.4);
        ctx.translate(0, 0.25);
      }
      if (e.state === 'charge' && !this.reducedMotion) {
        ctx.translate(Math.sin(this.time * 50) * 0.02, 0);
      }
      ctx.translate(0, bob);
      ctx.scale(scale, scale * squashY);
      if (e.type === 'puff') this.drawPuff(ctx, e, stage);
      else this.drawCinder(ctx, fx, e, stage);
      ctx.restore();
      if (e.state === 'charge' || e.state === 'breathe') this.drawFlame(fx, ctx, e);
    }

    drawGhostBody(ctx, fx, e) {
      // Only a shimmer of its outline shows; the eyes do the talking.
      ctx.save();
      ctx.translate(e.x, e.y);
      const pulse = 0.82 + Math.sin(this.time * 9 + e.id) * 0.06;
      ctx.fillStyle = 'rgba(8,2,18,0.38)';
      ctx.beginPath();
      ctx.ellipse(0, 0, 0.36 * pulse, 0.34 * pulse, 0, 0, 7);
      ctx.fill();
      ctx.strokeStyle = e.type === 'puff' ? 'rgba(255,120,110,0.35)' : 'rgba(110,255,160,0.35)';
      ctx.lineWidth = 0.02;
      ctx.setLineDash([0.05, 0.07]);
      ctx.lineDashOffset = -this.time * 0.4;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      const color = e.type === 'puff' ? '#ffb3a2' : '#a8ffb8';
      fx.fillStyle = color;
      const look = e.face * 0.02;
      for (const dx of [-0.11, 0.11]) {
        fx.beginPath();
        fx.ellipse(e.x + dx + look, e.y - 0.03, 0.06, 0.085, 0, 0, 7);
        fx.fill();
      }
    }

    drawEnemyEyesLit(ctx, e, game) {
      // Ghost pupils sit crisply on top of the bloom.
      if ((e.state !== 'ghost' && e.state !== 'flee') || game.isDug(e.x, e.y)) return;
      ctx.fillStyle = '#16061e';
      const look = e.face * 0.028;
      for (const dx of [-0.11, 0.11]) {
        ctx.beginPath();
        ctx.arc(e.x + dx + look, e.y - 0.025, 0.026, 0, 7);
        ctx.fill();
      }
    }

    drawPuff(ctx, e, stage) {
      const t = this.time + e.id;
      const walking = e.state === 'walk' || e.state === 'flee';
      const step = walking ? Math.sin(t * 13) * 0.05 : 0;
      const strain = Math.min(1, stage / 4);
      ctx.save();
      // Feet
      ctx.fillStyle = '#6b1e2e';
      for (const [dx, off] of [[-0.17, step], [0.17, -step]]) {
        ctx.beginPath();
        ctx.ellipse(dx, 0.34 + off, 0.11, 0.07, 0, 0, 7);
        ctx.fill();
      }
      // Body: coral, stretching paler and glossier as it inflates.
      const light = 72 + strain * 12;
      const g = ctx.createRadialGradient(-0.13, -0.17, 0.02, 0, 0, 0.45);
      g.addColorStop(0, `hsl(14,95%,${light}%)`);
      g.addColorStop(0.55, `hsl(4,${82 - strain * 20}%,${54 + strain * 12}%)`);
      g.addColorStop(1, `hsl(344,${70 - strain * 18}%,${30 + strain * 14}%)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(0, 0, 0.39, 0.37, 0, 0, 7);
      ctx.fill();
      ctx.strokeStyle = 'rgba(50,8,24,0.85)';
      ctx.lineWidth = 0.022 / (1 + stage * 0.2);
      ctx.stroke();
      // Rim light and gloss
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.beginPath();
      ctx.ellipse(-0.17, -0.2, 0.07, 0.045, -0.6, 0, 7);
      ctx.fill();
      // Goggles
      const f = e.face * 0.045;
      ctx.fillStyle = '#2a1626';
      ctx.fillRect(-0.385, -0.12, 0.77, 0.075);
      for (const dx of [-0.13, 0.13]) {
        ctx.fillStyle = '#2a1626';
        ctx.beginPath();
        ctx.arc(dx + f, -0.08, 0.13, 0, 7);
        ctx.fill();
        const lens = ctx.createRadialGradient(dx + f - 0.03, -0.11, 0.01, dx + f, -0.08, 0.11);
        lens.addColorStop(0, '#fff5c0');
        lens.addColorStop(0.6, '#ffc04a');
        lens.addColorStop(1, '#c76a18');
        ctx.fillStyle = lens;
        ctx.beginPath();
        ctx.arc(dx + f, -0.08, 0.1, 0, 7);
        ctx.fill();
        // Eye
        ctx.fillStyle = '#1b0b1e';
        ctx.beginPath();
        ctx.arc(dx + f + e.face * 0.025, -0.08, 0.042 + strain * 0.022, 0, 7);
        ctx.fill();
      }
      // Mouth
      ctx.strokeStyle = '#4a0e22';
      ctx.lineWidth = 0.02;
      ctx.beginPath();
      if (stage > 0.5) {
        ctx.ellipse(f, 0.15, 0.05 + strain * 0.03, 0.04 + strain * 0.04, 0, 0, 7);
        ctx.fillStyle = '#4a0e22';
        ctx.fill();
      } else {
        ctx.arc(f, 0.1, 0.08, 0.3, Math.PI - 0.3);
        ctx.stroke();
      }
      ctx.restore();
    }

    drawCinder(ctx, fx, e, stage) {
      const t = this.time + e.id;
      const walking = e.state === 'walk' || e.state === 'flee';
      const strain = Math.min(1, stage / 4);
      const charging = e.state === 'charge' || e.state === 'breathe';
      const step = walking ? Math.sin(t * 12) * 0.045 : 0;
      ctx.save();
      ctx.scale(e.face, 1); // drawn facing +x
      // Tail
      ctx.strokeStyle = '#1f6e3e';
      ctx.lineWidth = 0.12;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-0.22, 0.14);
      ctx.quadraticCurveTo(-0.42, 0.2, -0.47, 0.02 + step);
      ctx.stroke();
      ctx.fillStyle = '#ffb648';
      ctx.beginPath();
      ctx.moveTo(-0.46, -0.13 + step);
      ctx.lineTo(-0.54, 0.03 + step);
      ctx.lineTo(-0.4, 0.04 + step);
      ctx.closePath();
      ctx.fill();
      // Legs
      ctx.fillStyle = '#17552f';
      ctx.beginPath();
      ctx.ellipse(-0.12, 0.33 + step, 0.1, 0.07, 0, 0, 7);
      ctx.ellipse(0.14, 0.33 - step, 0.1, 0.07, 0, 0, 7);
      ctx.fill();
      // Spines
      ctx.fillStyle = '#ffa63c';
      for (const [sx, sy, r] of [[-0.24, -0.25, 0.08], [-0.07, -0.34, 0.09], [0.1, -0.35, 0.08]]) {
        ctx.beginPath();
        ctx.moveTo(sx - r, sy + 0.06);
        ctx.lineTo(sx, sy - r);
        ctx.lineTo(sx + r, sy + 0.06);
        ctx.closePath();
        ctx.fill();
      }
      // Body
      const g = ctx.createRadialGradient(-0.03, -0.16, 0.03, 0, 0.02, 0.46);
      g.addColorStop(0, `hsl(136,${72 - strain * 15}%,${60 + strain * 14}%)`);
      g.addColorStop(0.65, `hsl(146,62%,${36 + strain * 12}%)`);
      g.addColorStop(1, `hsl(164,62%,${17 + strain * 10}%)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(-0.04, 0.04, 0.32, 0.31, 0, 0, 7);
      ctx.fill();
      // Snout and head
      ctx.beginPath();
      ctx.ellipse(0.2, -0.1, 0.24, 0.2, -0.12, 0, 7);
      ctx.fill();
      ctx.strokeStyle = 'rgba(8,40,26,0.85)';
      ctx.lineWidth = 0.02;
      ctx.stroke();
      // Belly: glows from within when about to breathe.
      const pulse = charging ? 0.55 + Math.sin(this.time * 24) * 0.25 : 0;
      const belly = ctx.createLinearGradient(0, -0.03, 0, 0.3);
      belly.addColorStop(0, charging ? '#ffd28a' : '#f6ecb4');
      belly.addColorStop(1, charging ? '#ff7b2c' : '#c7c778');
      ctx.fillStyle = belly;
      ctx.beginPath();
      ctx.ellipse(0.02, 0.15, 0.17, 0.17, 0, 0, 7);
      ctx.fill();
      if (charging) {
        const gx = e.x + e.face * 0.02;
        const glow = fx.createRadialGradient(gx, e.y + 0.1, 0, gx, e.y + 0.1, 0.3);
        glow.addColorStop(0, `rgba(255,150,50,${pulse})`);
        glow.addColorStop(1, 'rgba(255,90,20,0)');
        fx.fillStyle = glow;
        fx.fillRect(gx - 0.3, e.y - 0.2, 0.6, 0.6);
      }
      // Nostril, eye and brow
      ctx.fillStyle = '#0d3320';
      ctx.beginPath();
      ctx.arc(0.36, -0.13, 0.018, 0, 7);
      ctx.fill();
      ctx.fillStyle = '#fffbea';
      ctx.beginPath();
      ctx.ellipse(0.16, -0.17, 0.085, 0.095 + strain * 0.02, 0, 0, 7);
      ctx.fill();
      ctx.fillStyle = charging ? '#d43c10' : '#101a12';
      ctx.beginPath();
      ctx.arc(0.19, -0.165, 0.04 + strain * 0.015, 0, 7);
      ctx.fill();
      ctx.strokeStyle = '#0d3320';
      ctx.lineWidth = 0.028;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(0.07, -0.285);
      ctx.lineTo(0.25, -0.24);
      ctx.stroke();
      // Wing stub
      ctx.fillStyle = '#2d8f58';
      ctx.beginPath();
      ctx.moveTo(-0.14, -0.08);
      ctx.quadraticCurveTo(-0.4, -0.3 + step * 2, -0.34, -0.03);
      ctx.quadraticCurveTo(-0.24, 0.05, -0.14, -0.08);
      ctx.fill();
      ctx.restore();
    }

    drawFlame(fx, ctx, e) {
      const dir = e.face;
      const mouthX = e.x + dir * 0.42;
      const mouthY = e.y - 0.08;
      if (e.state === 'charge') {
        const g = fx.createRadialGradient(mouthX, mouthY, 0, mouthX, mouthY, 0.26);
        g.addColorStop(0, 'rgba(255,190,90,0.8)');
        g.addColorStop(1, 'rgba(255,90,20,0)');
        fx.fillStyle = g;
        fx.fillRect(mouthX - 0.3, mouthY - 0.3, 0.6, 0.6);
        return;
      }
      const len = e.flameLen;
      if (len <= 0) return;
      const t = this.time;
      // Layered tongues: outer red, middle orange, white-hot core.
      const layers = [
        [0.36, 'rgba(232,70,20,0.75)', 1],
        [0.24, 'rgba(255,152,44,0.9)', 0.94],
        [0.12, 'rgba(255,240,190,0.98)', 0.8],
      ];
      for (const [w, color, reach] of layers) {
        fx.fillStyle = color;
        fx.beginPath();
        const n = 16;
        const pts = [];
        for (let i = 0; i <= n; i++) {
          const k = i / n;
          const px = mouthX + dir * k * len * reach;
          const wob = Math.sin(t * 34 + k * 11 + w * 40) * 0.05 * k;
          const widthAt = w * Math.sin(Math.min(1, k * 1.15 + 0.08) * Math.PI) ** 0.6 * (0.5 + k * 0.6);
          pts.push([px, mouthY + wob, widthAt]);
        }
        pts.forEach(([px, py, ww], i) => (i ? fx.lineTo(px, py - ww) : fx.moveTo(px, py - ww)));
        for (let i = pts.length - 1; i >= 0; i--) fx.lineTo(pts[i][0], pts[i][1] + pts[i][2]);
        fx.closePath();
        fx.fill();
      }
      if (Math.random() < 0.8) {
        this.spawn({
          x: mouthX + dir * Math.random() * len, y: mouthY + (Math.random() - 0.5) * 0.3,
          vx: dir * (Math.random() * 1.2), vy: -0.8 - Math.random(), g: -0.6,
          life: 0.3 + Math.random() * 0.4, max: 0.7, size: 0.018 + Math.random() * 0.03,
          color: '#ffae5e', glow: true,
        });
      }
    }

    // ---- miner ----------------------------------------------------------
    drawMiner(ctx, walkT, opts = {}) {
      const step = Math.sin(walkT * 16);
      const bob = opts.pumping ? 0 : Math.abs(step) * -0.02;
      ctx.save();
      ctx.translate(0, bob);
      // Back leg
      ctx.fillStyle = '#1c3a7a';
      ctx.save();
      ctx.translate(-0.08, 0.2);
      ctx.rotate(-step * 0.55);
      ctx.fillRect(-0.055, 0, 0.11, 0.15);
      ctx.fillStyle = '#2b1a14';
      ctx.fillRect(-0.06, 0.11, 0.15, 0.07);
      ctx.restore();
      // Back arm
      ctx.strokeStyle = '#d0a020';
      ctx.lineCap = 'round';
      ctx.lineWidth = 0.075;
      ctx.beginPath();
      ctx.moveTo(-0.08, 0.02);
      ctx.lineTo(-0.1 - step * 0.08, 0.17);
      ctx.stroke();
      // Body: slicker over overalls
      const body = ctx.createLinearGradient(-0.2, -0.1, 0.2, 0.3);
      body.addColorStop(0, '#ffd64d');
      body.addColorStop(1, '#e49613');
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.roundRect(-0.19, -0.1, 0.36, 0.33, 0.11);
      ctx.fill();
      ctx.strokeStyle = 'rgba(70,36,8,0.85)';
      ctx.lineWidth = 0.02;
      ctx.stroke();
      ctx.fillStyle = '#2a58b8';
      ctx.beginPath();
      ctx.roundRect(-0.15, 0.09, 0.28, 0.15, 0.05);
      ctx.fill();
      // Front leg
      ctx.fillStyle = '#2f62c9';
      ctx.save();
      ctx.translate(0.05, 0.2);
      ctx.rotate(step * 0.55);
      ctx.fillRect(-0.055, 0, 0.11, 0.15);
      ctx.fillStyle = '#3b2519';
      ctx.fillRect(-0.06, 0.11, 0.16, 0.07);
      ctx.restore();
      // Head
      const face = ctx.createRadialGradient(0.05, -0.22, 0.02, 0.02, -0.2, 0.22);
      face.addColorStop(0, '#ffe6cc');
      face.addColorStop(1, '#e8ac84');
      ctx.fillStyle = face;
      ctx.beginPath();
      ctx.arc(0.03, -0.2, 0.185, 0, 7);
      ctx.fill();
      ctx.strokeStyle = 'rgba(70,30,16,0.8)';
      ctx.lineWidth = 0.018;
      ctx.stroke();
      // Face
      ctx.fillStyle = '#1b1020';
      ctx.beginPath();
      ctx.ellipse(0.1, -0.2, 0.024, 0.036, 0, 0, 7);
      ctx.fill();
      ctx.fillStyle = 'rgba(240,120,110,0.5)';
      ctx.beginPath();
      ctx.arc(0.08, -0.13, 0.03, 0, 7);
      ctx.fill();
      // Helmet
      const helm = ctx.createLinearGradient(0, -0.42, 0, -0.2);
      helm.addColorStop(0, '#fff7ee');
      helm.addColorStop(1, '#c9ccd8');
      ctx.fillStyle = helm;
      ctx.beginPath();
      ctx.arc(0.02, -0.25, 0.2, Math.PI, 0);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(40,36,60,0.8)';
      ctx.lineWidth = 0.018;
      ctx.stroke();
      ctx.fillStyle = '#9ea2b6';
      ctx.fillRect(-0.2, -0.27, 0.46, 0.035);
      // Lamp
      ctx.fillStyle = '#3a3a48';
      ctx.fillRect(0.14, -0.38, 0.07, 0.09);
      ctx.fillStyle = '#fff6c4';
      ctx.beginPath();
      ctx.arc(0.205, -0.335, 0.042, 0, 7);
      ctx.fill();
      // Front arm with the pump gun
      ctx.strokeStyle = '#f2b52a';
      ctx.lineWidth = 0.08;
      ctx.beginPath();
      ctx.moveTo(0.02, 0.01);
      ctx.lineTo(0.17, 0.05);
      ctx.stroke();
      ctx.fillStyle = '#cf2f3f';
      ctx.beginPath();
      ctx.roundRect(0.15, 0, 0.24, 0.1, 0.03);
      ctx.fill();
      ctx.fillStyle = '#ffd98a';
      ctx.fillRect(0.37, 0.025, 0.07, 0.05);
      ctx.restore();
    }

    drawPlayer(ctx, fx, game) {
      const p = game.player;
      const dirs = root.Sim.DIRS;
      const d = dirs[p.face];
      if (p.pump) this.drawHarpoon(ctx, fx, p, d);
      ctx.save();
      ctx.translate(p.x, p.y);
      if (p.dead) {
        const k = Math.max(0, Math.min(1, 1 - game.timer / 2));
        if (p.deathKind === 'crushed') {
          ctx.scale(1.3, 0.3);
          ctx.translate(0, 0.3);
        } else {
          ctx.rotate(k * 12);
          const sc = Math.max(0, 1 - k * 1.1);
          ctx.scale(sc, sc);
        }
      } else if (p.face === 'L') {
        ctx.scale(-1, 1);
      } else if (p.face === 'U') {
        ctx.rotate(-Math.PI / 2);
      } else if (p.face === 'D') {
        ctx.rotate(Math.PI / 2);
        ctx.scale(1, -1);
      }
      if (game.state === 'ready' && Math.sin(this.time * 12) > 0.4) ctx.globalAlpha = 0.65;
      ctx.scale(1.12, 1.12);
      ctx.translate(0, 0.02);
      this.drawMiner(ctx, p.moving ? p.walkT : 0, { pumping: !!p.pump });
      ctx.restore();

      // Lamp lens flare, in the emissive layer.
      if (!p.dead) {
        const lamp = this.lampPosition(p);
        const pulse = 0.5 + Math.sin(this.time * 3) * 0.08;
        const g = fx.createRadialGradient(lamp.x, lamp.y, 0, lamp.x, lamp.y, 0.28);
        g.addColorStop(0, `rgba(255,244,190,${pulse})`);
        g.addColorStop(1, 'rgba(255,220,130,0)');
        fx.fillStyle = g;
        fx.fillRect(lamp.x - 0.3, lamp.y - 0.3, 0.6, 0.6);
      }
    }

    lampPosition(p) {
      const dx = 0.23;
      const dy = -0.37;
      switch (p.face) {
        case 'L': return { x: p.x - dx, y: p.y + dy };
        case 'U': return { x: p.x + dy, y: p.y - dx };
        case 'D': return { x: p.x + dy, y: p.y + dx };
        default: return { x: p.x + dx, y: p.y + dy };
      }
    }

    drawHarpoon(ctx, fx, p, d) {
      const h = p.pump;
      const sx = p.x + d.x * 0.4;
      const sy = p.y + d.y * 0.4 + (d.y === 0 ? 0.05 : 0);
      const tx = p.x + d.x * Math.max(0.42, h.len);
      const ty = p.y + d.y * Math.max(0.42, h.len) + (d.y === 0 ? 0.05 : 0);
      const sag = h.state === 'hold' ? 0.04 + Math.sin(this.time * 18) * 0.012 : 0.015;
      ctx.strokeStyle = '#2a1a24';
      ctx.lineCap = 'round';
      ctx.lineWidth = 0.05;
      const curve = () => {
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.quadraticCurveTo((sx + tx) / 2 + d.y * sag, (sy + ty) / 2 + Math.abs(d.x) * sag, tx, ty);
        ctx.stroke();
      };
      curve();
      ctx.strokeStyle = '#f2c46a';
      ctx.lineWidth = 0.024;
      curve();
      // Pressure pulse running down the hose while pumping.
      if (h.state === 'hold' && h.timer > 0.1) {
        const k = 1 - (h.timer - 0.1) / 0.16;
        fx.fillStyle = 'rgba(255,240,180,0.9)';
        fx.beginPath();
        fx.arc(sx + (tx - sx) * k, sy + (ty - sy) * k, 0.055, 0, 7);
        fx.fill();
      }
      // Tip
      ctx.save();
      ctx.translate(tx, ty);
      ctx.rotate(Math.atan2(d.y, d.x));
      ctx.fillStyle = '#e8edf7';
      ctx.strokeStyle = '#2a1a24';
      ctx.lineWidth = 0.016;
      ctx.beginPath();
      ctx.moveTo(0.11, 0);
      ctx.lineTo(-0.04, -0.06);
      ctx.lineTo(-0.02, 0);
      ctx.lineTo(-0.04, 0.06);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    // ---- pickups, glints, particles ------------------------------------
    drawVeg(ctx, fx, v) {
      const blink = v.t < 2.5 && Math.sin(this.time * 18) > 0;
      if (blink) return;
      const bob = Math.sin(this.time * 4) * 0.03;
      ctx.save();
      ctx.translate(v.x, v.y + bob);
      const g = fx.createRadialGradient(v.x, v.y, 0, v.x, v.y, 0.55);
      g.addColorStop(0, 'rgba(255,240,170,0.22)');
      g.addColorStop(1, 'rgba(255,240,170,0)');
      fx.fillStyle = g;
      fx.fillRect(v.x - 0.6, v.y - 0.6, 1.2, 1.2);
      this.vegShape(ctx, v.kind);
      ctx.restore();
      const a = this.time * 1.7;
      for (let i = 0; i < 3; i++) {
        const sx = v.x + Math.cos(a + i * 2.1) * 0.42;
        const sy = v.y + Math.sin(a + i * 2.1) * 0.34;
        fx.fillStyle = '#fff6c0';
        fx.beginPath();
        fx.arc(sx, sy, 0.024 + Math.sin(this.time * 8 + i) * 0.012, 0, 7);
        fx.fill();
      }
    }

    vegShape(ctx, kind) {
      const leaf = (x, y, rot, len) => {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(rot);
        ctx.fillStyle = '#58b53c';
        ctx.beginPath();
        ctx.ellipse(0, -len / 2, len * 0.22, len / 2, 0, 0, 7);
        ctx.fill();
        ctx.restore();
      };
      if (kind === 0) {
        // Carrot
        leaf(0, -0.17, -0.4, 0.22);
        leaf(0, -0.17, 0, 0.26);
        leaf(0, -0.17, 0.4, 0.22);
        const g = ctx.createLinearGradient(-0.14, 0, 0.14, 0);
        g.addColorStop(0, '#ffa84a');
        g.addColorStop(1, '#df5f12');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(-0.15, -0.17);
        ctx.quadraticCurveTo(0, -0.24, 0.15, -0.17);
        ctx.lineTo(0, 0.34);
        ctx.closePath();
        ctx.fill();
      } else if (kind === 1) {
        // Radish
        leaf(0, -0.1, -0.35, 0.26);
        leaf(0, -0.1, 0.35, 0.26);
        const g = ctx.createRadialGradient(-0.07, -0.02, 0.02, 0, 0.05, 0.24);
        g.addColorStop(0, '#ff90b8');
        g.addColorStop(1, '#c21e62');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, 0.06, 0.2, 0, 7);
        ctx.fill();
        ctx.fillStyle = '#fff2f6';
        ctx.beginPath();
        ctx.moveTo(-0.08, 0.2);
        ctx.quadraticCurveTo(0, 0.42, 0.08, 0.2);
        ctx.fill();
      } else if (kind === 2) {
        // Mushroom
        ctx.fillStyle = '#f7eede';
        ctx.beginPath();
        ctx.roundRect(-0.08, -0.02, 0.16, 0.28, 0.06);
        ctx.fill();
        const g = ctx.createRadialGradient(-0.07, -0.2, 0.02, 0, -0.08, 0.3);
        g.addColorStop(0, '#ff6d58');
        g.addColorStop(1, '#a31d1d');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, -0.02, 0.28, Math.PI, 0);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#fff';
        for (const [x, y, r] of [[-0.12, -0.11, 0.04], [0.04, -0.18, 0.05], [0.15, -0.07, 0.03]]) {
          ctx.beginPath();
          ctx.arc(x, y, r, 0, 7);
          ctx.fill();
        }
      } else {
        // Aubergine
        leaf(0.03, -0.17, 0.5, 0.15);
        const g = ctx.createRadialGradient(-0.07, -0.02, 0.01, 0, 0.05, 0.32);
        g.addColorStop(0, '#a763e8');
        g.addColorStop(1, '#3b1370');
        ctx.fillStyle = g;
        ctx.save();
        ctx.rotate(-0.25);
        ctx.beginPath();
        ctx.ellipse(0, 0.05, 0.17, 0.27, 0, 0, 7);
        ctx.fill();
        ctx.restore();
      }
    }

    drawGlints(fx) {
      for (const g of this.glints) {
        const k = Math.sin(this.time * 1.4 + g.phase);
        if (k < 0.55) continue;
        const a = (k - 0.55) * 2.2;
        fx.fillStyle = g.color;
        fx.globalAlpha = a;
        fx.beginPath();
        fx.moveTo(g.x, g.y - 0.11);
        fx.lineTo(g.x + 0.016, g.y);
        fx.lineTo(g.x, g.y + 0.11);
        fx.lineTo(g.x - 0.016, g.y);
        fx.closePath();
        fx.moveTo(g.x - 0.11, g.y);
        fx.lineTo(g.x, g.y + 0.016);
        fx.lineTo(g.x + 0.11, g.y);
        fx.lineTo(g.x, g.y - 0.016);
        fx.closePath();
        fx.fill();
        fx.globalAlpha = 1;
      }
    }

    drawParticles(ctx, fx) {
      for (const p of this.particles) {
        const a = Math.min(1, p.life / (p.max * 0.5));
        const target = p.glow ? fx : ctx;
        target.globalAlpha = a;
        target.fillStyle = p.color;
        if (p.square) {
          target.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
        } else {
          target.beginPath();
          target.arc(p.x, p.y, p.size, 0, 7);
          target.fill();
        }
      }
      ctx.globalAlpha = 1;
      fx.globalAlpha = 1;
    }

    drawFloats(ctx) {
      for (const f of this.floats) {
        ctx.globalAlpha = Math.min(1, f.life * 2);
        Font.draw(ctx, f.text, f.x, f.y, f.big ? 0.62 : 0.34, {
          align: 'center',
          color: f.big ? '#ffe28a' : '#fff6da',
          outline: 'rgba(30,12,28,0.9)',
        });
      }
      ctx.globalAlpha = 1;
    }

    // ---- light map -----------------------------------------------------
    drawLights(game, opts) {
      const l = this.lightCtx;
      const b = BIOMES[this.biomeIndex];
      l.setTransform(1, 0, 0, 1, 0, 0);
      l.globalCompositeOperation = 'copy';
      l.drawImage(this.ambient, 0, 0);
      l.globalCompositeOperation = 'lighter';
      this.apply(l, 1 / 3);

      const glow = (x, y, r, color, a) => {
        const g = l.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(${color},${a})`);
        g.addColorStop(0.5, `rgba(${color},${a * 0.32})`);
        g.addColorStop(1, `rgba(${color},0)`);
        l.fillStyle = g;
        l.fillRect(x - r, y - r, r * 2, r * 2);
      };

      if (game.state !== 'idle') {
        const p = game.player;
        if (!p.dead) {
          glow(p.x, p.y, 3.0, '255,214,150', 0.55);
          // Headlamp beam, pointing where the miner faces.
          const d = root.Sim.DIRS[p.face];
          const lamp = this.lampPosition(p);
          const reach = 4.2;
          const tipX = lamp.x + d.x * reach;
          const tipY = lamp.y + d.y * reach;
          const beam = l.createLinearGradient(lamp.x, lamp.y, tipX, tipY);
          beam.addColorStop(0, 'rgba(255,240,196,0.55)');
          beam.addColorStop(1, 'rgba(255,230,180,0)');
          l.fillStyle = beam;
          const spread = 1.1;
          l.beginPath();
          l.moveTo(lamp.x, lamp.y);
          l.lineTo(tipX + d.y * spread, tipY + d.x * spread);
          l.lineTo(tipX - d.y * spread, tipY - d.x * spread);
          l.closePath();
          l.fill();
        }
        for (const e of game.enemies) {
          if (e.state === 'breathe' && e.flameLen > 0) {
            const flicker = 0.75 + Math.random() * 0.25;
            glow(e.x + e.face * (e.flameLen * 0.5 + 0.4), e.y, 3.2, '255,130,50', 0.9 * flicker);
          } else if (e.state === 'charge') {
            glow(e.x, e.y, 1.6, '255,120,40', 0.5);
          } else if (e.state === 'ghost') {
            glow(e.x, e.y, 0.9, e.type === 'puff' ? '255,120,110' : '110,255,150', 0.3);
          }
        }
        if (game.veg) glow(game.veg.x, game.veg.y, 1.5, '255,235,150', 0.3);
        for (const g of this.glints) glow(g.x, g.y, 0.7, b.accent.join(','), 0.2);
      } else if (this.title) {
        const t = this.title;
        if (!t.done && t.i > 0) {
          const [x, y] = t.pen[Math.min(t.i, t.pen.length - 1)];
          glow(x, y, 3, '255,216,140', 1);
        }
        if (t.done) {
          // The finished title lights the soil around it.
          const pulse = 0.5 + Math.sin(this.time * 1.5) * 0.06;
          glow(6.5, 3.2, 7, '255,178,84', pulse);
          glow(6.5, 7, 7, '255,178,84', pulse);
        }
      }
      if (this.bursts) {
        for (const bu of this.bursts) {
          const k = bu.life / bu.max;
          glow(bu.x, bu.y, 3.5 * (1.3 - k * 0.3), '255,240,220', k);
        }
      }
      l.globalCompositeOperation = 'source-over';
    }

    // ---- title screen --------------------------------------------------
    drawTitleGlowUnder(ctx) {
      const t = this.title;
      if (!t || !t.done) return;
      // Molten seam showing through the carved letters.
      if (!this.titleTint) {
        this.titleTint = makeCanvas(this.W, this.H);
      }
      const g = this.titleTint.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalCompositeOperation = 'copy';
      g.drawImage(this.holes, 0, 0);
      g.globalCompositeOperation = 'source-in';
      const grad = g.createLinearGradient(0, this.sy(1.6), 0, this.sy(9));
      grad.addColorStop(0, '#fff0a8');
      grad.addColorStop(0.45, '#ffb238');
      grad.addColorStop(1, '#f2592a');
      g.fillStyle = grad;
      g.fillRect(0, 0, this.W, this.H);
      g.globalCompositeOperation = 'source-over';
      const age = Math.min(1, (this.time - t.doneAt) * 2);
      ctx.save();
      ctx.globalAlpha = age * (0.92 + Math.sin(this.time * 1.5) * 0.08);
      ctx.drawImage(this.titleTint, 0, 0);
      ctx.restore();
    }

    drawTitleCast(ctx, fx) {
      // Miner and the two troublemakers on the surface.
      const bob = this.reducedMotion ? 0 : Math.sin(this.time * 2) * 0.01;
      ctx.save();
      ctx.translate(2.2, 0 + bob);
      ctx.scale(1.12, 1.12);
      this.drawMiner(ctx, 0);
      ctx.restore();
      const puff = { id: 1, face: -1, state: 'idle', type: 'puff' };
      ctx.save();
      ctx.translate(9.8, 0.06);
      this.drawPuff(ctx, puff, 0);
      ctx.restore();
      const cinder = { id: 2, face: -1, state: 'idle', x: 11.2, y: 0.06 };
      ctx.save();
      ctx.translate(11.2, 0.06);
      this.drawCinder(ctx, fx, cinder, 0);
      ctx.restore();
    }

    drawTitleUI(ctx, game, opts) {
      const t = this.title;
      const mid = (COLS - 1) / 2;
      if (t && t.done) {
        const a = Math.min(1, (this.time - t.doneAt) * 1.5);
        ctx.globalAlpha = a;
        const blink = this.reducedMotion || Math.sin(this.time * 3.5) > -0.5;
        const touch = opts.touch;
        if (blink) {
          Font.draw(ctx, touch ? 'TAP TO DIG' : 'PRESS SPACE TO DIG', mid, 9.75, 0.46, {
            align: 'center', color: '#fff4cf', outline: 'rgba(20,8,16,0.92)', weight: 1.2,
          });
        }
        const lines = touch
          ? ['DRAG LEFT SIDE TO MOVE', 'HOLD RIGHT SIDE TO PUMP']
          : ['ARROWS OR WASD MOVE', 'SPACE PUMPS  M MUTES  P PAUSES'];
        lines.forEach((line, i) => {
          Font.draw(ctx, line, mid, 10.75 + i * 0.5, 0.27, {
            align: 'center', color: '#ead9c0', outline: 'rgba(20,8,16,0.92)',
          });
        });
        ctx.globalAlpha = 1;
      }
      if (game.hi > 0) this.drawScoreBlock(ctx, game, true);
    }

    // ---- HUD and overlays ---------------------------------------------
    drawScoreBlock(ctx, game, hiOnly) {
      const label = '#efe0c6';
      const opts = { outline: 'rgba(20,8,20,0.9)' };
      if (this.wide) {
        const gap = -0.95;
        if (!hiOnly) {
          Font.draw(ctx, 'SCORE', gap, -1.85, 0.27, { ...opts, align: 'right', color: label });
          Font.draw(ctx, game.score, gap, -1.4, 0.6, { ...opts, align: 'right', color: '#fff', weight: 1.2 });
        }
        Font.draw(ctx, 'BEST', gap, -0.45, 0.27, { ...opts, align: 'right', color: label });
        Font.draw(ctx, Math.max(game.hi, game.score), gap, -0.02, 0.42, { ...opts, align: 'right', color: '#ffd77a' });
      } else {
        const top = -(this.oy / this.s) - 2.5 + 0.35;
        if (!hiOnly) {
          Font.draw(ctx, 'SCORE', -0.1, top, 0.27, { ...opts, color: label });
          Font.draw(ctx, game.score, -0.1, top + 0.45, 0.55, { ...opts, color: '#fff', weight: 1.2 });
        }
        Font.draw(ctx, 'BEST', mid2(), top, 0.27, { ...opts, align: 'center', color: label });
        Font.draw(ctx, Math.max(game.hi, game.score), mid2(), top + 0.45, 0.42, { ...opts, align: 'center', color: '#ffd77a' });
      }
    }

    drawHud(ctx, game) {
      this.drawScoreBlock(ctx, game, false);
      const opts = { outline: 'rgba(20,8,20,0.9)' };
      const icons = Math.max(0, game.lives - 1);
      let rx;
      let top;
      let align;
      if (this.wide) {
        rx = COLS - 0.05;
        top = -1.85;
        align = 'left';
      } else {
        rx = COLS - 0.9;
        top = -(this.oy / this.s) - 2.5 + 0.35;
        align = 'right';
      }
      Font.draw(ctx, 'ROUND', rx, top, 0.27, { ...opts, align, color: '#efe0c6' });
      Font.draw(ctx, game.round, rx, top + 0.45, 0.6, { ...opts, align, color: '#fff', weight: 1.2 });
      const iconY = this.wide ? top + 1.65 : top + 1.6;
      for (let i = 0; i < Math.min(icons, 6); i++) {
        const ix = align === 'left' ? rx + 0.25 + i * 0.68 : rx - 0.25 - i * 0.68;
        ctx.save();
        ctx.translate(ix, iconY);
        ctx.scale(0.72, 0.72);
        if (align === 'right') ctx.scale(-1, 1);
        this.drawMiner(ctx, 0);
        ctx.restore();
      }
    }

    drawIris(ctx, game) {
      let k = -1; // 0 fully closed, 1 fully open
      if (game.state === 'clear' && game.timer < 0.55) k = game.timer / 0.55;
      else if (game.state === 'ready' && this.irisOpening) {
        k = (2 - game.timer) / 0.55;
        if (k >= 1) this.irisOpening = false;
      }
      if (k < 0 || k >= 1) return;
      const p = game.player;
      const cx = this.sx(p.x);
      const cy = this.sy(p.y);
      const r = Math.hypot(this.W, this.H) * k * k;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#05030a';
      ctx.beginPath();
      ctx.rect(0, 0, this.W, this.H);
      ctx.arc(cx, cy, Math.max(0.01, r), 0, 7, true);
      ctx.fill();
    }

    drawBanner(ctx, game, opts) {
      const mid = (COLS - 1) / 2;
      const big = { align: 'center', outline: 'rgba(16,6,18,0.95)', weight: 1.25, outlineWidth: 0.16 };
      if (opts.paused) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = 'rgba(8,4,16,0.6)';
        ctx.fillRect(0, 0, this.W, this.H);
        this.apply(ctx);
        Font.draw(ctx, 'PAUSED', mid, 4.6, 0.95, { ...big, color: '#fff4cf' });
        Font.draw(ctx, opts.touch ? 'TAP TO RESUME' : 'PRESS P TO RESUME', mid, 6, 0.32, { align: 'center', color: '#ead9c0', outline: 'rgba(16,6,18,0.95)' });
        return;
      }
      if (game.state === 'ready') {
        Font.draw(ctx, `ROUND ${game.round}`, mid, 3.9, 0.72, { ...big, color: '#fff4cf' });
        Font.draw(ctx, 'READY', mid, 4.95, 0.42, { ...big, color: '#ffd77a' });
      } else if (game.state === 'clear') {
        Font.draw(ctx, 'ROUND CLEAR', mid, 4.2, 0.78, { ...big, color: '#ffe28a' });
      } else if (game.state === 'over') {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = 'rgba(6,3,12,0.55)';
        ctx.fillRect(0, 0, this.W, this.H);
        this.apply(ctx);
        Font.draw(ctx, 'GAME OVER', mid, 3.7, 1.0, { ...big, color: '#ff9c7a' });
        Font.draw(ctx, `SCORE ${game.score}`, mid, 5.3, 0.46, { ...big, color: '#fff4cf' });
        if (game.timer <= 2.6) {
          Font.draw(ctx, opts.touch ? 'TAP TO PLAY AGAIN' : 'PRESS SPACE TO PLAY AGAIN', mid, 6.4, 0.34, {
            align: 'center', color: '#ead9c0', outline: 'rgba(16,6,18,0.95)',
          });
        }
      }
    }
  }

  function mid2() {
    return (COLS - 1) / 2;
  }

  root.Renderer = Renderer;
})(globalThis);
