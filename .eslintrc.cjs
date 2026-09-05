/** Root ESLint config. Package-level configs extend this and add their own
 *  import restrictions — see packages/commission/.eslintrc.cjs for the one
 *  that matters most in this repo. */
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
  plugins: ["@typescript-eslint", "import"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
  ],
  env: {
    node: true,
    es2022: true,
  },
  ignorePatterns: [
    "dist/",
    ".next/",
    "coverage/",
    "node_modules/",
    "*.config.js",
    "*.config.cjs",
  ],
  rules: {
    "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    "@typescript-eslint/consistent-type-imports": "warn",
  },
};
