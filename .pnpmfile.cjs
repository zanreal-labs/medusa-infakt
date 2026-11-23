// typescript-eslint and @medusajs/eslint-plugin load the TypeScript JS API, which TypeScript 7 does not
// ship. Give it the TS 6 compatibility package under the name `typescript`;
// the project itself still type-checks and builds with TypeScript 7.
const TS6 = "npm:@typescript/typescript6@^6.0.2";
const NEEDS_TS_API = new Set([
  "@typescript-eslint/parser",
  "@typescript-eslint/typescript-estree",
  "@typescript-eslint/utils",
  "@typescript-eslint/project-service",
  "@typescript-eslint/tsconfig-utils",
  "@typescript-eslint/type-utils",
  "ts-api-utils",
  "@medusajs/eslint-plugin",
]);

module.exports = {
  hooks: {
    readPackage(pkg) {
      if (NEEDS_TS_API.has(pkg.name)) {
        if (pkg.peerDependencies) delete pkg.peerDependencies.typescript;
        if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta.typescript;
        pkg.dependencies = { ...pkg.dependencies, typescript: TS6 };
      }
      return pkg;
    },
  },
};
