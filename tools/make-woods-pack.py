"""Build a local StoryForge atlas from the user's Pixel 16 Woods v2 free ZIP."""

import argparse
import hashlib
import io
import math
import os
from pathlib import Path
import tempfile
from zipfile import ZipFile

from PIL import Image


SIZE = 16
SOURCE_NAME = "free_pixel_16_woods.png"
SOURCE_HASH = "8b31588ae4299cf2b11c888e9ed6c872b6ae0b0b9301fae19fe5a0751632d812"
BASE = Path(__file__).resolve().parents[1] / "src/assets/rpg/kenney-tiny-rpg.png"


def read_sheet(archive):
    with ZipFile(archive) as z:
        entries = [e for e in z.infolist() if e.filename.rsplit("/", 1)[-1] == SOURCE_NAME]
        if len(entries) != 1 or entries[0].file_size != 16669:
            raise ValueError(f"Expected the free v2 archive containing {SOURCE_NAME}.")
        data = z.read(entries[0])
    if hashlib.sha256(data).hexdigest() != SOURCE_HASH:
        raise ValueError("Different sprite sheet revision. This conversion targets Pixel 16 Woods v2 free.")
    with Image.open(io.BytesIO(data)) as image:
        return image.convert("RGBA")


def cell(atlas, index):
    columns = atlas.width // SIZE
    x, y = index % columns * SIZE, index // columns * SIZE
    return atlas.crop((x, y, x + SIZE, y + SIZE))


def fit_sprite(sprite, w=SIZE, h=SIZE):
    data = sprite.crop(sprite.getbbox())
    scale = min(w / data.width, h / data.height)
    width, height = max(1, round(data.width * scale)), max(1, round(data.height * scale))
    data = data.resize((width, height), Image.Resampling.NEAREST)
    canvas = Image.new("RGBA", (w, h))
    canvas.paste(data, ((w - width) // 2, h - height))
    return canvas


def terrain_borders(sheet, wet):
    """Adapt land-outside transitions from the artist's land-inside island.

    Each directional strip is read from grass towards the road/water. Using
    the same strip for an edge and its adjacent corner keeps joins continuous.
    """
    ground = cell(sheet, 69).getpixel((0, 0))
    surface = cell(sheet, 145 if wet else 73).getpixel((0, 0))
    ids = (231, 143, 189, 185) if wet else (113, 25, 71, 67)
    strips = dict(zip("NSWE", (cell(sheet, n) for n in ids)))
    thickness = 8 if wet else 7

    def edge_pixel(side, depth, across):
        if depth < 0:
            return ground
        if depth >= thickness:
            return surface
        pos = round(depth * 15 / (thickness - 1))
        pos = max(0, min(15, pos))
        if side == "N":
            xy = across, pos
        elif side == "S":
            xy = across, 15 - pos
        elif side == "W":
            xy = pos, across
        else:
            xy = 15 - pos, across
        pixel = strips[side].getpixel(xy)
        return pixel if pixel[3] else surface

    def make(sides, inner=False):
        out = Image.new("RGBA", (SIZE, SIZE))
        for y in range(SIZE):
            for x in range(SIZE):
                distance = {"N": y, "S": 15-y, "W": x, "E": 15-x}
                side = min(sides, key=distance.get)
                depth = distance[side]
                if len(sides) == 2:
                    a, b = (distance[s] for s in sides)
                    if inner:
                        depth = math.hypot(a, b)
                    elif max(a, b) < 12:
                        depth = 12 - math.hypot(12-a, 12-b)
                across = x if side in "NS" else y
                out.putpixel((x, y), edge_pixel(side, depth, across))
        return out

    return make


def timber(legacy, sheet):
    """Keep saved fence junctions connected and surface the rails in weathered wood."""
    wood = cell(sheet, 226)
    outline = sheet.getpixel((120, 175))
    out = legacy.copy()
    for y in range(SIZE):
        for x in range(SIZE):
            pixel = legacy.getpixel((x, y))
            if not pixel[3]:
                continue
            if pixel[:3] == (63, 38, 49):
                shade = outline
            else:
                offset = 7 if pixel[0] >= 230 else 10
                shade = wood.getpixel((x, offset + y % 4))
            out.putpixel((x, y), shade)
    return out


def build(sheet):
    with Image.open(BASE) as image:
        atlas = image.convert("RGBA")
    if atlas.size != (192, 368):
        raise ValueError("Unsupported base atlas layout.")
    def put(index, tile):
        atlas.paste(tile, ((index % 12) * SIZE, (index // 12) * SIZE))

    grass = cell(sheet, 69)
    put(0, grass)
    grass_patch = Image.alpha_composite(grass, cell(sheet, 117))
    put(1, Image.alpha_composite(grass_patch, cell(sheet, 72)))
    put(2, Image.alpha_composite(grass, cell(sheet, 115)))
    put(25, cell(sheet, 73))
    put(43, Image.alpha_composite(grass, cell(sheet, 58)))
    trees = [sheet.crop(bounds) for bounds in ((272,0,352,88), (272,89,304,144), (304,89,352,144))]
    oak, sapling, pine = trees
    for index, sprite in [(3,pine), (4,sapling), (5,oak), (15,oak), (16,sapling), (27,pine), (28,oak)]:
        if index in (15,16,27,28):
            small = fit_sprite(sprite, 12, 13)
            tile = Image.new("RGBA", (SIZE, SIZE))
            tile.paste(small, (2, 3))
            put(index, tile)
        else:
            put(index, fit_sprite(sprite))
    # Preserve the original two 3x3 forest stamp ID sequences, as well as
    # one-cell versions for maps drawn with the standalone tree brush.
    for start, tree in ((6,oak), (9,pine)):
        crown = fit_sprite(tree, 48, 48)
        for y in range(3):
            for x in range(3):
                put(start + y*12 + x, cell(crown, y*3+x))
    put(17, cell(sheet, 80))
    put(29, cell(sheet, 102))
    put(106, fit_sprite(sheet.crop((228,78,252,95))))

    directions = ("NW","N","NE","W","E","SW","S","SE")
    for wet, indices, inner in [
        (False, (12,13,14,24,26,36,37,38), (39,40,41,42)),
        (True, (265,266,267,268,269,270,271,272), (273,274)),
    ]:
        make = terrain_borders(sheet, wet)
        for index, side in zip(indices, directions):
            put(index, make(side))
        for index, side in zip(inner, ("NW","NE","SW","SE")):
            put(index, make(side, inner=True))
    put(264, cell(sheet, 145))
    pond = Image.alpha_composite(cell(sheet, 145), cell(sheet, 170))
    pond.alpha_composite(fit_sprite(cell(sheet, 191), 10, 8), (0, 8))
    put(275, pond)

    for index in [44,45,46,47,56,58,59,68,69,70,71,80,81,82]:
        put(index, timber(cell(atlas,index), sheet))
    return atlas


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("zip", type=Path)
    parser.add_argument("output", type=Path, help="Destination PNG for personal local use")
    parser.add_argument("--force", action="store_true", help="Replace an existing destination")
    args = parser.parse_args()
    if args.output.exists() and not args.force:
        parser.error("Destination already exists. Choose another path or pass --force.")
    atlas = build(read_sheet(args.zip))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=args.output.parent, suffix=".png", delete=False) as f:
        temp = Path(f.name)
    try:
        atlas.save(temp, format="PNG", optimize=True)
        if args.force:
            os.replace(temp, args.output)
        else:
            os.link(temp, args.output)
    finally:
        temp.unlink(missing_ok=True)
    print(f"Created {args.output} ({atlas.width} x {atlas.height})")


if __name__ == "__main__":
    main()
