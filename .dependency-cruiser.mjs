// Layer rules for src/, and boundary rules for the workspace around it (ADR-0006).
// See docs/architecture.md for the diagram and the reasoning.
// Dependencies point downwards only:
//   cli | api -> composition -> pipeline/eval -> strategies/adapters -> core
// `shared` (logger, errors, trace) and `config` sit beside the layers; see the rules below.
// Outside src/: apps/web (browser) and packages/api-contract (wire format) never import the library.

const IMPL = "^src/(adapters|strategies)/";
const TEST_FILE = "\\.test\\.ts$";
/** Shared helpers for tests (src/testing). Tests may use them; production code may not. */
const TESTING = "^src/testing/";
/** The wire format shared by the API and the web app: by folder, and by workspace package name. */
const CONTRACT = "^(packages/api-contract|node_modules/@rag-book/api-contract)/";
/** Browser-side code: it must run without Node. Build config and tests may use Node. */
const BROWSER_CODE = "^(apps/web|packages/api-contract)/";
const NODE_ONLY_FILES = ["(^|/)vite\\.config\\.", TEST_FILE];

/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: "core-imports-only-core",
      comment:
        "core holds domain types and ports. It imports nothing from the rest of the project.",
      severity: "error",
      from: { path: "^src/core/" },
      to: { path: "^src/", pathNot: ["^src/core/", TESTING] },
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
      to: { path: "^src/", pathNot: ["^src/(core|shared|strategies)/", TESTING] },
    },
    {
      name: "adapters-only-core",
      comment: "Adapters talk to the outside world: core, shared and their own folder only.",
      severity: "error",
      from: { path: "^src/adapters/" },
      to: { path: "^src/", pathNot: ["^src/(core|shared|adapters)/", TESTING] },
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
      to: { path: "^src/", pathNot: ["^src/(core|shared)/", TESTING] },
    },
    {
      name: "config-imports-core-and-shared",
      comment: "config validates and loads settings. It does not know about any layer above core.",
      severity: "error",
      from: { path: "^src/config/" },
      to: { path: "^src/", pathNot: ["^src/(core|shared|config)/", TESTING] },
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
      name: "testing-helpers-only-for-tests",
      comment:
        "src/testing holds helpers for tests (they import vitest and are left out of the build). Production code must not import them.",
      severity: "error",
      from: { path: "^src/", pathNot: [TESTING, TEST_FILE] },
      to: { path: TESTING },
    },
    {
      name: "testing-imports-only-core-and-shared",
      comment:
        "Test helpers build documents from core types and shared helpers (such as makeDocId) and nothing else in the project.",
      severity: "error",
      from: { path: TESTING },
      to: { path: "^src/", pathNot: ["^src/(core|shared)/", TESTING] },
    },
    {
      name: "web-never-imports-the-library",
      comment:
        "The browser bundle must not pull in Node code. Types and schemas it needs come from packages/api-contract.",
      severity: "error",
      from: { path: "^apps/web/" },
      to: { path: "^src/" },
    },
    {
      name: "web-and-contract-are-browser-code",
      comment:
        "If it would not run in a browser it does not belong in apps/web or packages/api-contract. Build config and tests are exempt.",
      severity: "error",
      from: { path: BROWSER_CODE, pathNot: NODE_ONLY_FILES },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "contract-imports-nothing",
      comment:
        "Both the API and the web app depend on the contract, so it can depend on neither (or on the library).",
      severity: "error",
      from: { path: "^packages/api-contract/" },
      to: { path: "^(src|apps)/" },
    },
    {
      name: "library-never-imports-apps",
      comment: "Apps depend on the library, never the reverse.",
      severity: "error",
      from: { path: "^src/" },
      to: { path: "^apps/" },
    },
    {
      name: "only-the-api-uses-the-contract",
      comment: "Domain types stay independent of the wire format: only src/api maps between them.",
      severity: "error",
      from: { path: "^src/", pathNot: "^src/api/" },
      to: { path: CONTRACT },
    },
    {
      name: "entry-points-are-leaves",
      comment:
        "src/api and src/cli call the library; the library never calls an entry point. They do not import each other.",
      severity: "error",
      from: { path: "^src/", pathNot: ["^src/api/", "^src/cli/"] },
      to: { path: "^src/(api|cli)/" },
    },
    {
      name: "entry-points-do-not-import-each-other",
      comment: "Share code through composition, not between entry points.",
      severity: "error",
      from: { path: "^src/api/" },
      to: { path: "^src/cli/" },
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
        pathNot: [
          "(^|/)index\\.ts$",
          TEST_FILE,
          "\\.d\\.ts$",
          "^src/(cli|api)/",
          NODE_ONLY_FILES[0],
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    // build output (apps/web/dist) is generated code, not part of the layering
    exclude: { path: "(^|/)dist/" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
