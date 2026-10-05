// Embed widget check on desktop and phone (audit C3). Loads widget.js into a
// deliberately hostile host page and checks that: the host's CSS is untouched,
// the chat opens, and the visitor can ALWAYS close it again (button, Escape,
// and on phones the dimmed strip above the chat).
// Requires the local stack: `bash tests/e2e/stack.sh up`, then `npm run test:widget`.
import { chromium } from "playwright-core";
import http from "node:http";

const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium";
const SHOTS = process.env.WIDGET_SHOTS; // optional folder for screenshots
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} | ${label}${detail ? ` — ${detail}` : ""}`);
};

const hostile = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>
  * { box-sizing: content-box !important; font-family: Comic Sans MS !important; }
  button { display: none !important; background: red !important; }
  iframe { width: 10px !important; height: 10px !important; border: 5px solid red !important; }
  div { position: static !important; }
  body { margin: 40px; } h1 { color: rgb(1, 2, 3); }
</style></head><body><h1 id="host">Host site</h1><p>Lorem ipsum</p>
<script src="${BASE}/widget.js" data-layankan="klinik-a" async></script></body></html>`;
const srv = http.createServer((_q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end(hostile); }).listen(3999);
const browser = await chromium.launch({ executablePath: CHROME });

async function frameVisible(p) {
  const f = p.frames().find((fr) => fr.url().includes("/c/klinik-a"));
  return f ? (await f.frameElement()).isVisible() : false;
}

for (const [name, vp] of [["desktop", { width: 1280, height: 800 }], ["phone", { width: 390, height: 844 }]]) {
  const phone = name === "phone";
  const p = await browser.newPage({ viewport: vp, hasTouch: phone, isMobile: phone });
  await p.goto("http://localhost:3999/");
  await p.waitForTimeout(1500);
  const launcher = { x: vp.width - 50, y: vp.height - 50 };
  // where the close button sits while open: same corner on desktop, top corner on phones
  const closeAt = phone ? { x: vp.width - 32, y: 30 } : launcher;
  const open = async () => { await p.mouse.click(launcher.x, launcher.y); await p.waitForTimeout(2000); };

  check(`${name}: host page CSS untouched`, (await p.$eval("#host", (e) => getComputedStyle(e).color)) === "rgb(1, 2, 3)");
  await open();
  check(`${name}: chat opens`, await frameVisible(p));
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/widget-${name}-open.png` });
  if (phone) {
    const box = await (await p.frames().find((f) => f.url().includes("/c/klinik-a")).frameElement()).boundingBox();
    check(`${name}: chat fills the screen below the close strip`, box && box.width >= vp.width - 1 && box.y >= 50 && box.y <= 70, box ? `${Math.round(box.width)}×${Math.round(box.height)} at y=${Math.round(box.y)}` : "no frame");
  }

  await p.mouse.click(closeAt.x, closeAt.y);
  await p.waitForTimeout(600);
  check(`${name}: close button closes the chat`, !(await frameVisible(p)));

  await open();
  await p.keyboard.press("Escape");
  await p.waitForTimeout(400);
  check(`${name}: Escape closes the chat`, !(await frameVisible(p)));

  if (phone) {
    await open();
    await p.mouse.click(40, 30); // dimmed strip, away from the close button
    await p.waitForTimeout(400);
    check(`${name}: tapping the dimmed strip closes the chat`, !(await frameVisible(p)));
  }
  await p.close();
}
await browser.close();
srv.close();
console.log(failures ? `\n${failures} WIDGET FAILURE(S)` : "\nALL WIDGET CHECKS PASSED");
process.exit(failures ? 1 : 0);
