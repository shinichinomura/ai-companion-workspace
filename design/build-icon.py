# 承認済みデザイン tb-narrow-left.png を macOS アプリアイコンに加工するスクリプト。
# 手順:
#  1. 元画像から暗いスクワークル本体を検出して正方形に切り出す（白背景と影を除去）。
#  2. Apple 風スクワークル（超楕円）でマスクし、角を透明化。
#  3. 余白を持たせて 1024px キャンバスに配置し、ごく薄いドロップシャドウを付与。
#  4. .iconset を生成し iconutil で build/icon.icns を作る。
import os
import subprocess
import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "design/icon-candidates/tb-narrow-left.png")
OUT_DIR = os.path.join(ROOT, "design/app-icon")
BUILD_DIR = os.path.join(ROOT, "build")
ICONSET = os.path.join(BUILD_DIR, "icon.iconset")
os.makedirs(OUT_DIR, exist_ok=True)
os.makedirs(ICONSET, exist_ok=True)

CANVAS = 1024     # 最終キャンバス
ART = 824         # スクワークルの一辺（Big Sur の標準的な余白比）
N_EXP = 5.0       # 超楕円の指数（5 ≒ Apple のスクワークル）

# --- 1. 暗いスクワークル本体を検出して正方形に切り出す ---
im = Image.open(SRC).convert("RGB")
a = np.asarray(im).astype(np.float64)
lum = a @ np.array([0.299, 0.587, 0.114])
mask = lum < 110
ys, xs = np.where(mask)
cx = (xs.min() + xs.max()) / 2.0
cy = (ys.min() + ys.max()) / 2.0
# 縦横の小さい方を基準に、外周のアンチエイリアス/にじみを避けて少し内側で切る
side = min(xs.max() - xs.min(), ys.max() - ys.min())
inset = 14
side = int(side - 2 * inset)
left = int(round(cx - side / 2))
top = int(round(cy - side / 2))
crop = im.crop((left, top, left + side, top + side)).resize((ART, ART), Image.LANCZOS)

# --- 2. 超楕円マスクを作って角を透明化（4x スーパーサンプリングで滑らかに）---
SS = 4
M = ART * SS
yy, xx = np.mgrid[0:M, 0:M]
nx = (xx + 0.5) / M * 2 - 1
ny = (yy + 0.5) / M * 2 - 1
inside = (np.abs(nx) ** N_EXP + np.abs(ny) ** N_EXP) <= 1.0
mask_img = Image.fromarray((inside * 255).astype("uint8")).resize((ART, ART), Image.LANCZOS)

art = crop.convert("RGBA")
art.putalpha(mask_img)

# --- 3. キャンバスへ配置 + ごく薄いドロップシャドウ ---
ox = (CANVAS - ART) // 2
oy = (CANVAS - ART) // 2
canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))

shadow_alpha = mask_img.point(lambda v: int(v * 0.28))
black = Image.new("RGBA", (ART, ART), (0, 0, 0, 255))
black.putalpha(shadow_alpha)
shadow_layer = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
shadow_layer.paste(black, (ox, oy + 12), black)
shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(16))
canvas = Image.alpha_composite(canvas, shadow_layer)
canvas.paste(art, (ox, oy), art)

master = os.path.join(OUT_DIR, "master-1024.png")
canvas.save(master)
print("master:", master)

# --- 4. .iconset を生成して iconutil で .icns 化 ---
specs = [
    (16, "icon_16x16.png"), (32, "icon_16x16@2x.png"),
    (32, "icon_32x32.png"), (64, "icon_32x32@2x.png"),
    (128, "icon_128x128.png"), (256, "icon_128x128@2x.png"),
    (256, "icon_256x256.png"), (512, "icon_256x256@2x.png"),
    (512, "icon_512x512.png"), (1024, "icon_512x512@2x.png"),
]
for size, name in specs:
    canvas.resize((size, size), Image.LANCZOS).save(os.path.join(ICONSET, name))

icns = os.path.join(BUILD_DIR, "icon.icns")
subprocess.run(["iconutil", "-c", "icns", ICONSET, "-o", icns], check=True)
print("icns:", icns)

# 確認用の小さなプレビュー HTML
prev_sizes = [1024, 256, 128, 64, 32, 16]
imgs = "".join(
    f'<span><img src="../app-icon/master-1024.png" width="{s}"><br>{s}</span>'
    for s in prev_sizes
)
html = f"""<!doctype html><meta charset=utf-8>
<title>Noetelier icon preview</title>
<body style="margin:0;padding:32px;background:#15171c;color:#e6e8ec;font-family:-apple-system,'Hiragino Sans',sans-serif">
<h1 style="font-size:18px">Noetelier アプリアイコン（tb-narrow-left を加工）</h1>
<p style="color:#9aa0aa;font-size:13px">透明背景に加工済み。下は各サイズの見え方。</p>
<div style="display:flex;gap:28px;align-items:flex-end;margin-top:20px;text-align:center;color:#9aa0aa;font-size:12px;
  background:repeating-conic-gradient(#2a2d34 0 25%,#23262c 0 50%) 50%/24px 24px;padding:24px;border-radius:12px">
{imgs}
</div></body>"""
with open(os.path.join(OUT_DIR, "preview.html"), "w") as f:
    f.write(html)
print("preview:", os.path.join(OUT_DIR, "preview.html"))
