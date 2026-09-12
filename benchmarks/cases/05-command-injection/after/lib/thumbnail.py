import subprocess

def make_thumbnail(src: str, size: str) -> bytes:
    out = subprocess.run(
        f"convert {src} -resize {size} png:-",
        shell=True, capture_output=True, check=True,
    )
    return out.stdout
