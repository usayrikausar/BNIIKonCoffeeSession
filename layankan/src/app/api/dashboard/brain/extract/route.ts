import { NextResponse, type NextRequest } from "next/server";
import { apiTenant } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractBrainDraft, type ExtractInput } from "@/lib/brain/extract";
import { htmlToText, safeFetchText } from "@/lib/ssrf";
import { allow } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_CHARS = 150_000;

/** Extract a Brain draft from a PDF / URL / pasted text. Returns the draft; never writes to the Brain. */
export async function POST(req: NextRequest) {
  const ctx = await apiTenant();
  if ("error" in ctx) return ctx.error;
  const admin = createAdminClient();
  if (!(await allow(admin, `extract:${ctx.tenantId}`, 3600, 30))) {
    return NextResponse.json({ error: "Terlalu banyak cubaan. Cuba lagi sejam lagi. / Too many attempts, try again in an hour." }, { status: 429 });
  }

  const form = await req.formData();
  const kind = String(form.get("kind") ?? "");
  let input: ExtractInput;
  const source: Record<string, unknown> = { tenant_id: ctx.tenantId, kind, created_by: ctx.user.id };

  try {
    if (kind === "pdf") {
      const file = form.get("file");
      if (!(file instanceof File) || file.type !== "application/pdf") return bad("Sila pilih fail PDF / Please choose a PDF file");
      if (file.size > MAX_PDF_BYTES) return bad("PDF melebihi 10MB / PDF is larger than 10MB");
      const buf = Buffer.from(await file.arrayBuffer());
      if (buf.subarray(0, 5).toString() !== "%PDF-") return bad("Fail bukan PDF yang sah / Not a valid PDF");
      const path = `${ctx.tenantId}/${crypto.randomUUID()}.pdf`;
      const up = await admin.storage.from("brain-sources").upload(path, buf, { contentType: "application/pdf" });
      if (!up.error) source.storage_path = path;
      input = { kind: "pdf", base64: buf.toString("base64") };
    } else if (kind === "url") {
      const url = String(form.get("url") ?? "").trim();
      source.source_url = url;
      const html = await safeFetchText(url);
      const text = htmlToText(html);
      if (text.length < 40) return bad("Tiada teks dijumpai di URL itu / No readable text at that URL");
      if (text.length > MAX_TEXT_CHARS) return bad("Halaman terlalu panjang — tampal bahagian penting sahaja / Page too long — paste the key parts instead");
      source.raw_text = text;
      input = { kind: "text", text };
    } else if (kind === "text") {
      const text = String(form.get("text") ?? "").trim();
      if (text.length < 20) return bad("Teks terlalu pendek / Text too short");
      if (text.length > MAX_TEXT_CHARS) return bad("Teks terlalu panjang (maks 150,000 aksara) / Text too long (max 150,000 characters)");
      source.raw_text = text;
      input = { kind: "text", text };
    } else {
      return bad("kind?");
    }
  } catch (e) {
    return bad(e instanceof Error ? e.message : "Fetch failed");
  }

  const { data: row } = await ctx.supabase.from("brain_sources").insert(source).select("id").single();
  try {
    const draft = await extractBrainDraft(input);
    if (row) await ctx.supabase.from("brain_sources").update({ extracted: draft, status: "extracted" }).eq("id", row.id);
    return NextResponse.json({ sourceId: row?.id ?? null, draft });
  } catch (e) {
    console.error(`[extract] tenant=${ctx.tenantId} failed: ${e instanceof Error ? e.name : "error"}`);
    if (row) await ctx.supabase.from("brain_sources").update({ status: "failed", error: "extraction failed" }).eq("id", row.id);
    return NextResponse.json({ error: "Gagal mengekstrak. Cuba teks yang lebih ringkas. / Extraction failed." }, { status: 502 });
  }
}

function bad(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}
