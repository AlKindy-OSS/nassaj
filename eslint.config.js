import js from "@eslint/js";
import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import { createNodeResolver, importX } from "eslint-plugin-import-x";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";
import boundaries from "eslint-plugin-boundaries";
import tailwindcss from "eslint-plugin-tailwindcss";
import styleLock from "./eslint-style-lock-plugin.js";
import unusedImports from "eslint-plugin-unused-imports";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "public/**"],
  },
  {
    files: ["src/**/*.{ts,tsx,js,jsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    plugins: {
      react,
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
      "import-x": importX,
      tailwindcss,
      "unused-imports": unusedImports,
      styleLock,
    },
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: "detect" } },
    rules: {
      "unused-imports/no-unused-imports": "warn",
      "unused-imports/no-unused-vars": [
        "warn",
        { vars: "all", varsIgnorePattern: "^_", args: "after-used", argsIgnorePattern: "^_" },
      ],
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "react/jsx-key": "warn",
      "react/jsx-no-duplicate-props": "error",
      "react/jsx-no-undef": "error",
      "react/no-children-prop": "warn",
      "react/no-danger-with-children": "error",
      "react/no-direct-mutation-state": "error",
      "react/no-unknown-property": "warn",
      "react/react-in-jsx-scope": "off",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "import-x/no-duplicates": "warn",
      "import-x/order": ["warn", { groups: ["builtin","external","internal","parent","sibling","index"], "newlines-between": "always" }],
      "tailwindcss/classnames-order": "warn",
      "tailwindcss/no-contradicting-classname": "warn",
      "tailwindcss/no-unnecessary-arbitrary-value": "warn",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "no-case-declarations": "off",
      "no-control-regex": "off",
      "no-useless-escape": "off",
    },
  },
  // The application entry must resolve every runtime identifier before packaging.
  {
    files: ["server/index.js"],
    rules: { "no-undef": "error" },
  },
  // STYLE_LOCK §1 (B-353): hard guard on wiki
  {
    files: ["src/components/wiki/**/*.{ts,tsx,js,jsx}"],
    plugins: { styleLock },
    rules: { "styleLock/no-sub-13px": "error" },
  },
  {
    files: ["server/**/*.{js,ts}"],
    ignores: ["server/**/*.d.ts"],
    plugins: {
      boundaries,
      "import-x": importX,
      "unused-imports": unusedImports,
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
      globals: { ...globals.node },
    },
    settings: {
      "boundaries/include": ["server/**/*.{js,ts}"],
      "import/resolver": {
        typescript: { project: ["server/tsconfig.json"], alwaysTryTypes: true },
        node: { extensions: [".mjs",".cjs",".js",".json",".node",".ts",".tsx"] },
      },
      "import-x/resolver-next": [
        createTypeScriptImportResolver({ project: ["server/tsconfig.json"], alwaysTryTypes: true }),
        createNodeResolver({ extensions: [".mjs",".cjs",".js",".json",".node",".ts",".tsx"] }),
      ],
      "boundaries/elements": [
        { type: "backend-shared-type-contract", pattern: ["server/shared/types.{js,ts}","server/shared/interfaces.{js,ts}"], mode: "file" },
        { type: "backend-shared-utils", pattern: ["server/shared/utils.{js,ts}","server/shared/frontmatter.ts","server/shared/r3-evidence-lexical.ts","server/shared/claude-cli-path.ts","server/shared/cli-executable-path.ts","server/shared/codex-executable.js","server/services/image-signature.js","server/services/svg-sanitizer.js"], mode: "file" },
        { type: "backend-isolation-service", pattern: "server/services/isolation/*", mode: "file" },
        { type: "backend-service-shared", pattern: ["server/services/provider-sharing.js","server/services/agent-sse-ticket.service.js","server/services/system-resource-sampler.service.ts","server/services/update-maintenance-gate.js","server/services/update-writer-lease.js"], mode: "file" },
        { type: "backend-legacy-runtime", pattern: ["server/projects.js","server/sessionManager.js","server/utils/runtime-paths.js"], mode: "file" },
        { type: "backend-module", pattern: "server/modules/*", mode: "folder", capture: ["moduleName"] },
      ],
    },
    rules: {
      "unused-imports/no-unused-imports": "warn",
      "unused-imports/no-unused-vars": "off",
      "import-x/no-duplicates": "warn",
      "import-x/order": ["warn", { groups: ["builtin","external","internal","parent","sibling","index"], "newlines-between": "always" }],
      "import-x/no-unresolved": "error",
      "import-x/no-useless-path-segments": "warn",
      "import-x/no-absolute-path": "error",
      eqeqeq: ["warn", "always", { null: "ignore" }],
      "boundaries/dependencies": ["error", {
        default: "allow",
        checkInternals: false,
        rules: [
          { from: { type: "backend-module" }, to: { type: "backend-shared-type-contract" }, disallow: { dependency: { kind: ["value","typeof"] } }, message: "Backend modules may only use `import type` when importing from server/shared/types.ts or server/shared/interfaces.ts." },
          { to: { type: "backend-module" }, disallow: { to: { internalPath: "**" } }, message: "Cross-module imports must go through that module's barrel file (server/modules/<module>/index.ts or index.js)." },
          { to: { type: "backend-module" }, allow: { to: { internalPath: ["index","index.{js,mjs,cjs,ts,tsx}"] } } },
        ],
      }],
      "boundaries/no-unknown": "error",
    },
  }
);
