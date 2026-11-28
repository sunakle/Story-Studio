"""Build two local PNGs from the full Super Retro World Character Pack.

The character artwork is by Gif (@gif_not_jif), Noiracide (@Noiracide) and
Romi (@DessRomaric). Refer to LICENCE.txt in the supplied archive.
"""

import argparse
from contextlib import ExitStack
import io
import os
from pathlib import Path
import tempfile
from zipfile import ZipFile

from PIL import Image


SIZE = 16
COLUMNS = 12
# Preserve the established RPG tile IDs and keep every non-actor tile untouched.
STORY_ACTOR_IDS = (
    *range(216, 221), *range(228, 233), *range(240, 245), *range(252, 257),
    *range(276, 288),
)
# Numbering from the author's sprite_split directory. 230 is the hero (1),
# 216 the caretaker (31). Remaining actor variants continue in the final row.
PACK_CHARACTER_IDS = (
    31, 15, 10, 2, 14,
    8, 3, 1, 5, 18,
    27, 29, 24, 13, 7,
    9, 4, 20, 30, 28,
    6, 11, 12, 16, 17, 19, 21, 22, 23, 25, 26, 32,
)


def character_sheet(pack, number):
    name = f"character_{number}"
    path = f"SuperRetroWorld_CharacterPack_Full/sprite_split/{name}/{name}_frame16x20.png"
    entry = pack.getinfo(path)
    if entry.file_size > 64 * 1024:
        raise ValueError(f"Unexpected file size for {path}")
    with Image.open(io.BytesIO(pack.read(entry))) as image:
        if image.format != "PNG" or image.size != (48, 80):
            raise ValueError(f"Expected three 16x20 frames in each of four directions in {path}")
        return image.convert("RGBA")


def sprite_frame(sheet, step, direction):
    x, y = step * 16, direction * 20
    src = sheet.crop((x, y, x + 16, y + 20))
    if not src.getbbox():
        raise ValueError(f"Empty frame at ({step}, {direction})")
    # Use one transform for every frame to keep feet aligned as the hero turns.
    frame = Image.new("RGBA", (SIZE, SIZE))
    frame.paste(src.resize((13, SIZE), Image.Resampling.NEAREST), (1, 0))
    return frame


def convert(pack_path, terrain_path):
    with Image.open(terrain_path) as terrain:
        if terrain.format != "PNG" or terrain.size != (192, 368):
            raise ValueError("Expected the original 12-column StoryForge terrain atlas (192x368).")
        atlas = Image.new("RGBA", (COLUMNS * SIZE, 24 * SIZE))
        atlas.paste(terrain.convert("RGBA"))
    walk = Image.new("RGBA", (3 * SIZE, len(STORY_ACTOR_IDS) * 4 * SIZE))
    with ZipFile(pack_path) as pack:
        for actor_row, (tile_id, number) in enumerate(zip(STORY_ACTOR_IDS, PACK_CHARACTER_IDS, strict=True)):
            sheet = character_sheet(pack, number)
            for direction in range(4):  # down, left, right, up
                for step in range(3):  # left foot, idle, right foot
                    frame = sprite_frame(sheet, step, direction)
                    walk.paste(frame, (step * SIZE, (actor_row * 4 + direction) * SIZE))
                    if direction == 0 and step == 1:
                        atlas.paste(frame, ((tile_id % COLUMNS) * SIZE, (tile_id // COLUMNS) * SIZE))
    return atlas, walk


def write_new_pair(images, outputs):
    if outputs[0].resolve() == outputs[1].resolve() or any(p.exists() for p in outputs):
        raise ValueError("Choose two distinct, unused output filenames.")
    with ExitStack() as cleanup:
        staged = []
        for image, output in zip(images, outputs, strict=True):
            output.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=output.parent, suffix=".png", delete=False) as tmp:
                temporary = Path(tmp.name)
                cleanup.callback(temporary.unlink, missing_ok=True)
                image.save(tmp, format="PNG", optimize=True)
            staged.append(temporary)
        # Commit exclusively so overlapping conversions cannot overwrite a file.
        os.link(staged[0], outputs[0])
        try:
            os.link(staged[1], outputs[1])
        except OSError:
            outputs[0].unlink(missing_ok=True)
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("terrain", type=Path, help="Existing StoryForge terrain PNG")
    parser.add_argument("atlas", type=Path, help="Output terrain + character palette PNG")
    parser.add_argument("walk", type=Path, help="Output 48x2048 walking sheet PNG")
    args = parser.parse_args()
    try:
        write_new_pair(convert(args.archive, args.terrain), (args.atlas, args.walk))
    except (OSError, ValueError, KeyError) as err:
        parser.exit(1, f"{parser.prog}: {err}\n")
    print(f"Created {args.atlas} (192x384) and {args.walk} (48x2048) for 32 characters.")


if __name__ == "__main__":
    main()
