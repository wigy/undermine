# Undermine

A dig-and-pump arcade game in the spirit of the 1982 coin-ops, with modern graphics.
No build step and no dependencies: open `index.html` in a browser.

| Action | Keyboard | Touch | Gamepad |
| --- | --- | --- | --- |
| Move and dig | Arrows or WASD | Drag on the left side | D-pad or stick |
| Fire and pump | Space, Z or X (hold to keep pumping) | Hold on the right side | A, B or X |
| Pause | P or Esc | | Start |
| Mute | M | | |

Pump an enemy four times to pop it. Deeper pops score more, and a fire drake popped from the side
scores double. Dig under a rock to drop it: crushing several at once pays far more. After two rocks
fall, a bonus vegetable appears in the centre. The last enemy runs for the surface.

`src/sim.js` holds the rules and has no DOM, so `npm test` runs them in Node.
`src/render.js` paints everything procedurally, and `src/audio.js` synthesises all sound, so the game has no asset files.
