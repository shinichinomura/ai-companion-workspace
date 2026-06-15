// c3m-twoblock-cyan をベースにした詰め版。
// 変更点:
//  - 上部を「3分割」→「2分割（左を狭く）」に。explorer(左・狭) と editor/preview(右・広) を示す。
//  - 小サイズでも分割が見えるよう、シームの強さ／2面のトーン差を振ったバリエーションを作る。
//  - 下部はターミナル帯＋シアンの > プロンプト（採用済みの良さを維持）。
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "icon-candidates");
const MODEL = "gemini-3-pro-image-preview";

function loadApiKey() {
  const env = readFileSync(resolve(__dirname, "..", ".env"), "utf8");
  const line = env.split("\n").find((l) => l.startsWith("GEMINI_API_KEY="));
  if (!line) throw new Error("GEMINI_API_KEY が .env に見つかりません");
  return line.slice("GEMINI_API_KEY=".length).trim();
}

const BASE = `Design a macOS application icon that fills a rounded-square (squircle) shape exactly like a native macOS Big Sur app icon, edge to edge. Cool, refined developer-tool aesthetic. Flat design with at most very subtle depth. No text, no words, no letters, no numbers. No realistic photo, no skeuomorphic clutter.`;

const MINIMAL = `CRITICAL: must stay clean and clearly readable at very small sizes (32px and 16px). Only a few large simple shapes, generous negative space, no fine detail, no tiny marks, no busy file tree.`;

// 共通の構図（2分割 + ターミナル帯）
const LAYOUT = `Composition: split the squircle into two horizontal zones. The UPPER zone is a dark workspace surface divided into exactly TWO panes by ONE vertical seam: a NARROW pane on the left (about one quarter width, representing the file explorer) and a WIDE pane on the right (the editor/preview). The panes are empty of inner content. The LOWER zone is a distinct terminal bar holding ONE glowing cyan terminal prompt: a chevron > and a short cursor underscore. Only cyan is used as an accent color; everything else is dark slate/charcoal.`;

const candidates = [
  {
    id: "tb-seam-soft",
    title: "2分割 / 細いシーム・トーン差小",
    prompt: `${BASE} ${MINIMAL} ${LAYOUT} The vertical seam is a thin clean line; the two panes have a slight tone difference (left a touch darker). Quiet and minimal.`,
  },
  {
    id: "tb-seam-bold",
    title: "2分割 / 太めシーム・はっきり",
    prompt: `${BASE} ${MINIMAL} ${LAYOUT} Make the vertical seam clearly visible even when tiny: a distinct, slightly thicker divider with a faint highlight on one edge, so the two-pane split reads at 16px. Panes have a clear tone difference (left pane noticeably darker than the right). Bold and legible.`,
  },
  {
    id: "tb-seam-gap",
    title: "2分割 / 黒いギャップで分離",
    prompt: `${BASE} ${MINIMAL} ${LAYOUT} Instead of a thin line, separate the two upper panes by a visible dark GAP (a narrow channel of the base background showing through), so the split is obvious at small sizes. Both panes are slightly raised tiles. Clean and structural.`,
  },
  {
    id: "tb-contrast-strong",
    title: "2分割 / 左ペイン濃淡コントラスト強",
    prompt: `${BASE} ${MINIMAL} ${LAYOUT} Emphasize the two-pane structure mainly through TONE, not a line: the narrow left pane is distinctly darker (a sidebar), the wide right pane is a bit lighter (the editor). The boundary is obvious from the tone step alone. Very readable when small.`,
  },
  {
    id: "tb-bar-teal",
    title: "2分割 / ターミナル帯を落ち着いたティール",
    prompt: `${BASE} ${MINIMAL} ${LAYOUT} Make the lower terminal bar a calmer, deeper teal (less saturated than bright cyan) while the prompt glyph itself glows a brighter cyan. The upper two panes are separated by a clear, slightly bold seam with a tone difference. Cohesive and refined.`,
  },
  {
    id: "tb-narrow-left",
    title: "2分割 / 左をさらに細く・シーム強調",
    prompt: `${BASE} ${MINIMAL} ${LAYOUT} The left explorer pane is even narrower (about one fifth width) and clearly darker, with a crisp bold seam separating it from the wide editor pane, so the asymmetric two-pane split is instantly recognizable even at 16px. The lower cyan terminal bar stays as the accent. Strong, iconic structure.`,
  },
];

async function generateOne(apiKey, c) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: c.prompt }] }],
    generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "1:1" } },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const json = await res.json();
  const parts = json?.candidates?.[0]?.content?.parts ?? [];
  const img = parts.find((p) => p.inlineData?.data);
  if (!img) throw new Error(`画像なし: ${JSON.stringify(json).slice(0, 400)}`);
  writeFileSync(resolve(OUT_DIR, `${c.id}.png`), Buffer.from(img.inlineData.data, "base64"));
  return `${c.id}.png`;
}

async function main() {
  const apiKey = loadApiKey();
  const results = [];
  for (const c of candidates) {
    process.stdout.write(`生成中: ${c.id} ... `);
    try {
      const file = await generateOne(apiKey, c);
      console.log("OK");
      results.push({ ...c, file, ok: true });
    } catch (e) {
      console.log("FAILED");
      console.error(`  ${e.message}`);
      results.push({ ...c, ok: false, error: e.message });
    }
  }

  const cards = results
    .map((r) => {
      if (!r.ok) {
        return `      <figure><div class="frame err">生成失敗<br><small>${(r.error || "").replace(/</g, "&lt;")}</small></div>
        <figcaption><b>${r.title}</b><br><code>${r.id}</code></figcaption></figure>`;
      }
      return `      <figure>
        <div class="frame"><img class="big" src="${r.file}" alt="${r.title}"></div>
        <div class="sizes">
          <span><img src="${r.file}" width="64"><br>64</span>
          <span><img src="${r.file}" width="32"><br>32</span>
          <span><img src="${r.file}" width="16"><br>16</span>
        </div>
        <figcaption><b>${r.title}</b><br><code>${r.id}</code></figcaption>
      </figure>`;
    })
    .join("\n");

  const html = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Atelier アイコン候補 — twoblock 2分割詰め</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; padding:32px; background:#15171c; color:#e6e8ec;
    font-family:-apple-system,"Hiragino Sans",sans-serif; }
  h1 { font-size:20px; font-weight:600; }
  p.note { color:#9aa0aa; font-size:13px; margin-top:4px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr));
    gap:32px; margin-top:28px; }
  figure { margin:0; text-align:center; }
  .frame { background:repeating-conic-gradient(#2a2d34 0 25%,#23262c 0 50%) 50%/24px 24px;
    border-radius:16px; padding:20px; display:flex; justify-content:center; }
  .frame img.big { width:100%; max-width:200px; border-radius:22%;
    box-shadow:0 8px 24px rgba(0,0,0,.5); }
  .sizes { display:flex; gap:20px; justify-content:center; align-items:flex-end;
    margin-top:14px; color:#9aa0aa; font-size:11px; }
  .sizes img { border-radius:22%; display:block; margin:0 auto 2px; }
  figcaption { margin-top:12px; font-size:13px; line-height:1.5; }
  code { color:#36d2c5; font-size:12px; }
  .err { width:200px; height:200px; flex-direction:column; align-items:center;
    color:#ff8a8a; border:1px dashed #ff8a8a55; }
</style></head>
<body>
  <h1>Atelier アイコン候補 — twoblock 2分割（左狭）の詰め</h1>
  <p class="note">上部を 2 分割（左ペインを狭く）に変更。分割線の視認性を上げる方向で、シーム強度とトーン差を振っています。64/32/16 は Dock 実サイズの目安。前段は <a href="index-min.html" style="color:#36d2c5">index-min.html</a>。</p>
  <div class="grid">
${cards}
  </div>
</body></html>`;
  writeFileSync(resolve(OUT_DIR, "index-twoblock.html"), html);
  console.log(`\n一覧: ${resolve(OUT_DIR, "index-twoblock.html")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
