import { z } from "zod";
import type { ModelHost } from "../../core/index.js";
import { RagError } from "../../shared/index.js";

export const DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434";
const DEFAULT_PORT = "11434";
const REQUEST_TIMEOUT_MS = 5000;

/**
 * Turns the value of OLLAMA_HOST into a base URL, the way Ollama itself reads it: the scheme
 * defaults to http, the port to 11434, and a server address of 0.0.0.0 means this machine.
 * Unset or empty gives the default local address.
 */
export function normalizeOllamaHost(value: string | undefined): string {
  const raw = value?.trim() ?? "";
  if (raw === "") return DEFAULT_OLLAMA_HOST;

  const bad = (reason: string, cause?: unknown): RagError =>
    new RagError(
      "INVALID_ARGUMENT",
      `OLLAMA_HOST is not a valid address (${reason}): "${raw}". Use something like ${DEFAULT_OLLAMA_HOST}`,
      cause === undefined ? {} : { cause },
    );

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  const withScheme = hasScheme ? raw : `http://${raw.startsWith(":") ? `127.0.0.1${raw}` : raw}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch (cause) {
    throw bad("cannot be parsed", cause);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw bad("must be http or https");

  const authority = withScheme.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split("/")[0] ?? "";
  if (url.protocol === "http:" && !/:\d+$/.test(authority)) url.port = DEFAULT_PORT;
  if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
  return url.origin;
}

/** What `GET /api/tags` returns; extra fields are ignored. */
const tagsResponse = z.object({ models: z.array(z.object({ name: z.string() })) });

/** Talks to an Ollama server over HTTP. */
export class OllamaHost implements ModelHost {
  readonly name = "Ollama";
  readonly hints = {
    start: 'Start Ollama (open the Ollama app, or run "ollama serve")',
    pull: (model: string) => `ollama pull ${model}`,
  };
  readonly address: string;
  readonly #fetch: typeof fetch;

  constructor(address: string, fetchFn: typeof fetch = fetch) {
    this.address = address;
    this.#fetch = fetchFn;
  }

  async listModels(signal?: AbortSignal): Promise<readonly string[]> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await this.#fetch(`${this.address}/api/tags`, {
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      });
    } catch (cause) {
      throw new RagError("PROVIDER_UNAVAILABLE", `Cannot reach Ollama at ${this.address}`, {
        cause,
      });
    }
    if (!response.ok) {
      throw new RagError(
        "PROVIDER_UNAVAILABLE",
        `Ollama at ${this.address} answered with HTTP ${response.status.toString()}`,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      throw new RagError(
        "PROVIDER_UNAVAILABLE",
        `The server at ${this.address} did not answer like Ollama (not JSON)`,
        { cause },
      );
    }
    const parsed = tagsResponse.safeParse(body);
    if (!parsed.success) {
      throw new RagError(
        "PROVIDER_UNAVAILABLE",
        `The server at ${this.address} did not answer like Ollama (unexpected response)`,
        { cause: parsed.error },
      );
    }
    return parsed.data.models.map((model) => model.name);
  }
}
