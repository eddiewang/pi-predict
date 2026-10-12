#!/usr/bin/env python3
"""Draw terminal frames from `tmux capture-pane -p -e -N` as one animated SVG.

The text becomes glyph outlines of Fira Code (SIL Open Font License 1.1), so the image needs no font and looks the
same in every browser. Rows that all frames share are drawn once. Each frame is a group with the classes `f` and
`f-<name>`, and its rows that differ are groups with the class `r<row>`. The row with the prediction arrow also has
the class `pred`. The key cap over "tab" has the class `k`. The CSS file animates these classes.

Needs fontTools (`pip install fonttools`). The script downloads Fira Code 6.2 and checks its SHA-256.
"""

import argparse
import hashlib
import html
import io
import re
import urllib.request
import zipfile
from dataclasses import dataclass, field

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

FONT_ZIP_URL = "https://github.com/tonsky/FiraCode/releases/download/6.2/Fira_Code_v6.2.zip"
FONT_ZIP_SHA256 = "0949915ba8eb24d89fd93d10a7ff623f42830d7c5ffc3ecbf960e4ecad3e3e79"
FONT_NOTICE = "Glyphs: Fira Code, Copyright 2014-2021 The Fira Code Project Authors, SIL Open Font License 1.1"
ARROW = "\u21b3"
RULE = "\u2500"

CSI = re.compile(r"\x1b\[([0-9;:?]*)([A-Za-z])")
PALETTE16 = [
    "#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
    "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff",
]


def xterm256(n: int) -> str:
    if n < 16:
        return PALETTE16[n]
    if n < 232:
        n -= 16
        steps = [0, 95, 135, 175, 215, 255]
        return "#%02x%02x%02x" % (steps[n // 36], steps[(n // 6) % 6], steps[n % 6])
    v = 8 + (n - 232) * 10
    return "#%02x%02x%02x" % (v, v, v)


@dataclass(frozen=True)
class Style:
    fg: str | None = None
    bg: str | None = None
    bold: bool = False
    inverse: bool = False


@dataclass
class Cell:
    ch: str = " "
    style: Style = field(default_factory=Style)


def apply_sgr(style: Style, params: str) -> Style:
    """Pi's themes use explicit colors, so dim, italic, and underline are not drawn."""
    parts = params.replace(":", ";").split(";") if params else ["0"]
    s = dict(fg=style.fg, bg=style.bg, bold=style.bold, inverse=style.inverse)
    i = 0
    while i < len(parts):
        p = int(parts[i] or 0)
        if p == 0:
            s = dict(fg=None, bg=None, bold=False, inverse=False)
        elif p == 1:
            s["bold"] = True
        elif p == 22:
            s["bold"] = False
        elif p == 7:
            s["inverse"] = True
        elif p == 27:
            s["inverse"] = False
        elif p in (38, 48):
            key = "fg" if p == 38 else "bg"
            if parts[i + 1] == "2":
                s[key] = "#%02x%02x%02x" % tuple(int(v) for v in parts[i + 2 : i + 5])
                i += 4
            elif parts[i + 1] == "5":
                s[key] = xterm256(int(parts[i + 2]))
                i += 2
        elif p == 39:
            s["fg"] = None
        elif p == 49:
            s["bg"] = None
        elif 30 <= p <= 37 or 90 <= p <= 97:
            s["fg"] = PALETTE16[p - 30 if p < 90 else p - 82]
        elif 40 <= p <= 47 or 100 <= p <= 107:
            s["bg"] = PALETTE16[p - 40 if p < 100 else p - 92]
        i += 1
    return Style(**s)


def parse_frame(text: str, cols: int, rows: int) -> list[list[Cell]]:
    grid = [[Cell() for _ in range(cols)] for _ in range(rows)]
    style = Style()  # tmux carries the attributes from one line to the next
    for r, line in enumerate(text.split("\n")[:rows]):
        c = pos = 0
        while pos < len(line):
            m = CSI.match(line, pos)
            if m:
                if m.group(2) == "m":
                    style = apply_sgr(style, m.group(1))
                pos = m.end()
                continue
            if c < cols:
                grid[r][c] = Cell(line[pos], style)
            c += 1
            pos += 1
    return grid


def fmt(v: float) -> str:
    return ("%.2f" % v).rstrip("0").rstrip(".") or "0"


class Glyphs:
    def __init__(self, fonts: dict[bool, TTFont], size: float):
        self.fonts = fonts
        self.sets = {bold: f.getGlyphSet() for bold, f in fonts.items()}
        self.cmaps = {bold: f.getBestCmap() for bold, f in fonts.items()}
        regular = fonts[False]
        self.scale = size / regular["head"].unitsPerEm
        self.cell_w = regular["hmtx"][self.cmaps[False][ord("a")]][0] * self.scale
        self.ascent = regular["hhea"].ascent * self.scale
        self.descent = -regular["hhea"].descent * self.scale
        self.ids: dict[tuple[str, bool], str | None] = {}
        self.paths: dict[str, str] = {}

    def glyph_id(self, ch: str, bold: bool) -> str | None:
        key = (ch, bold)
        if key not in self.ids:
            name = self.cmaps[bold].get(ord(ch))
            if name is None:
                raise SystemExit(f"Fira Code has no glyph for {ch!r} (U+{ord(ch):04X})")
            pen = SVGPathPen(self.sets[bold], ntos=fmt)
            self.sets[bold][name].draw(TransformPen(pen, (self.scale, 0, 0, -self.scale, 0, 0)))
            d = pen.getCommands()
            gid = ("b" if bold else "r") + "%x" % ord(ch)
            self.ids[key] = gid if d else None
            if d:
                self.paths[gid] = d
        return self.ids[key]

    def bounds(self, ch: str) -> tuple[float, float, float, float]:
        pen = BoundsPen(self.sets[False])
        self.sets[False][self.cmaps[False][ord(ch)]].draw(pen)
        return pen.bounds


class Painter:
    def __init__(self, glyphs: Glyphs, opt: argparse.Namespace):
        self.g = glyphs
        self.opt = opt
        self.lh = opt.font_size * opt.line_height
        self.base = (self.lh - (glyphs.ascent + glyphs.descent)) / 2 + glyphs.ascent
        self.rule = glyphs.bounds(RULE)

    def colors(self, style: Style) -> tuple[str, str | None]:
        fg, bg = style.fg or self.opt.fg, style.bg
        if style.inverse:
            fg, bg = bg or self.opt.card, fg
        return fg, bg

    def x(self, col: int) -> float:
        return self.opt.pad_x + col * self.g.cell_w

    def rows(self, rows: dict[int, list[Cell]]) -> str:
        """Backgrounds (equal spans on adjacent rows merged), rules, then glyphs grouped by color."""
        out: list[str] = []
        spans: list[list] = []  # [row, rows, c0, c1, color]
        for r, cells in sorted(rows.items()):
            c = 0
            while c < len(cells):
                bg = self.colors(cells[c].style)[1]
                c1 = c
                while c1 + 1 < len(cells) and self.colors(cells[c1 + 1].style)[1] == bg:
                    c1 += 1
                if bg is not None:
                    for span in spans:
                        if span[0] + span[1] == r and span[2:] == [c, c1 + 1, bg]:
                            span[1] += 1
                            break
                    else:
                        spans.append([r, 1, c, c1 + 1, bg])
                c = c1 + 1
        for r, n, c0, c1, color in spans:
            y = self.opt.pad_y + r * self.lh
            w = self.x(c1) - self.x(c0)
            out.append(f'<rect x="{fmt(self.x(c0))}" y="{fmt(y)}" width="{fmt(w)}" height="{fmt(n * self.lh)}" fill="{color}"/>')
        by_color: dict[str, list[str]] = {}
        for r, cells in sorted(rows.items()):
            y = self.opt.pad_y + r * self.lh + self.base
            c = 0
            while c < len(cells):
                cell = cells[c]
                fg = self.colors(cell.style)[0]
                if cell.ch == RULE:  # a run of box rules becomes one bar, with no seams
                    c1 = c
                    while c1 + 1 < len(cells) and cells[c1 + 1].ch == RULE and self.colors(cells[c1 + 1].style)[0] == fg:
                        c1 += 1
                    top = y - self.rule[3] * self.g.scale
                    height = (self.rule[3] - self.rule[1]) * self.g.scale
                    width = self.x(c1 + 1) - self.x(c)
                    out.append(f'<rect x="{fmt(self.x(c))}" y="{fmt(top)}" width="{fmt(width)}" height="{fmt(height)}" fill="{fg}"/>')
                    c = c1 + 1
                    continue
                if cell.ch != " ":
                    gid = self.g.glyph_id(cell.ch, cell.style.bold)
                    if gid:
                        by_color.setdefault(fg, []).append(f'<use xlink:href="#{gid}" x="{fmt(self.x(c))}" y="{fmt(y)}"/>')
                c += 1
        out.extend(f'<g fill="{color}">{"".join(uses)}</g>' for color, uses in by_color.items())
        return "".join(out)


def load_fonts(zip_path: str | None) -> dict[bool, TTFont]:
    if zip_path:
        with open(zip_path, "rb") as fh:
            data = fh.read()
    else:
        with urllib.request.urlopen(FONT_ZIP_URL) as response:
            data = response.read()
    digest = hashlib.sha256(data).hexdigest()
    if digest != FONT_ZIP_SHA256:
        raise SystemExit(f"Fira Code zip: SHA-256 {digest}, expected {FONT_ZIP_SHA256}")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        return {bold: TTFont(io.BytesIO(archive.read(f"ttf/FiraCode-{'Bold' if bold else 'Regular'}.ttf"))) for bold in (False, True)}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--frames", nargs="+", required=True, help="name=path pairs; frame B has the prediction")
    ap.add_argument("--css", required=True)
    ap.add_argument("--cols", type=int, required=True)
    ap.add_argument("--rows", type=int, required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--title", default="pi-predict")
    ap.add_argument("--desc", default="")
    ap.add_argument("--font-zip", help="a local copy of the Fira Code 6.2 zip")
    ap.add_argument("--font-size", type=float, default=15)
    ap.add_argument("--line-height", type=float, default=1.35)
    ap.add_argument("--pad-x", type=float, default=28)
    ap.add_argument("--pad-y", type=float, default=24)
    ap.add_argument("--radius", type=float, default=12)
    ap.add_argument("--fg", default="#dee0e1", help="the terminal's default text color (Pi's dark theme text)")
    ap.add_argument("--card", default="#131417")
    ap.add_argument("--stroke", default="rgba(255,255,255,0.09)")
    ap.add_argument("--key-fill", default="#262a31")
    ap.add_argument("--key-stroke", default="#4b525c")
    opt = ap.parse_args()

    glyphs = Glyphs(load_fonts(opt.font_zip), opt.font_size)
    paint = Painter(glyphs, opt)
    width = opt.pad_x * 2 + opt.cols * glyphs.cell_w
    height = opt.pad_y * 2 + opt.rows * paint.lh

    frames: dict[str, list[list[Cell]]] = {}
    for pair in opt.frames:
        name, path = pair.split("=", 1)
        with open(path, encoding="utf-8") as fh:
            frames[name] = parse_frame(fh.read(), opt.cols, opt.rows)
    names = list(frames)
    text = lambda name, r: "".join(c.ch for c in frames[name][r])  # noqa: E731

    shared: dict[int, list[Cell]] = {}
    differs: list[int] = []
    for r in range(opt.rows):
        if len({tuple((c.ch, c.style) for c in frames[n][r]) for n in names}) == 1:
            shared[r] = frames[names[0]][r]
        else:
            differs.append(r)

    body = [paint.rows(shared)]
    for n in names:
        groups = []
        for r in differs:
            classes = f"r{r}" + (" pred" if ARROW in text(n, r) else "")
            groups.append(f'<g class="{classes}">{paint.rows({r: frames[n][r]})}</g>')
        body.append(f'<g class="f f-{n}">{"".join(groups)}</g>')

    # The key cap: "tab" at the end of the prediction line in frame B.
    pred_row = next(r for r in range(opt.rows) if ARROW in text("B", r))
    c1 = len(text("B", pred_row).rstrip())
    c0 = c1 - 3
    if text("B", pred_row)[c0:c1] != "tab":
        raise SystemExit("frame B: the prediction line does not end with 'tab'")
    pad = 4
    cap = [Cell(c.ch, Style(fg=opt.fg)) if c0 <= i < c1 else Cell() for i, c in enumerate(frames["B"][pred_row])]
    body.append(
        '<g class="k">'
        f'<rect x="{fmt(paint.x(c0) - pad)}" y="{fmt(opt.pad_y + pred_row * paint.lh + 1.5)}" width="{fmt(paint.x(c1) - paint.x(c0) + 2 * pad)}"'
        f' height="{fmt(paint.lh - 3)}" rx="4" fill="{opt.key_fill}" stroke="{opt.key_stroke}"/>'
        f"{paint.rows({pred_row: cap})}</g>"
    )

    with open(opt.css, encoding="utf-8") as fh:
        css = re.sub(r"\s*\n\s*", "", re.sub(r"/\*.*?\*/", "", fh.read(), flags=re.S))
    defs = "".join(f'<path id="{gid}" d="{d}"/>' for gid, d in sorted(glyphs.paths.items()))
    w, h = fmt(width), fmt(height)
    desc = f"<desc>{html.escape(opt.desc, quote=False)}</desc>" if opt.desc else ""
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{w}" height="{h}"'
        f' viewBox="0 0 {w} {h}" role="img" aria-label="{html.escape(opt.title)}">'
        f"<title>{html.escape(opt.title, quote=False)}</title>{desc}<!-- {FONT_NOTICE} -->"
        f"<style>{css}</style><defs>{defs}</defs>"
        f'<rect width="{w}" height="{h}" rx="{fmt(opt.radius)}" fill="{opt.card}"/>'
        + "".join(body)
        + f'<rect x="0.5" y="0.5" width="{fmt(width - 1)}" height="{fmt(height - 1)}" rx="{fmt(opt.radius - 0.5)}"'
        f' fill="none" stroke="{opt.stroke}"/></svg>\n'
    )
    with open(opt.out, "w", encoding="utf-8") as fh:
        fh.write(svg)
    print(f"{opt.out}: {len(svg.encode()) / 1024:.1f} KiB, {w}x{h}")


if __name__ == "__main__":
    main()
