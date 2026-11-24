// Renders the install and Apple icons from the owner's icon artwork.
//
//   node scripts/render-icons.mjs
//
// Each icon is design/logos/icepik_icon/icepik_icon-faithful-white-backing.svg,
// centred on the app's surface colour (#1a1e22), which fills the whole square.
// Writes public/icons/icon-{192,512}.png ("any", logo about 84% of the width),
// public/icons/maskable-{192,512}.png (logo about 62%) and app/apple-icon.png
// (180 px, about 84%).
//
// After drawing, each file is checked from its own pixels:
//   - maskable: every pixel that differs from the background lies inside the
//     central circle of radius 40% of the width (the maskable safe zone);
//   - any / Apple: no logo pixel touches the outer 1 px edge.
// A file that fails is redrawn with the logo 1% narrower until it passes. The
// final percentage is printed. The artwork itself is never changed.
//
// Draws with the preinstalled Playwright Chromium, at deviceScaleFactor 1 so
// the PNG is exactly the stated size. Loads no network resources.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(root, "design/logos/icepik_icon/icepik_icon-faithful-white-backing.svg");
const BACKGROUND = "#1a1e22";
const BG = [0x1a, 0x1e, 0x22];
// A pixel counts as logo when any channel differs from the background by
// more than this; it absorbs the anti-aliased fringe of a flat colour.
const TOLERANCE = 8;
const SAFE_RADIUS = 0.4;

const ICONS = [
  { file: "public/icons/icon-192.png", size: 192, percent: 84, kind: "any" },
  { file: "public/icons/icon-512.png", size: 512, percent: 84, kind: "any" },
  { file: "public/icons/maskable-192.png", size: 192, percent: 62, kind: "maskable" },
  { file: "public/icons/maskable-512.png", size: 512, percent: 62, kind: "maskable" },
  { file: "app/apple-icon.png", size: 180, percent: 84, kind: "any" },
];

const svg = readFileSync(SOURCE);
const logoUrl = `data:image/svg+xml;base64,${svg.toString("base64")}`;

const browser = await chromium.launch();
const context = await browser.newContext({ deviceScaleFactor: 1 });
const page = await context.newPage();

async function draw(size, percent) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<!doctype html><meta charset="utf-8"><style>
      html,body{margin:0;height:100%;background:${BACKGROUND}}
      body{display:flex;align-items:center;justify-content:center}
      img{display:block;width:${(size * percent) / 100}px;height:auto}
    </style><img src="${logoUrl}" alt="">`,
  );
  await page.evaluate(() => document.querySelector("img").decode());
  return page.screenshot({ type: "png", clip: { x: 0, y: 0, width: size, height: size } });
}

// Reads the PNG back through a canvas and reports the size, the logo's
// farthest distance from the centre (as a share of the width), and whether any
// logo pixel sits on the outer 1 px edge.
async function measure(png) {
  return page.evaluate(
    async ({ b64, bg, tolerance }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, w, h);
      let far = 0;
      let edge = false;
      let logoPixels = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const diff = Math.max(
            Math.abs(data[i] - bg[0]),
            Math.abs(data[i + 1] - bg[1]),
            Math.abs(data[i + 2] - bg[2]),
          );
          if (diff <= tolerance) continue;
          logoPixels++;
          // Far corner of the pixel from the centre, so a pixel that
          // straddles the circle counts as outside it.
          const dx = Math.max(Math.abs(x - w / 2), Math.abs(x + 1 - w / 2));
          const dy = Math.max(Math.abs(y - h / 2), Math.abs(y + 1 - h / 2));
          far = Math.max(far, Math.hypot(dx, dy) / w);
          if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
        }
      }
      return { w, h, far, edge, logoPixels };
    },
    { b64: png.toString("base64"), bg: BG, tolerance: TOLERANCE },
  );
}

let failed = false;
for (const icon of ICONS) {
  let percent = icon.percent;
  let png;
  let m;
  for (;;) {
    png = await draw(icon.size, percent);
    m = await measure(png);
    const ok =
      m.w === icon.size &&
      m.h === icon.size &&
      m.logoPixels > 0 &&
      (icon.kind === "maskable" ? m.far <= SAFE_RADIUS : !m.edge);
    if (ok) break;
    if (percent <= 10) {
      failed = true;
      break;
    }
    percent -= 1;
  }
  mkdirSync(dirname(join(root, icon.file)), { recursive: true });
  writeFileSync(join(root, icon.file), png);
  const detail =
    icon.kind === "maskable"
      ? `farthest logo pixel ${(m.far * 100).toFixed(1)}% of width from centre (limit ${SAFE_RADIUS * 100}%)`
      : `logo touches outer edge: ${m.edge ? "yes" : "no"}`;
  console.log(
    `${icon.file}: ${m.w}x${m.h}, logo ${percent}% of width (asked ${icon.percent}%), ${detail}: ${failed ? "FAIL" : "pass"}`,
  );
}

await browser.close();
if (failed) process.exit(1);
