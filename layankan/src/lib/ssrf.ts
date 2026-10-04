import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** True for loopback, private, link-local, CGNAT, multicast and other non-public ranges. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80") || v6.startsWith("ff");
}

/**
 * Fetch a user-supplied URL safely (owners paste their website for brain import):
 * http(s) only, public addresses only (re-checked on every redirect), size + time capped.
 */
export async function safeFetchText(rawUrl: string, maxBytes = 2_000_000): Promise<string> {
  let url = new URL(rawUrl);
  for (let hop = 0; hop < 4; hop++) {
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only http(s) URLs are allowed");
    if (url.username || url.password) throw new Error("URLs with credentials are not allowed");
    const addrs = await lookup(url.hostname, { all: true });
    if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new Error("That address is not allowed");
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { "User-Agent": "LayankanBot/1.0 (+brain import)" } });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location")!, url);
      continue;
    }
    if (!res.ok) throw new Error(`Fetch failed (${res.status})`);
    const reader = res.body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  }
  throw new Error("Too many redirects");
}

/** Very small HTML → text (scripts/styles dropped, tags stripped, whitespace collapsed). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}
