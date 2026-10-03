import eslint from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores(["dist", "node_modules", "coverage"]),
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["*.js", "*.mjs", "*.config.ts"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Output goes through the Logger (RAG-009); only the CLI may print directly.
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    files: ["src/cli/**"],
    rules: { "no-console": "off" },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
