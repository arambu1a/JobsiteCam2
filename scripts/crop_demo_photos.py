"""Center-crop normalized JPEGs to the phone screen and write scene-1..5.jpg.

Called by prep-demo-photos.sh; not meant to be run directly.
"""
import os
import sys

from PIL import Image, ImageOps

W, H = 1320, 2868   # iPhone 17/16 Pro Max, matches the screenshot size exactly
SLOTS = 5


def main(src_dir, out_dir):
    names = sorted(f for f in os.listdir(src_dir) if f.lower().endswith(".jpg"))
    if not names:
        sys.exit("nothing to crop")

    for slot in range(1, SLOTS + 1):
        # Repeat the supplied photos if there are fewer than five.
        src = os.path.join(src_dir, names[(slot - 1) % len(names)])
        img = Image.open(src)
        img = ImageOps.exif_transpose(img)      # honour rotation before dropping EXIF
        img = img.convert("RGB")
        # The viewfinder uses resizeMode="cover"; pre-cropping to the same aspect
        # means what you see here is exactly what lands in the screenshot.
        img = ImageOps.fit(img, (W, H), method=Image.LANCZOS, centering=(0.5, 0.5))

        dst = os.path.join(out_dir, f"scene-{slot}.jpg")
        clean = Image.new("RGB", img.size)      # new image carries no EXIF
        clean.paste(img)
        clean.save(dst, "JPEG", quality=90, optimize=True)
        print(f"scene-{slot}.jpg  <- {os.path.basename(src)}  {W}x{H}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
