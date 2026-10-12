# The README demo

`docs/demo.svg` is a capture of Pi's default terminal UI with pi-predict. To
make it again, for example after a change to the display:

```sh
npm ci
node scripts/demo/make.ts
```

The scripts need tmux, fd, ripgrep, and python3 with fontTools
(`pip install fonttools`).

- `make.ts` starts Pi from `node_modules` in a tmux pane of 80 by 13 cells,
  with the dark theme, in a temporary HOME. A local fake provider streams
  fixed replies, so the run needs no credentials and costs nothing. The script
  sends the request, then captures three frames: the reply (A), the prediction
  (B), and the editor after Tab (C).
- `render.py` draws the frames as one SVG. The text becomes glyph outlines of
  [Fira Code](https://github.com/tonsky/FiraCode) 6.2 (SIL Open Font License
  1.1), so the image needs no font. The script downloads Fira Code and checks
  its SHA-256.
- `demo.css` animates the frames. With `prefers-reduced-motion`, the image
  shows frame B only.
