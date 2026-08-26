import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  // studio-ui is a vendored monorepo with its own lint configuration and
  // upstream ratchet. The control-plane lint must not reinterpret every
  // upstream package with the broker's ESLint rules.
  globalIgnores([".next/**", "dist/**", "coverage/**", "next-env.d.ts", "studio-ui/**"]),
]);
