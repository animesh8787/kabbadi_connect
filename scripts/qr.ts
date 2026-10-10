// Write QR codes (PNG for the README, SVG for print) for the live site and the judge demo page.
// Usage: npm run qr -- [base-url]   (default: the live CloudFront site)
import { mkdirSync, writeFileSync } from "node:fs";
import QRCode from "qrcode";
import { outputs } from "./lib";

const base = process.argv[2] ?? outputs().SiteUrl!;
mkdirSync("docs", { recursive: true });
for (const [name, path] of [["site", "/"], ["judges", "/judges"]] as const) {
  const url = base.replace(/\/$/, "") + path;
  await QRCode.toFile(`docs/qr-${name}.png`, url, { width: 512, margin: 2, errorCorrectionLevel: "M" });
  writeFileSync(`docs/qr-${name}.svg`, await QRCode.toString(url, { type: "svg", margin: 2, errorCorrectionLevel: "M" }));
  console.log(`docs/qr-${name}.png/.svg -> ${url}`);
}
