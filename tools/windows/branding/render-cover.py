"""Regenerate the checked-in installer artwork using Python and Pillow."""

from math import exp
from pathlib import Path

from PIL import Image, ImageDraw


HERE = Path(__file__).resolve().parent
MARK = HERE.parents[2] / "src/assets/storyforge-mark.png"
SCALE = 4
SIZE = (164 * SCALE, 314 * SCALE)


def point(xy):
    return tuple(round(value * SCALE) for value in xy)


def line(draw, points, color, width=0.5):
    draw.line([point(p) for p in points], fill=color, width=max(1, round(width * SCALE)))


def circle(draw, center, radius, fill):
    x, y = center
    draw.ellipse([point((x - radius, y - radius)), point((x + radius, y + radius))], fill=fill)


def cover():
    base = Image.new("RGB", SIZE)
    pixels = base.load()
    for y in range(SIZE[1]):
        for x in range(SIZE[0]):
            u, v = x / SCALE, y / SCALE
            light = exp(-(((u - 104) / 99) ** 2 + ((v - 118) / 105) ** 2))
            pixels[x, y] = (round(22 + 31 * light), round(20 + 16 * light), round(30 + 44 * light))
    draw = ImageDraw.Draw(base, "RGBA")

    # The editor's canvas grid recedes into the blank margins of the cover.
    for y in range(8, 314, 8):
        for x in range(4, 164, 8):
            circle(draw, (x, y), 0.4, (195, 169, 230, 30))

    # Three sheets in perspective, with a simple branching story on the top one.
    outline = [(-26, 177), (95, 141), (197, 176), (72, 222)]
    for offset, opacity in [(10, 45), (5, 80), (0, 138)]:
        sheet = [(x, y + offset) for x, y in outline]
        draw.polygon([point(p) for p in sheet], fill=(45, 36, 61, 200))
        line(draw, sheet + sheet[:1], (155, 128, 195, opacity))

    branches = [
        ([(46, 157), (66, 164), (41, 172), (66, 181)], (208, 181, 244, 220)),
        ([(66, 164), (95, 155), (116, 162)], (167, 134, 208, 150)),
        ([(66, 181), (93, 172), (124, 183), (103, 191)], (200, 167, 237, 220)),
        ([(66, 181), (45, 189), (74, 199)], (167, 134, 208, 150)),
    ]
    for points, color in branches:
        line(draw, points, color, 0.9)
    for center in [(46, 157), (66, 164), (66, 181), (116, 162), (103, 191), (74, 199)]:
        circle(draw, center, 2.3, (205, 179, 232, 255))
        circle(draw, center, 1.3, (66, 43, 88, 255))

    # Place the existing application nib on the starting node.
    with Image.open(MARK) as original:
        mark = original.convert("RGBA")
        mark = mark.crop(mark.getchannel("A").getbbox())
    height = round(102 * SCALE)
    mark = mark.resize((round(mark.width * height / mark.height), height), Image.Resampling.LANCZOS)
    base.paste(mark, point((46, 55)), mark)
    return base


if __name__ == "__main__":
    cover().save(HERE / "wizard-cover.png", optimize=True)
