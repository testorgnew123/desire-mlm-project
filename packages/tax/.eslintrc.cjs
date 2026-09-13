// The purity of this package is what makes fixture-driven testing and CA
// review possible (docs/11-COMPLIANCE-INDIA.md, packages/commission's own
// .eslintrc.cjs -- this file mirrors it exactly). Enforced mechanically here
// rather than left to code review discipline.
module.exports = {
  extends: ["../../.eslintrc.cjs"],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        paths: [
          { name: "@prisma/client", message: "packages/tax must stay pure -- no DB access." },
          { name: "@desire/db", message: "packages/tax must stay pure -- no DB access." },
          { name: "fs", message: "packages/tax must stay pure -- no I/O." },
          { name: "node:fs", message: "packages/tax must stay pure -- no I/O." },
          { name: "net", message: "packages/tax must stay pure -- no I/O." },
          { name: "http", message: "packages/tax must stay pure -- no I/O." },
          { name: "child_process", message: "packages/tax must stay pure -- no I/O." },
        ],
      },
    ],
  },
};
