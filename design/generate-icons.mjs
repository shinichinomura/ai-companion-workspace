// Noetelier アプリアイコン候補を Nano Banana 2 (Gemini 3 Pro Image) で生成するスクリプト。
// C-3 案（デスク俯瞰の3ペイン＋光るターミナル行）のバリエーションをまとめて生成し、
// PNG として保存したうえで一覧用の index.html を書き出す。
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "icon-candidates");
const MODEL = "gemini-3-pro-image-preview"; // Nano Banana 2 (Nano Banana Pro)

// .env から GEMINI_API_KEY を読む（簡易パーサ）
function loadApiKey() {
  const env = readFileSync(resolve(__dirname, "..", ".env"), "utf8");
  const line = env.split("\n").find((l) => l.startsWith("GEMINI_API_KEY="));
  if (!line) throw new Error("GEMINI_API_KEY が .env に見つかりません");
  return line.slice("GEMINI_API_KEY=".length).trim();
}

// 全候補に共通で効かせる土台の指示
const BASE = `Design a macOS application icon. The icon must fill a rounded-square (squircle) shape exactly like a native macOS Big Sur app icon, edge to edge, on a transparent or neutral background outside the squircle. Cool, refined developer-tool aesthetic. Flat design with only very subtle depth/shadow. Crisp, geometric, legible even at small sizes. No text, no words, no letters anywhere. No realistic photo, no skeuomorphic clutter.`;

// C-3 のコア概念
const CONCEPT = `The icon depicts a workbench / desk seen from above (top-down): the surface is divided into three panes like the three panels of a code workspace — a thin vertical file-tree strip on the left, a central code editor area with a few simplified horizontal text lines, and a right preview pane with a heading block and body lines. Across the lower part runs a single integrated terminal row showing a glowing command prompt mark (a chevron > and a cursor _), which is the one and only luminous accent of the whole icon.`;

const candidates = [
  {
    id: "c3-cyan",
    title: "C-3 / シアン発光ターミナル",
    prompt: `${BASE} ${CONCEPT} Base palette: dark slate / charcoal (#1E2127 to #23272E). The whole icon is monochrome dark EXCEPT the terminal prompt row, which glows in a cyan/teal accent (#36D2C5-ish) like a terminal cursor. Calm, premium, minimal.`,
  },
  {
    id: "c3-amber",
    title: "C-3 / アンバー(真鍮)発光ターミナル",
    prompt: `${BASE} ${CONCEPT} Base palette: dark slate / charcoal (#1E2127 to #23272E). The whole icon is monochrome dark EXCEPT the terminal prompt row, which glows in a warm amber / brass accent (#E0A24E-ish) like a workshop work-lamp — a single drop of warmth on a cool surface. Calm, premium, minimal.`,
  },
  {
    id: "c3-flat-cyan",
    title: "C-3 / 真俯瞰フラット・シアン",
    prompt: `${BASE} ${CONCEPT} Pure flat top-down view with NO perspective and NO 3D tilt — the three panes are clean rectangles laid out flat. Maximize legibility at tiny sizes. Base dark slate; the terminal prompt row glows cyan/teal. Strong geometric clarity.`,
  },
  {
    id: "c3-desk-amber",
    title: "C-3 / 製図台奥行き・アンバー",
    prompt: `${BASE} ${CONCEPT} Give a slight drafting-table perspective: the desk surface recedes gently toward the top so it reads as a real workbench, with soft depth shadow under the panes. Base dark slate; the terminal prompt row glows warm amber/brass. Refined, tactile but still flat and clean.`,
  },
  {
    id: "c3-duotone-teal",
    title: "C-3 / ティール基調デュオトーン",
    prompt: `${BASE} ${CONCEPT} Duotone treatment: deep desaturated teal-charcoal background with lighter steel-blue panes, and a brighter teal glow on the terminal prompt row as the focal accent. Modern, cohesive, developer-tool feel. Flat with subtle elevation.`,
  },
  {
    id: "c3-minimal-amber",
    title: "C-3 / 超ミニマル・アンバー一点",
    prompt: `${BASE} ${CONCEPT} Extremely reduced and minimal: simplify the three panes to the fewest possible shapes (left strip, a couple of code lines, a preview block). Almost entirely dark monochrome with one single small glowing amber prompt chevron as the hero element. Lots of negative space, very iconic.`,
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
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`HTTP ${res.status}: ${t.slice(0, 500)}`);
  }
  const json = await res.json();
  const parts = json?.candidates?.[0]?.content?.parts ?? [];
  const img = parts.find((p) => p.inlineData?.data);
  if (!img) {
    throw new Error(`画像が返りませんでした: ${JSON.stringify(json).slice(0, 500)}`);
  }
  const buf = Buffer.from(img.inlineData.data, "base64");
  const file = `${c.id}.png`;
  writeFileSync(resolve(OUT_DIR, file), buf);
  return file;
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

  // 一覧 HTML を書き出す
  const cards = results
    .map((r) => {
      const img = r.ok
        ? `<img src="${r.file}" alt="${r.title}">`
        : `<div class="err">生成失敗<br><small>${(r.error || "").replace(/</g, "&lt;")}</small></div>`;
      return `      <figure>
        <div class="frame">${img}</div>
        <figcaption><b>${r.title}</b><br><code>${r.id}</code></figcaption>
      </figure>`;
    })
    .join("\n");

  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Noetelier アイコン候補 (C-3)</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 32px; background: #15171c; color: #e6e8ec;
    font-family: -apple-system, "Hiragino Sans", sans-serif; }
  h1 { font-size: 20px; font-weight: 600; }
  p.note { color: #9aa0aa; font-size: 13px; margin-top: 4px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 28px; margin-top: 28px; }
  figure { margin: 0; text-align: center; }
  .frame { background:
      repeating-conic-gradient(#2a2d34 0% 25%, #23262c 0% 50%) 50% / 24px 24px;
    border-radius: 16px; padding: 20px; display: flex; justify-content: center; }
  .frame img { width: 100%; max-width: 200px; height: auto; border-radius: 22%;
    box-shadow: 0 8px 24px rgba(0,0,0,.5); }
  .err { width: 200px; height: 200px; display: flex; flex-direction: column;
    align-items: center; justify-content: center; color: #ff8a8a; font-size: 13px;
    border: 1px dashed #ff8a8a55; border-radius: 22%; }
  figcaption { margin-top: 12px; font-size: 13px; line-height: 1.5; }
  code { color: #36d2c5; font-size: 12px; }
</style>
</head>
<body>
  <h1>Noetelier アプリアイコン候補 — C-3（デスク俯瞰 × 光るターミナル行）</h1>
  <p class="note">Nano Banana 2 (Gemini 3 Pro Image) で生成。macOS の squircle に内接する想定でプレビュー表示しています。</p>
  <div class="grid">
${cards}
  </div>
</body>
</html>`;
  writeFileSync(resolve(OUT_DIR, "index.html"), html);
  console.log(`\n一覧: ${resolve(OUT_DIR, "index.html")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
