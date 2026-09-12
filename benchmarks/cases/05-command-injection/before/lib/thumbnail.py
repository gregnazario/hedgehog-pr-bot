import subprocess

def make_thumbnail(src: str, size: str) -> bytes:
    out = subprocess.run(
        ["convert", src, "-resize", size, "png:-"],
        capture_output=True, check=True,
    )
    return out.stdout
