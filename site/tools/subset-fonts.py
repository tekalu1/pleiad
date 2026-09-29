"""サイトで使う字だけに削った woff2 を assets/fonts/ に作る。

文言（index.html・main.js・hero.js）を変えたら流し直す。
元の書体は google/fonts から temporary/fonts/ に落とす（コミットしない）。
要るもの: python の fontTools と brotli（pip install fonttools brotli）。

    python site/tools/subset-fonts.py
"""
import html
import pathlib
import re
import subprocess
import sys
import urllib.request

SITE = pathlib.Path(__file__).resolve().parent.parent
REPO = SITE.parent
CACHE = REPO / "temporary" / "fonts"
OUT = SITE / "assets" / "fonts"
SOURCES = {
    "NotoSansJP[wght].ttf": "ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf",
    "Geist[wght].ttf": "ofl/geist/Geist%5Bwght%5D.ttf",
    "GeistMono[wght].ttf": "ofl/geistmono/GeistMono%5Bwght%5D.ttf",
}


def fetch():
    CACHE.mkdir(parents=True, exist_ok=True)
    for name, path in SOURCES.items():
        dest = CACHE / name
        if not dest.exists():
            urllib.request.urlretrieve(f"https://github.com/google/fonts/raw/main/{path}", dest)


def used_text():
    text = ""
    for name in ["index.html", "main.js", "hero.js"]:
        t = (SITE / name).read_text(encoding="utf-8")
        if name.endswith(".html"):
            t = re.sub(r"<svg.*?</svg>", "", t, flags=re.S)
            t = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", t, flags=re.S)
            t = html.unescape(re.sub(r"<[^>]+>", " ", t))
        text += t
    ascii_ = "".join(chr(c) for c in range(0x20, 0x7F))
    extra = "、。・「」（）→✓…◆◇◐○◌·—–％：＋"
    return "".join(sorted(set(text + ascii_ + extra) - set("\n\r\t")))


def subset(src, out, text=None, unicodes=None):
    args = [sys.executable, "-m", "fontTools.subset", str(CACHE / src), f"--output-file={OUT / out}",
            "--flavor=woff2", "--layout-features=palt,kern,liga,calt,tnum", "--no-hinting", "--desubroutinize"]
    if text:
        args.append(f"--text={text}")
    if unicodes:
        args.append(f"--unicodes={unicodes}")
    subprocess.run(args, check=True)
    print(out, (OUT / out).stat().st_size, "bytes")


if __name__ == "__main__":
    fetch()
    OUT.mkdir(parents=True, exist_ok=True)
    subset("NotoSansJP[wght].ttf", "noto-sans-jp.woff2", text=used_text())
    subset("Geist[wght].ttf", "geist.woff2", unicodes="U+0020-007E,U+00A0-00FF,U+2013,U+2014,U+2019,U+201C,U+201D,U+2022,U+2026,U+00B7,U+2192")
    subset("GeistMono[wght].ttf", "geist-mono.woff2", unicodes="U+0020-007E,U+00B7")
