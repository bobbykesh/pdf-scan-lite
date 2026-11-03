import type { Metadata, Viewport } from "next";
import "./globals.css";
import ServiceWorker from "@/components/ServiceWorker";

export const metadata: Metadata = {
  title: "PDF Scan Lite — scan, edit, sign & OCR PDFs in your browser",
  description:
    "A lightweight, fully client-side PDF scanner and editor. Camera scanning, OCR, annotations, signatures, page management and compression. Your files never leave your device.",
  applicationName: "PDF Scan Lite",
  keywords: ["pdf scanner", "pdf editor", "ocr", "scan document", "sign pdf", "client side"],
  authors: [{ name: "Kesh" }],
  creator: "Kesh",
  publisher: "Kesh",
  other: { "copyright": "Kesh — Designed for Humanity" },
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "PDF Scan Lite", statusBarStyle: "black-translucent" },
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/icon.svg" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#080b11",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-dvh bg-canvas text-ink antialiased">
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
