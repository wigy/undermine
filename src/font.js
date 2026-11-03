// Monoline lettering drawn like mine shafts: straight runs with chamfered corners.
// Each glyph is a list of polylines on a 4-wide, 6-tall grid. Used for the HUD and to carve the title.
(function (root) {
  const O = [1, 0, 3, 0, 4, 1, 4, 5, 3, 6, 1, 6, 0, 5, 0, 1, 1, 0];
  const P = [0, 6, 0, 0, 3, 0, 4, 1, 4, 2, 3, 3, 0, 3];
  const GLYPHS = {
    A: [[0, 6, 0, 1.2, 1.2, 0, 2.8, 0, 4, 1.2, 4, 6], [0, 3.5, 4, 3.5]],
    B: [[0, 0, 0, 6, 3, 6, 4, 5, 4, 4, 3, 3, 0, 3], [0, 0, 3, 0, 4, 1, 4, 2, 3, 3]],
    C: [[4, 1, 3, 0, 1, 0, 0, 1, 0, 5, 1, 6, 3, 6, 4, 5]],
    D: [[0, 0, 0, 6, 2.6, 6, 4, 4.6, 4, 1.4, 2.6, 0, 0, 0]],
    E: [[4, 0, 0, 0, 0, 6, 4, 6], [0, 3, 3, 3]],
    F: [[4, 0, 0, 0, 0, 6], [0, 3, 3, 3]],
    G: [[4, 1, 3, 0, 1, 0, 0, 1, 0, 5, 1, 6, 3, 6, 4, 5, 4, 3, 2.4, 3]],
    H: [[0, 0, 0, 6], [4, 0, 4, 6], [0, 3, 4, 3]],
    I: [[1, 0, 3, 0], [2, 0, 2, 6], [1, 6, 3, 6]],
    J: [[4, 0, 4, 5, 3, 6, 1, 6, 0, 5]],
    K: [[0, 0, 0, 6], [4, 0, 0, 3.4], [1.3, 2.4, 4, 6]],
    L: [[0, 0, 0, 6, 4, 6]],
    M: [[0, 6, 0, 0, 2, 3, 4, 0, 4, 6]],
    N: [[0, 6, 0, 0, 4, 6, 4, 0]],
    O: [O],
    P: [P],
    Q: [O, [2.4, 4.4, 4, 6]],
    R: [P, [1.8, 3, 4, 6]],
    S: [[4, 1, 3, 0, 1, 0, 0, 1, 0, 2, 1, 3, 3, 3, 4, 4, 4, 5, 3, 6, 1, 6, 0, 5]],
    T: [[0, 0, 4, 0], [2, 0, 2, 6]],
    U: [[0, 0, 0, 5, 1, 6, 3, 6, 4, 5, 4, 0]],
    V: [[0, 0, 2, 6, 4, 0]],
    W: [[0, 0, 1, 6, 2, 2.5, 3, 6, 4, 0]],
    X: [[0, 0, 4, 6], [4, 0, 0, 6]],
    Y: [[0, 0, 2, 3, 4, 0], [2, 3, 2, 6]],
    Z: [[0, 0, 4, 0, 0, 6, 4, 6]],
    0: [O],
    1: [[1, 1.2, 2.2, 0, 2.2, 6], [1, 6, 3.4, 6]],
    2: [[0, 1, 1, 0, 3, 0, 4, 1, 4, 2, 0, 6, 4, 6]],
    3: [[0, 1, 1, 0, 3, 0, 4, 1, 4, 2, 3, 3, 1.6, 3], [3, 3, 4, 4, 4, 5, 3, 6, 1, 6, 0, 5]],
    4: [[3, 6, 3, 0, 0, 4, 4, 4]],
    5: [[4, 0, 0, 0, 0, 3, 3, 3, 4, 4, 4, 5, 3, 6, 1, 6, 0, 5]],
    6: [[4, 1, 3, 0, 1, 0, 0, 1, 0, 5, 1, 6, 3, 6, 4, 5, 4, 4, 3, 3, 0, 3]],
    7: [[0, 0, 4, 0, 1.6, 6]],
    8: [[1, 0, 3, 0, 4, 1, 4, 2, 3, 3, 1, 3, 0, 2, 0, 1, 1, 0], [1, 3, 0, 4, 0, 5, 1, 6, 3, 6, 4, 5, 4, 4, 3, 3]],
    9: [[4, 3, 1, 3, 0, 2, 0, 1, 1, 0, 3, 0, 4, 1, 4, 5, 3, 6, 1, 6, 0, 5]],
    '.': [[2, 5.9, 2, 6]],
    ',': [[2, 5.6, 1.4, 6.8]],
    ':': [[2, 1.5, 2, 1.6], [2, 4.5, 2, 4.6]],
    '!': [[2, 0, 2, 4], [2, 5.9, 2, 6]],
    '-': [[0.6, 3, 3.4, 3]],
    '+': [[0.5, 3, 3.5, 3], [2, 1.5, 2, 4.5]],
    "'": [[2, 0, 2, 1.5]],
    '/': [[3.6, 0, 0.4, 6]],
    '×': [[0.6, 1.6, 3.4, 4.4], [3.4, 1.6, 0.6, 4.4]],
  };
  const ADVANCE = 5.6;

  const Font = {
    GLYPHS,
    ADVANCE,

    width(str, cap) {
      return ((str.length * ADVANCE - (ADVANCE - 4)) * cap) / 6;
    },

    // Draws in the context's current transform. x,y is the top of the capitals.
    draw(ctx, str, x, y, cap, opts = {}) {
      const u = cap / 6;
      const text = String(str).toUpperCase();
      const w = this.width(text, cap);
      const align = opts.align || 'left';
      const left = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
      const path = new Path2D();
      for (let i = 0; i < text.length; i++) {
        const g = GLYPHS[text[i]];
        if (!g) continue;
        const ox = left + i * ADVANCE * u;
        for (const line of g) {
          path.moveTo(ox + line[0] * u, y + line[1] * u);
          for (let k = 2; k < line.length; k += 2) path.lineTo(ox + line[k] * u, y + line[k + 1] * u);
        }
      }
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const weight = (opts.weight || 1.05) * u;
      if (opts.outline) {
        ctx.strokeStyle = opts.outline;
        ctx.lineWidth = weight + (opts.outlineWidth || 1.3 * u);
        ctx.stroke(path);
      }
      ctx.strokeStyle = opts.color || '#fff';
      ctx.lineWidth = weight;
      ctx.stroke(path);
    },

    // Flattens a string into pen strokes, for carving it out of the soil.
    strokes(str, x, y, cap) {
      const u = cap / 6;
      const out = [];
      for (let i = 0; i < str.length; i++) {
        const g = GLYPHS[str[i]];
        if (!g) continue;
        const ox = x + i * ADVANCE * u;
        for (const line of g) {
          const pts = [];
          for (let k = 0; k < line.length; k += 2) pts.push([ox + line[k] * u, y + line[k + 1] * u]);
          out.push(pts);
        }
      }
      return out;
    },
  };

  root.Font = Font;
})(globalThis);
