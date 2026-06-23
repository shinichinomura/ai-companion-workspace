// C-3 をベースにさらにミニマル化したアイコン候補を生成する。
// 狙い: Dock の実サイズ（32〜16px）でもごちゃつかないこと。
// → 要素を大胆に削り、大きな面と最小限の線だけで「3ペイン＋光るターミナル」を成立させる。
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

// ミニマル化の最重要指示
const MINIMAL = `CRITICAL CONSTRAINT: the icon must stay clean and uncluttered at very small sizes (32px and 16px). Use only a few large, simple shapes with generous negative space. Absolutely NO fine detail: no busy file-tree, no many thin text lines, no tiny elements, no small repeated marks. Bold, iconic, instantly readable silhouette.`;

const candidates = [
  {
    id: "c3m-tri-cyan",
    title: "ミニマル / 3面分割＋シアン>",
    prompt: `${BASE} ${MINIMAL} Composition: a dark slate workbench divided into just three clean panes by two thin seams — left a narrow strip, a wider middle, and a right strip. No content inside the panes except, in the lower area, ONE single glowing cyan terminal prompt: a chevron > followed by a short cursor underscore. The prompt is the only bright element. Dark charcoal (#1E2127) base, single cyan accent. Maximum simplicity.`,
  },
  {
    id: "c3m-tri-amber",
    title: "ミニマル / 3面分割＋アンバー>",
    prompt: `${BASE} ${MINIMAL} Composition: a dark slate workbench divided into just three clean panes by two thin seams. No content inside the panes except ONE single glowing warm amber/brass terminal prompt (chevron > and a short cursor underscore) in the lower-left area, like a single work-lamp on a dark desk. Dark charcoal base, single amber accent. Maximum simplicity.`,
  },
  {
    id: "c3m-hero-cyan",
    title: "ミニマル / ターミナル主役・シアン",
    prompt: `${BASE} ${MINIMAL} Composition: the hero is a large, bold glowing cyan terminal prompt — a chevron > and a cursor underscore — centered slightly low. Behind it, very faint and subtle, the dark surface is hinted into three vertical panes by two barely-visible seams. Mostly dark negative space. One accent color only (cyan). Extremely iconic and reduced.`,
  },
  {
    id: "c3m-hero-amber",
    title: "ミニマル / ターミナル主役・アンバー",
    prompt: `${BASE} ${MINIMAL} Composition: the hero is a large, bold glowing warm amber prompt — a chevron > and a cursor underscore — centered slightly low. Behind it, very faint, the dark surface is hinted into three vertical panes by two barely-visible seams. Mostly dark negative space. One accent color only (amber/brass). Extremely iconic and reduced.`,
  },
  {
    id: "c3m-twoblock-cyan",
    title: "ミニマル / 上下2帯（面＋ターミナル）",
    prompt: `${BASE} ${MINIMAL} Composition: split the squircle into two horizontal zones. The upper zone is a single dark workspace surface subtly divided into three panes by two thin seams (no inner content). The lower zone is a distinct terminal bar holding ONE glowing cyan prompt (chevron > and cursor underscore). Just two big zones, one accent. Very clean.`,
  },
  {
    id: "c3m-corner-amber",
    title: "ミニマル / 3面＋右下に小さく>",
    prompt: `${BASE} ${MINIMAL} Composition: a dark slate surface cleanly divided into three vertical panes by two thin seams, completely empty inside. A single small glowing amber prompt mark (just a chevron > with a tiny cursor) sits quietly in the lower-right corner as the sole accent. Restrained, elegant, lots of empty dark space. One accent color only.`,
  },
];

async function generateOne(apiKey, c) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: c.prompt }] }],
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig: { aspectRatio: "1:1" },
    },
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

  // 実サイズプレビュー付きの一覧 HTML
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
<title>Noetelier アイコン候補 — ミニマル版</title>
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
  .sizes img { border-radius:22%; image-rendering:auto; display:block; margin:0 auto 2px; }
  figcaption { margin-top:12px; font-size:13px; line-height:1.5; }
  code { color:#36d2c5; font-size:12px; }
  .err { width:200px; height:200px; flex-direction:column; align-items:center;
    color:#ff8a8a; border:1px dashed #ff8a8a55; }
</style></head>
<body>
  <h1>Noetelier アイコン候補 — ミニマル版（C-3 ベース）</h1>
  <p class="note">各カード下の 64 / 32 / 16 は Dock 実サイズでの見え方の目安。小さくしてもごちゃつかないかで判断してください。元の6案は <a href="index.html" style="color:#36d2c5">index.html</a>。</p>
  <div class="grid">
${cards}
  </div>
</body></html>`;
  writeFileSync(resolve(OUT_DIR, "index-min.html"), html);
  console.log(`\n一覧: ${resolve(OUT_DIR, "index-min.html")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
