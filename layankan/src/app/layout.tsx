import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Layankan — Ejen AI untuk pertanyaan pelanggan", template: "%s · Layankan" },
  description:
    "Ejen AI yang menjawab pertanyaan pelanggan 24/7 dalam BM & English, menapis pertanyaan kosong dan menyerahkan pembeli serius kepada anda.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0f766e" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ms">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
