// Public API of src/strategies/prompting. Named exports only.
export { ORDERING_NAMES, isOrderingName, orderForPrompt } from "./ordering.js";
export type { OrderingName } from "./ordering.js";
export { removeNearDuplicates, textSimilarity } from "./near-duplicates.js";
export { formatSource, makeCitation } from "./format-source.js";
export { SOURCES_PLACEHOLDER, parsePromptTemplate } from "./prompt-template.js";
export {
  DEFAULT_DUPLICATE_THRESHOLD,
  NO_SOURCES,
  TemplateContextAssembler,
} from "./template-context-assembler.js";
export type { TemplateContextAssemblerOptions } from "./template-context-assembler.js";
