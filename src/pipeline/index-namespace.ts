/**
 * The folder name of an index: `<chunker>__<embedder>`. Characters that are not safe in a file name
 * (the `:` in "ollama:all-minilm" is not allowed on Windows) become `-`, so the index of
 * `recursive` and `ollama:all-minilm` is `recursive__ollama-all-minilm`.
 */
export function indexNamespace(chunker: string, embedderId: string): string {
  const safe = (part: string): string => part.replace(/[^A-Za-z0-9._-]+/g, "-");
  return `${safe(chunker)}__${safe(embedderId)}`;
}
