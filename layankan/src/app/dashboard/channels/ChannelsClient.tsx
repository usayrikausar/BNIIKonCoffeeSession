"use client";
import { useEffect, useState, useTransition } from "react";
import QRCode from "qrcode";
import { dict, type Lang } from "@/lib/i18n";
import { setLive } from "./actions";

export default function ChannelsClient(props: { lang: Lang; isOwner: boolean; live: boolean; chatUrl: string; embed: string; slug: string }) {
  const t = dict(props.lang);
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    QRCode.toDataURL(props.chatUrl, { width: 1024, margin: 2, color: { dark: "#134e4a", light: "#ffffff" } }).then(setQr);
  }, [props.chatUrl]);

  function copy(key: string, text: string) {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  }

  if (!props.live) {
    return (
      <section className="card space-y-3 text-center">
        <p className="text-sm text-zinc-600">{t("channels.golive.help")}</p>
        {props.isOwner ? (
          <button disabled={pending} onClick={() => start(async () => void (await setLive(true)))} className="btn-primary px-8 py-3 text-base">
            🚀 {t("channels.golive")}
          </button>
        ) : (
          <p className="text-xs text-zinc-400">{t("settings.owner_only")}</p>
        )}
      </section>
    );
  }

  return (
    <>
      <section className="card flex items-center justify-between gap-3 bg-green-50">
        <span className="font-semibold text-green-800">✅ {t("channels.live")}</span>
        {props.isOwner && (
          <button disabled={pending} onClick={() => start(async () => void (await setLive(false)))} className="btn-secondary text-xs">
            {t("channels.pause")}
          </button>
        )}
      </section>
      <section className="card space-y-2">
        <h2 className="text-lg font-semibold">{t("channels.link")}</h2>
        <div className="flex gap-2">
          <input readOnly className="input" value={props.chatUrl} />
          <button className="btn-secondary" onClick={() => copy("link", props.chatUrl)}>{copied === "link" ? t("common.copied") : t("common.copy")}</button>
          <a className="btn-secondary" href={props.chatUrl} target="_blank" rel="noreferrer">↗</a>
        </div>
      </section>
      <section className="card space-y-2">
        <h2 className="text-lg font-semibold">{t("channels.qr")}</h2>
        {qr && (
          <div className="flex flex-wrap items-center gap-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr} alt="QR" className="h-40 w-40 rounded-lg border" />
            <a href={qr} download={`layankan-${props.slug}-qr.png`} className="btn-primary">⬇ {t("common.download")} PNG</a>
          </div>
        )}
      </section>
      <section className="card space-y-2">
        <h2 className="text-lg font-semibold">{t("channels.embed")}</h2>
        <p className="text-sm text-zinc-500">{t("channels.embed.help")}</p>
        <pre className="overflow-x-auto rounded-lg bg-zinc-900 p-3 text-xs text-green-300">{props.embed}</pre>
        <button className="btn-secondary" onClick={() => copy("embed", props.embed)}>{copied === "embed" ? t("common.copied") : t("common.copy")}</button>
      </section>
    </>
  );
}
