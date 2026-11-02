import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // pdfjs-dist ships ESM that Next must transpile/bundle client-side.
  transpilePackages: ["pdfjs-dist"],
  // Everything in this app is client-side. No server routes, no OG image.
  serverExternalPackages: [],
  experimental: {},
  // `next dev` refuses HMR websockets from hosts it doesn't know. Allow the
  // usual local aliases plus any preview/proxy domain (e.g. *.e2b.app).
  allowedDevOrigins: ["localhost", "127.0.0.1", "*.e2b.app", "*.vercel.app", "*.ngrok-free.app"],
  async headers() {
    return [
      {
        // The tesseract worker + wasm are served from /public — long cache is fine.
        source: "/vendor/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
      {
        source: "/pdf.worker.min.mjs",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ];
  },
};

export default nextConfig;
