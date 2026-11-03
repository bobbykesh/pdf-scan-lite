import type { NextConfig } from "next";
import { execFileSync } from "node:child_process";

/*
 * Stamp the service worker's cache version for this build.
 *
 * Doing it here rather than from an npm lifecycle script means it runs no
 * matter how the build is started (`next build`, `npm run build`, CI). The
 * cache name has to change per deploy: a fixed name gives `activate` nothing
 * to evict, so every build's chunks accumulate in one cache and a returning
 * visitor can be served assets from a build that no longer exists.
 */
try {
  execFileSync(process.execPath, ["scripts/stamp-sw.mjs"], { stdio: "inherit" });
} catch {
  console.warn("[stamp-sw] skipped");
}

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
