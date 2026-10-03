# Setup

RAG Book runs its models locally with [Ollama](https://ollama.com), so no data leaves your machine.
You need two models:

| Model        | Used for                                             | Download (approx.) |
| ------------ | ---------------------------------------------------- | ------------------ |
| `all-minilm` | Sentence-BERT embeddings (turning text into vectors) | 45 MB              |
| `llama3.2`   | Generating answers (the 3B model)                    | 2 GB               |

Use a machine with at least 8 GB of RAM. A GPU is optional; without one, answers are slower.

## 1. Install the project

See the [README](../README.md): Node 22, pnpm, then `pnpm install`.

## 2. Install Ollama

- **Windows**: download the installer from <https://ollama.com/download>, or run
  `winget install Ollama.Ollama`.
- **macOS**: download the app from <https://ollama.com/download>, or `brew install ollama`.
- **Linux**: `curl -fsSL https://ollama.com/install.sh | sh`.

On Windows and macOS the app starts the server in the background. On Linux, or if you installed
only the command-line tool, start it yourself and leave it running:

```sh
ollama serve
```

## 3. Pull the models

```sh
ollama pull all-minilm
ollama pull llama3.2
```

Check what is installed with `ollama list`.

## 4. Point the project at Ollama (optional)

If Ollama runs on the default address (`http://127.0.0.1:11434`) you need to do nothing. Otherwise
copy the example file and edit it:

```sh
cp .env.example .env     # Windows PowerShell: Copy-Item .env.example .env
```

`OLLAMA_HOST` accepts `host`, `host:port` or a full URL; the port defaults to 11434.

## 5. Check everything

```sh
pnpm run doctor
```

Use `pnpm run doctor`, not `pnpm doctor`: pnpm has its own built-in `doctor` command, which takes
priority and checks pnpm's installation instead of ours.

It reads `rag.config.json` (and any `RAG_*` overrides), then checks that Ollama is reachable and
that every Ollama model the configuration uses is installed. For each problem it prints the fix:

```
RAG Book doctor

[ ok ] Ollama is reachable: http://127.0.0.1:11434
[ ok ] Model all-minilm (embedding): installed
[FAIL] Model llama3.2 (generation): not installed
       fix: ollama pull llama3.2

1 problem(s) to fix.
```

The command exits with code 1 if anything failed, so scripts can rely on it.

## Troubleshooting

| Symptom                              | Cause and fix                                                                                        |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `Cannot reach Ollama at ...`         | The server is not running. Start the Ollama app, or run `ollama serve`.                              |
| Reachable, but on the wrong machine  | `OLLAMA_HOST` is set in your shell or `.env`. Unset it, or correct it.                               |
| `OLLAMA_HOST is not a valid address` | Use `host:port` or a full `http://` URL.                                                             |
| `Model ... not installed`            | Run the `ollama pull ...` command shown.                                                             |
| Model installed but reported missing | A different tag is installed (e.g. `llama3.2:1b`). Pull the exact name from your config.             |
| `Invalid configuration: ...`         | Fix the setting named in the message; it says where the value came from (file, env var or CLI flag). |
