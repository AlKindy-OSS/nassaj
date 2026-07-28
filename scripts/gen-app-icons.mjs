/**
 * gen-app-icons.mjs
 * توليد أيقونات التطبيق المربّعة من public/favicon.svg (الزجزاج الذهبي).
 * المصدر الوحيد: public/favicon.svg
 * الاستخدام: node scripts/gen-app-icons.mjs
 */

import sharp from 'sharp';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const svgSource = readFileSync(resolve(root, 'public/favicon.svg'));

// المقاسات المطلوبة بـ public/
const logoSizes = [32, 64, 128, 256, 512];

// المقاسات المطلوبة بـ public/icons/
const iconSizes = [72, 96, 128, 144, 152, 192, 384, 512];

async function generatePng(size, outputPath) {
  await sharp(svgSource)
    .resize(size, size, {
      fit: 'contain',
      background: { r: 255, g: 255, b: 255, alpha: 1 }, // #ffffff
    })
    .png()
    .toFile(outputPath);
  console.log(`  generated: ${outputPath.replace(root + '/', '')}`);
}

async function main() {
  // 1. public/logo-{size}.png
  console.log('\n[logo PNGs]');
  for (const size of logoSizes) {
    const outPath = resolve(root, `public/logo-${size}.png`);
    await generatePng(size, outPath);
  }

  // 2. public/icons/icon-{WxH}.png
  console.log('\n[icon PNGs]');
  mkdirSync(resolve(root, 'public/icons'), { recursive: true });
  for (const size of iconSizes) {
    const outPath = resolve(root, `public/icons/icon-${size}x${size}.png`);
    await generatePng(size, outPath);
  }

  console.log('\nDone. All icons generated from favicon.svg (golden zigzag).');
}

main().catch((err) => {
  console.error('Error generating icons:', err);
  process.exit(1);
});
