import next from "eslint-config-next";

/**
 * Flat config for Next.js 16.
 * The new React Compiler lint rules (`react-hooks/refs`,
 * `react-hooks/set-state-in-effect`) are extremely strict about patterns that
 * are deliberate and safe here — e.g. keeping the history stack in a ref and
 * resetting modal state when a dialog opens. Everything else stays on.
 */
const config = [
  ...next,
  {
    ignores: [".next/**", "node_modules/**", "public/**", "e2e/**", "next-env.d.ts"],
  },
  {
    rules: {
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/exhaustive-deps": "warn",
      "@next/next/no-img-element": "off",
    },
  },
];

export default config;
