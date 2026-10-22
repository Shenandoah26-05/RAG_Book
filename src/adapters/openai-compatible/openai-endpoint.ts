import { z } from "zod";
import { RagError } from "../../shared/index.js";
import { retryHints } from "../http-failure.js";

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

const REDACTED = "[redacted]";

/** Looks like a request to the server of an OpenAI-compatible API: where it is and who is asking. */
export interface OpenAiEndpointOptions {
  /** Base URL up to and including the version, e.g. `https://api.openai.com/v1`. */
  readonly baseUrl: string;
  /** Optional: local servers (LM Studio, vLLM, Ollama) often need no key. */
  readonly apiKey?: string;
}

/**
 * Where an OpenAI-compatible server is and the key to use with it. The one place that holds the key.
 *
 * The key lives in a private field: it is never a property, so it does not show up in `JSON.stringify`,
 * `console.log` or a structured log of an adapter. It leaves this object only as the `Authorization`
 * header, and every text that comes back from the server goes through `redact` before it can reach an
 * error message (servers like to echo a rejected key).
 */
export class OpenAiEndpoint {
  /** The base URL without a trailing slash and without credentials; safe to show. */
  readonly baseUrl: string;

  readonly #apiKey: string | undefined;

  /** @throws RagError CONFIG_INVALID if the base URL is not an http(s) URL */
  constructor(options: OpenAiEndpointOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    const key = options.apiKey?.trim();
    this.#apiKey = key === undefined || key === "" ? undefined : key;
  }

  /** Reads `OPENAI_BASE_URL` and `OPENAI_API_KEY`. Both are optional. */
  static fromEnv(env: Readonly<Record<string, string | undefined>>): OpenAiEndpoint {
    const baseUrl = env["OPENAI_BASE_URL"]?.trim();
    const apiKey = env["OPENAI_API_KEY"];
    return new OpenAiEndpoint({
      baseUrl: baseUrl === undefined || baseUrl === "" ? DEFAULT_OPENAI_BASE_URL : baseUrl,
      ...(apiKey === undefined ? {} : { apiKey }),
    });
  }

  get hasKey(): boolean {
    return this.#apiKey !== undefined;
  }

  url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      ...(this.#apiKey === undefined ? {} : { Authorization: `Bearer ${this.#apiKey}` }),
    };
  }

  /** `text` with the key (if it appears) replaced. Use on anything that came from the server. */
  redact(text: string): string {
    return this.#apiKey === undefined ? text : text.split(this.#apiKey).join(REDACTED);
  }

  /** An error for "could not reach the server". The cause is kept; it never holds the key. */
  unreachable(cause: unknown): RagError {
    return new RagError("PROVIDER_UNAVAILABLE", `Cannot reach the server at ${this.baseUrl}`, {
      cause,
      retryable: true,
    });
  }

  /** An error for a response that is not like an OpenAI-compatible API's. */
  notCompatible(what: string, cause?: unknown): RagError {
    return new RagError(
      "PROVIDER_UNAVAILABLE",
      `The server at ${this.baseUrl} did not answer like an OpenAI-compatible API (${what})`,
      cause === undefined ? {} : { cause },
    );
  }

  /**
   * An error for a non-2xx response, with what the server said (key removed). 401 and 403 say how
   * to set the key, 404 names the model.
   */
  async httpError(response: Response, model: string): Promise<RagError> {
    const detail = this.redact(await errorDetail(response));
    const status = response.status.toString();
    if (response.status === 401 || response.status === 403) {
      return new RagError(
        "PROVIDER_UNAVAILABLE",
        `The server at ${this.baseUrl} refused the request (HTTP ${status}: ${detail}). ${
          this.hasKey
            ? "Check OPENAI_API_KEY."
            : "It wants an API key: set OPENAI_API_KEY in the environment."
        }`,
        { retryable: false },
      );
    }
    if (response.status === 404) {
      return new RagError(
        "PROVIDER_UNAVAILABLE",
        `The server at ${this.baseUrl} has no model "${model}" or no such endpoint (${detail}). Check the model name and OPENAI_BASE_URL`,
        { retryable: false },
      );
    }
    return new RagError(
      "PROVIDER_UNAVAILABLE",
      `The server at ${this.baseUrl} answered with HTTP ${status} (${detail})`,
      retryHints(response),
    );
  }
}

function normalizeBaseUrl(value: string): string {
  const raw = value.trim();
  const bad = (reason: string, cause?: unknown): RagError =>
    new RagError(
      "CONFIG_INVALID",
      `OPENAI_BASE_URL is not a valid address (${reason}). Use something like ${DEFAULT_OPENAI_BASE_URL}`,
      cause === undefined ? {} : { cause },
    );
  let url: URL;
  try {
    url = new URL(raw);
  } catch (cause) {
    // the text is not echoed: it may hold credentials
    throw bad("cannot be parsed", cause);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw bad("must be http or https");
  if (url.username !== "" || url.password !== "") {
    throw bad("put the key in OPENAI_API_KEY, not in the URL");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** The message of an OpenAI-style error body (`{"error":{"message":...}}`), else the status text. */
async function errorDetail(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    const parsed = z
      .object({ error: z.union([z.string(), z.object({ message: z.string() })]) })
      .safeParse(body);
    if (parsed.success) {
      return typeof parsed.data.error === "string" ? parsed.data.error : parsed.data.error.message;
    }
  } catch {
    // not JSON: fall through to the status text
  }
  return response.statusText === "" ? "no details" : response.statusText;
}
