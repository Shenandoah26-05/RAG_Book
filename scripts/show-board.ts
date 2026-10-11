import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const BOARD_FILE = fileURLToPath(new URL("../RAGBook Build Board.html", import.meta.url));
const PORT = Number(process.env.PORT ?? 4173);

const server = createServer((req, res) => {
  if (req.url !== "/" && req.url !== "/index.html") {
    res.writeHead(404).end("Not found");
    return;
  }
  // Read per request so edits to the board show up on refresh.
  readFile(BOARD_FILE)
    .then((html) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html);
    })
    .catch((err: unknown) => {
      res.writeHead(500).end(`Could not read board: ${String(err)}`);
    });
});

server.listen(PORT, "localhost", () => {
  console.log(`RAGBook Build Board: http://localhost:${String(PORT)}`);
});
