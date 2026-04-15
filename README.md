# Bow parameters — a Schelleng workshop

An interactive [Schelleng diagram](https://en.wikipedia.org/wiki/Schelleng_diagram)
paired with a bowed-string physical model. Drag the operating point across the
(β, F) plane, move the bow speed slider, tap the preset chips, and hear how the
traditional bowing labels — *sul tasto*, *sul ponticello*, *flautando*,
*ordinario*, *overpressure*, *Schnarrklang* — are just different coordinates
in the same three-dimensional space.

## Run it

Open `index.html` in a browser. If your browser refuses to load the
AudioWorklet over `file://`, serve the folder first:

```
cd bow-parameters
python3 -m http.server 8000
# open http://localhost:8000
```

Then flip the sound toggle (top-right). Audio is initialised on the first user
gesture. If the AudioWorklet can't load, the visual still works and a small
"audio unavailable" pill is shown.

## Files

- `index.html` — page shell.
- `styles.css` — layout and colours.
- `app.js` — Schelleng math, SVG, drag, presets, tour, audio glue.
- `bowed-string-worklet.js` — digital-waveguide bowed-string `AudioWorkletProcessor`.
