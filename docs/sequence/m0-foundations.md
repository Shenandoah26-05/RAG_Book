# M0 Foundations: function-level sequence diagrams

Back to the [pipeline view](00-pipeline.md). M0 is the layer every other milestone stands on:
config, logger, errors, trace, ids and the Ollama doctor.

Source map

| Area   | Files                                                                                                    |
| ------ | -------------------------------------------------------------------------------------------------------- |
| Config | `config/load-config.ts`, `overrides.ts`, `schema.ts`, `defaults.ts`, `config-hash.ts`, `config-error.ts` |
| Shared | `shared/errors.ts`, `logger.ts`, `trace.ts`, `doc-id.ts`, `file-hash.ts`                                 |
| Core   | `core/types/ids.ts` (`contentHash`, `makeChunkId`), `core/ports/model-host.ts`                           |
| Doctor | `cli/doctor.ts`, `composition/build-doctor.ts`, `pipeline/doctor.ts`, `adapters/ollama/ollama-host.ts`   |

Cases covered: [1 Config load](#1-loadconfig-happy-path) · [2 Config errors](#2-loadconfig-failure-cases) ·
[3 Override parsing](#3-override-parsing-env-and-cli) · [4 resolveConfig merge](#4-resolveconfig-merge-and-validate) ·
[5 Config hash](#5-hashconfig) · [6 Doctor happy](#6-doctor-everything-ok) ·
[7 Doctor failures](#7-doctor-failure-cases) · [8 OllamaHost.listModels](#8-ollamahostlistmodels-all-cases) ·
[9 normalizeOllamaHost](#9-normalizeollamahost) · [10 Ids](#10-ids-docid-and-chunkid) ·
[11 sha256OfFile](#11-sha256offile) · [12 Logger](#12-logger) · [13 Trace](#13-trace) · [14 Errors](#14-errors)

---

## 1. `loadConfig` happy path

Layers, lowest priority first: defaults → `rag.config.json` → `RAG_*` env → `--section.key` flags.

```mermaid
sequenceDiagram
  autonumber
  participant Caller as buildIngest, buildInspect, buildDoctor
  participant LC as loadConfig
  participant FS as node:fs readFile
  participant RC as resolveConfig
  participant OV as overrides.ts
  participant Z as ragConfigSchema (zod)

  Caller->>LC: loadConfig({argv, env, cwd})
  LC->>LC: configFlag(argv) or env.RAG_CONFIG or "rag.config.json"
  LC->>FS: readFile(resolve(cwd, file))
  FS-->>LC: text
  LC->>LC: JSON.parse(text)
  LC->>RC: resolveConfig({file, fileLabel, env, argv})
  RC->>RC: deepMerge(DEFAULT_CONFIG, file), record leafPaths in sources
  RC->>OV: cliOverrides(argv)
  OV-->>RC: overrides, errors
  RC->>OV: envOverrides(env)
  OV-->>RC: overrides
  loop layers: env first, then cli
    RC->>OV: applyOverrides(layer)
    OV-->>RC: patch, errors
    RC->>RC: deepMerge(merged, patch), sources.set(path, source)
  end
  RC->>Z: safeParse(merged)
  Z-->>RC: success with data
  RC->>RC: deepFreeze(data)
  RC-->>LC: RagConfig
  LC-->>Caller: RagConfig
```

## 2. `loadConfig` failure cases

```mermaid
sequenceDiagram
  autonumber
  participant Caller
  participant LC as loadConfig
  participant FS as readFile
  participant RC as resolveConfig
  participant CE as ConfigError

  Note over Caller,CE: Case A. Default file rag.config.json is missing
  Caller->>LC: loadConfig()
  LC->>FS: readFile("rag.config.json")
  FS--xLC: ENOENT
  Note right of LC: missing and no explicit path, so this is allowed
  LC->>RC: resolveConfig({file: undefined})
  RC-->>Caller: defaults only (with env and flags on top)

  Note over Caller,CE: Case B. --config or RAG_CONFIG names a missing file
  Caller->>LC: loadConfig({argv: ["--config", "x.json"]})
  LC->>FS: readFile("x.json")
  FS--xLC: ENOENT
  LC->>CE: new ConfigError(["config file not found: ..."])
  CE--xCaller: throw CONFIG_INVALID

  Note over Caller,CE: Case C. Other read error (permissions, directory)
  LC->>FS: readFile(file)
  FS--xLC: EACCES or EISDIR
  LC->>CE: new ConfigError(["cannot read ..."])
  CE--xCaller: throw CONFIG_INVALID

  Note over Caller,CE: Case D. File is not valid JSON
  LC->>FS: readFile(file)
  FS-->>LC: text
  LC->>LC: JSON.parse throws
  LC->>CE: new ConfigError(["rag.config.json is not valid JSON: ..."])
  CE--xCaller: throw CONFIG_INVALID

  Note over Caller,CE: Case E. File parses but is not an object, or settings are wrong
  LC->>RC: resolveConfig(...)
  RC->>RC: collect errors (non-object file, bad flag, unknown setting, bad type)
  RC->>CE: new ConfigError(all issues)
  CE--xCaller: throw CONFIG_INVALID listing every problem
```

## 3. Override parsing (env and CLI)

```mermaid
sequenceDiagram
  autonumber
  participant RC as resolveConfig
  participant EO as envOverrides
  participant CO as cliOverrides
  participant AO as applyOverrides
  participant DA as defaultAt
  participant CZ as coerce
  participant SA as setAt

  RC->>EO: envOverrides(env)
  Note right of EO: RAG_CHUNKING__MAX_TOKENS=300 gives path chunking.maxTokens<br/>keys without "__" such as RAG_CONFIG are skipped
  EO->>EO: screamingToCamel for each path part
  EO-->>RC: RawOverride[] (path, raw, source)

  RC->>CO: cliOverrides(argv)
  loop each argv item starting with "--"
    CO->>CO: skip flags without "." (they belong to the command)
    CO->>CO: kebabToCamel path, split "--a.b=v" or "--a.b v"
    alt value given with "="
      CO->>CO: raw = text after "="
    else setting is a boolean per DEFAULT_CONFIG
      CO->>DA: defaultAt(path)
      DA-->>CO: boolean template
      CO->>CO: bare flag means "true", or consume next true/false
    else next token missing or starts with "--"
      CO->>CO: errors.push("--flag: needs a value")
    else
      CO->>CO: raw = next token, skip it
    end
  end
  CO-->>RC: overrides, errors

  RC->>AO: applyOverrides(layer)
  loop each override
    AO->>DA: defaultAt(path)
    alt template is undefined
      AO->>AO: errors.push('unknown setting "a.b"')
    else
      AO->>CZ: coerce(template, raw)
      alt string template
        CZ-->>AO: raw
      else number template
        CZ-->>AO: Number(raw) or "expected a number"
      else boolean template
        CZ-->>AO: true/false/1/0 or "expected true or false"
      else list template
        CZ-->>AO: JSON array or comma split, or "expected a JSON list"
      end
      AO->>SA: setAt(patch, path, value)
    end
  end
  AO-->>RC: patch, errors
```

## 4. `resolveConfig` merge and validate

The schema is strict: unknown keys fail, and two cross-field rules run after the per-field checks.

```mermaid
sequenceDiagram
  autonumber
  participant RC as resolveConfig
  participant DM as deepMerge
  participant Z as ragConfigSchema
  participant CE as ConfigError

  RC->>DM: deepMerge(DEFAULT_CONFIG, file)
  Note right of DM: objects merge key by key<br/>lists and scalars are replaced
  DM-->>RC: merged
  RC->>Z: safeParse(merged)
  alt valid
    Z-->>RC: data
    RC->>RC: deepFreeze, return
  else invalid
    Z-->>RC: issues
    loop each issue
      RC->>RC: "where: message (from source)" using sources map
    end
    RC->>CE: new ConfigError(lines)
    CE--xRC: throw CONFIG_INVALID
  end
  Note over Z: Rules checked<br/>kebab-case names, positive ints, strict objects<br/>overlapTokens must be below maxTokens<br/>rerank.candidates must be at least retrieval.k when rerank is enabled
```

## 5. `hashConfig`

```mermaid
sequenceDiagram
  autonumber
  participant Exp as Experiment code (M8, later)
  participant HC as hashConfig
  participant CJ as canonicalJson
  participant CH as contentHash (core/types/ids.ts)

  Exp->>HC: hashConfig(config)
  HC->>CJ: canonicalJson(config)
  CJ->>CJ: sort object keys, recurse into arrays and objects
  CJ-->>HC: stable string
  HC->>CH: contentHash("config", json)
  CH->>CH: SHA-256 over length-prefixed parts
  CH-->>HC: hex digest
  HC-->>Exp: hash (same settings in any key order give the same hash)
```

## 6. Doctor: everything OK

`pnpm run doctor` (`cli/doctor.ts`).

```mermaid
sequenceDiagram
  autonumber
  actor User
  participant CLI as cli/doctor.ts
  participant BD as buildDoctor
  participant LC as loadConfig
  participant NH as normalizeOllamaHost
  participant OH as OllamaHost
  participant RD as runDoctor
  participant Ollama as Ollama /api/tags
  participant FR as formatReport, hasFailures

  User->>CLI: pnpm run doctor
  CLI->>CLI: if .env exists, process.loadEnvFile(".env")
  CLI->>BD: buildDoctor()
  BD->>LC: loadConfig({argv, env})
  LC-->>BD: RagConfig
  BD->>NH: normalizeOllamaHost(env.OLLAMA_HOST)
  NH-->>BD: base URL
  BD->>OH: new OllamaHost(address, fetch)
  BD->>BD: required models: embedding.model if provider is ollama, generation.model if provider is ollama
  BD-->>CLI: Doctor { run }
  CLI->>RD: doctor.run() = runDoctor(host, required)
  RD->>RD: mergeByModel (same model, two purposes, checked once)
  RD->>OH: listModels()
  OH->>Ollama: GET /api/tags (5 s timeout)
  Ollama-->>OH: { models: [{name}] }
  OH-->>RD: installed names
  loop each required model
    RD->>RD: hasModel(installed, model) treats "x" as "x:latest"
  end
  RD-->>CLI: CheckResult[] all "ok"
  CLI->>FR: formatReport(results)
  FR-->>CLI: text
  CLI-->>User: "[ ok ] ..." and "Everything needed is in place."
```

## 7. Doctor failure cases

```mermaid
sequenceDiagram
  autonumber
  actor User
  participant CLI as cli/doctor.ts
  participant BD as buildDoctor
  participant RD as runDoctor
  participant OH as OllamaHost
  participant FR as formatReport, hasFailures

  Note over User,FR: Case A. Config or OLLAMA_HOST is invalid
  User->>CLI: pnpm run doctor
  CLI->>BD: buildDoctor()
  BD--xCLI: ConfigError (bad config) or RagError INVALID_ARGUMENT (bad OLLAMA_HOST)
  CLI-->>User: message on stderr, exitCode 1

  Note over User,FR: Case B. Configuration uses no Ollama model
  CLI->>RD: runDoctor(host, [])
  RD-->>CLI: [ { status: "skip", detail: "the configuration uses no models from it" } ]
  CLI-->>User: report, exit code 0

  Note over User,FR: Case C. Ollama is not reachable
  CLI->>RD: runDoctor(host, required)
  RD->>OH: listModels()
  OH--xRD: RagError PROVIDER_UNAVAILABLE
  RD-->>CLI: [fail "Ollama is reachable" + fix hint, skip each model]
  CLI->>FR: hasFailures(results) is true
  CLI-->>User: report and exitCode 1

  Note over User,FR: Case D. Reachable but a model is missing
  RD->>OH: listModels()
  OH-->>RD: installed names
  RD->>RD: hasModel false for one model
  RD-->>CLI: [ok reachable, ok model A, fail model B with "ollama pull B"]
  CLI-->>User: "1 problem(s) to fix." and exitCode 1
```

## 8. `OllamaHost.listModels` all cases

```mermaid
sequenceDiagram
  autonumber
  participant RD as runDoctor
  participant OH as OllamaHost.listModels
  participant F as fetch
  participant Z as tagsResponse (zod)

  RD->>OH: listModels(signal?)
  OH->>OH: timeout = AbortSignal.timeout(5000), combine with signal via AbortSignal.any
  OH->>F: fetch(address + "/api/tags", {signal})
  alt network error or timeout
    F--xOH: throws
    OH--xRD: RagError PROVIDER_UNAVAILABLE "Cannot reach Ollama at ..."
  else HTTP status not ok
    F-->>OH: Response (e.g. 500)
    OH--xRD: RagError PROVIDER_UNAVAILABLE "answered with HTTP 500"
  else body is not JSON
    F-->>OH: Response
    OH->>OH: response.json() throws
    OH--xRD: RagError PROVIDER_UNAVAILABLE "did not answer like Ollama (not JSON)"
  else JSON has the wrong shape
    OH->>Z: safeParse(body)
    Z-->>OH: failure
    OH--xRD: RagError PROVIDER_UNAVAILABLE "(unexpected response)"
  else success
    OH->>Z: safeParse(body)
    Z-->>OH: { models: [{name}] }
    OH-->>RD: names
  end
```

## 9. `normalizeOllamaHost`

```mermaid
sequenceDiagram
  autonumber
  participant BD as buildDoctor
  participant NH as normalizeOllamaHost
  participant URL as new URL

  BD->>NH: normalizeOllamaHost(env.OLLAMA_HOST)
  alt unset or blank
    NH-->>BD: "http://127.0.0.1:11434"
  else value given
    NH->>NH: add "http://" if no scheme, ":11434" alone becomes 127.0.0.1:11434
    NH->>URL: new URL(withScheme)
    alt cannot be parsed
      URL--xNH: TypeError
      NH--xBD: RagError INVALID_ARGUMENT "cannot be parsed"
    else protocol is not http or https
      NH--xBD: RagError INVALID_ARGUMENT "must be http or https"
    else
      NH->>NH: http without port gets 11434, host 0.0.0.0 becomes 127.0.0.1
      NH-->>BD: url.origin
    end
  end
```

## 10. Ids: DocId and ChunkId

```mermaid
sequenceDiagram
  autonumber
  participant Ing as pipeline/ingest.ts
  participant FH as sha256OfFile
  participant MD as makeDocId
  participant UU as uuid v5
  participant CB as createChunk (M2)
  participant MC as makeChunkId
  participant CH as contentHash
  participant ID as isDocId

  Ing->>FH: sha256OfFile(path)
  FH-->>Ing: hex digest
  Ing->>MD: makeDocId(digest)
  MD->>UU: v5(digest, DOC_ID_NAMESPACE)
  UU-->>MD: UUID
  MD-->>Ing: DocId (same file always gives the same id)

  CB->>MC: makeChunkId({docId, strategy, charStart, charEnd, text})
  MC->>CH: contentHash("chunk", docId, strategy, start, end, text)
  CH->>CH: for each part hash.update("<length>:<part>|")
  CH-->>MC: SHA-256 hex
  MC-->>CB: ChunkId

  Note over ID: Used wherever an id arrives from outside
  Ing->>ID: isDocId(value)
  ID->>ID: valid UUID, version 5, all lower case
  ID-->>Ing: true or false (guards file names against "../x")
```

## 11. `sha256OfFile`

```mermaid
sequenceDiagram
  autonumber
  participant Ing as ingest
  participant SF as sha256OfFile
  participant RS as createReadStream
  participant H as crypto hash

  Ing->>SF: sha256OfFile(path)
  SF->>RS: createReadStream(path)
  loop each chunk of the stream
    RS-->>SF: Buffer
    SF->>H: update(buffer)
  end
  alt file cannot be read
    RS--xSF: error
    SF--xIng: RagError INGESTION_FAILED "Cannot read path"
  else
    SF->>H: digest("hex")
    H-->>SF: hex
    SF-->>Ing: hex
  end
```

## 12. Logger

```mermaid
sequenceDiagram
  autonumber
  participant Code as any module
  participant L as Logger (createConsoleLogger or createJsonLogger)
  participant ML as makeLogger.log
  participant F as formatConsole or formatJson
  participant W as write (stderr by default)

  Code->>L: child({file})
  L-->>Code: new Logger with bound fields merged
  Code->>L: info("ingesting", {loader})
  L->>ML: log("info", message, fields)
  alt level below minimum
    ML-->>Code: dropped
  else
    ML->>F: format({time, level, message, fields: bound + call fields})
    F->>F: jsonReplacer turns Error into serializeError, bigint into string
    F-->>ML: one line
    ML->>W: write(line)
  end
  Note over Code,W: noopLogger is a Logger that does nothing, used in tests and as a default
```

## 13. Trace

`Trace` times pipeline stages. Ingest uses `run`; `start` is for work that does not fit one function.

```mermaid
sequenceDiagram
  autonumber
  participant P as pipeline/ingest
  participant T as Trace
  participant H as StageHandle

  P->>T: new Trace() records origin time
  P->>T: run("load", fn, summarize)
  T->>T: start("load") records startedAt
  T-->>H: handle
  T->>P: await fn()
  alt fn succeeds
    P-->>T: result
    T->>H: end(summarize(result))
    H->>T: push StageRecord status "ok"
    T-->>P: result
  else fn throws
    P--xT: error
    T->>H: fail(error)
    H->>T: push StageRecord status "error" with message
    T--xP: rethrow the same error
  end
  P->>T: snapshot()
  T-->>P: { totalMs, stages } (totalMs = latest startMs + durationMs)
  Note over H: Closing a handle twice throws RagError INTERNAL
```

## 14. Errors

```mermaid
sequenceDiagram
  autonumber
  participant Src as any module
  participant RE as RagError
  participant CE as ConfigError
  participant SE as serializeError
  participant Log as Logger
  participant CLI as cli entry

  Src--xRE: throw new RagError(code, message, {cause})
  Note right of RE: codes: CONFIG_INVALID, INGESTION_FAILED, INVALID_ARGUMENT,<br/>PROVIDER_UNAVAILABLE, INTERNAL
  Src--xCE: ConfigError(issues) extends RagError with CONFIG_INVALID
  Log->>SE: serializeError(error)
  SE->>SE: name, message, code, stack, then recurse on cause (max depth 5)
  SE-->>Log: plain JSON-safe object
  CLI->>CLI: catch, console.error(error.message), process.exitCode = 1 (2 for bad arguments)
```
