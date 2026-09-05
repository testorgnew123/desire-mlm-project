// The purity of this package is what makes golden-file testing and historical
// reproduction possible (docs/04-COMMISSION-SPEC.md, ADR-0003). Enforced
// mechanically here rather than left to code review discipline.
module.exports = {
  extends: ["../../.eslintrc.cjs"],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        paths: [
          { name: "@prisma/client", message: "packages/commission must stay pure -- no DB access." },
          { name: "@desire/db", message: "packages/commission must stay pure -- no DB access." },
          { name: "fs", message: "packages/commission must stay pure -- no I/O." },
          { name: "node:fs", message: "packages/commission must stay pure -- no I/O." },
          { name: "net", message: "packages/commission must stay pure -- no I/O." },
          { name: "http", message: "packages/commission must stay pure -- no I/O." },
          { name: "child_process", message: "packages/commission must stay pure -- no I/O." },
        ],
      },
    ],
  },
};
