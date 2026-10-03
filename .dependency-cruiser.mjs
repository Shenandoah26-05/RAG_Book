// Layer rules for src/. See docs/architecture.md for the diagram and the reasoning.
// Dependencies point downwards only:
//   cli -> composition -> pipeline/eval -> strategies/adapters -> core
// `shared` (logger, errors, trace) and `config` sit beside the layers; see the rules below.

const IMPL = "^src/(adapters|strategies)/";
const TEST_FILE = "\\.test\\.ts$";

/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: "core-imports-only-core",
      comment:
        "core holds domain types and ports. It imports nothing from the rest of the project.",
      severity: "error",
      from: { path: "^src/core/" },
      to: { path: "^src/", pathNot: "^src/core/" },
    },
    {
      name: "core-no-third-party",
      comment: "core has no third-party runtime packages. Node built-ins (node:crypto) are fine.",
      severity: "error",
      from: { path: "^src/core/", pathNot: TEST_FILE },
      to: { dependencyTypes: ["npm", "npm-dev", "npm-optional", "npm-peer", "npm-bundled"] },
    },
    {
      name: "strategies-only-core",
      comment: "Strategies are pure algorithms: core, shared and their own folder only.",
      severity: "error",
      from: { path: "^src/strategies/" },
      to: { path: "^src/", pathNot: "^src/(core|shared|strategies)/" },
    },
    {
      name: "adapters-only-core",
      comment: "Adapters talk to the outside world: core, shared and their own folder only.",
      severity: "error",
      from: { path: "^src/adapters/" },
      to: { path: "^src/", pathNot: "^src/(core|shared|adapters)/" },
    },
    {
      name: "pipeline-eval-talk-to-ports",
      comment: "pipeline and eval orchestrate through ports. They never import a concrete class.",
      severity: "error",
      from: { path: "^src/(pipeline|eval)/", pathNot: TEST_FILE },
      to: { path: IMPL },
    },
    {
      name: "only-composition-knows-concrete-classes",
      comment:
        "Only composition/ may import from adapters/ or strategies/. Everything else goes through ports.",
      severity: "error",
      from: { path: "^src/", pathNot: [`^src/(composition|adapters|strategies)/`, TEST_FILE] },
      to: { path: IMPL },
    },
    {
      name: "shared-imports-only-core",
      comment: "shared (logger, errors, trace) may use core types and nothing else in the project.",
      severity: "error",
      from: { path: "^src/shared/" },
      to: { path: "^src/", pathNot: "^src/(core|shared)/" },
    },
    {
      name: "config-imports-core-and-shared",
      comment: "config validates and loads settings. It does not know about any layer above core.",
      severity: "error",
      from: { path: "^src/config/" },
      to: { path: "^src/", pathNot: "^src/(core|shared|config)/" },
    },
    {
      name: "no-reaching-into-folders",
      comment:
        "Import a folder through its index.ts barrel, not its internals (same-folder imports are fine).",
      severity: "error",
      from: { path: "^src/([^/]+)/", pathNot: TEST_FILE },
      to: {
        path: "^src/[^/]+/.+/",
        pathNot: ["^src/$1/", "/index\\.ts$"],
      },
    },
    {
      name: "no-circular",
      comment: "Circular dependencies make the layering meaningless.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-orphans",
      comment: "A module nothing imports is dead code (barrels and entry points excepted).",
      severity: "warn",
      from: {
        orphan: true,
        pathNot: ["(^|/)index\\.ts$", TEST_FILE, "\\.d\\.ts$", "^src/cli/"],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
