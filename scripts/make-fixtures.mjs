// Regenerates the PDFs in tests/fixtures/. Run: node scripts/make-fixtures.mjs
//
// The PDFs are written by hand (Helvetica, no embedded fonts, no libraries) so they are tiny and
// every character on every page is known.
import { writeFileSync } from "node:fs";

/** One line of text: font F1 (regular) or F2 (bold), size, position. */
const line = (font, size, x, y, text) => ({ font, size, x, y, text });

function buildPdf(title, pages) {
  const objects = []; // index = object number - 1
  const add = (body) => objects.push(body) && objects.length;

  const catalog = add("");
  const pagesRoot = add("");
  const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  const info = add(`<< /Title (${title}) /Producer (RAG Book fixture generator) >>`);

  const pageIds = pages.map((lines) => {
    const stream = lines
      .map((l) => `BT /${l.font} ${l.size} Tf ${l.x} ${l.y} Td (${l.text}) Tj ET`)
      .join("\n");
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    return add(
      `<< /Type /Page /Parent ${pagesRoot} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R ` +
        `/Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> >>`,
    );
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesRoot} 0 R >>`;
  objects[pagesRoot - 1] =
    `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((i) => `${i} 0 R`).join(" ")}] >>`;

  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

function write(file, title, pages) {
  const pdf = buildPdf(title, pages);
  writeFileSync(file, pdf, "latin1");
  console.log(`wrote ${file} (${pdf.length} bytes)`);
}

// sample.pdf: four pages, headings of two sizes, a hyphenated line break and a page with no text.
write("tests/fixtures/sample.pdf", "Sample Book", [
  [
    line("F2", 24, 72, 700, "Chapter 1: Introduction"),
    line(
      "F1",
      12,
      72,
      660,
      "Retrieval-augmented generation combines search with a language model.",
    ),
    line("F1", 12, 72, 642, "This sample book exists to test the PDF loader."),
  ],
  [
    line("F2", 16, 72, 700, "1.1 Background"),
    line("F1", 12, 72, 670, "Embeddings turn sentences into vec-"),
    line("F1", 12, 72, 652, "tors that can be compared."),
    line("F1", 12, 72, 622, "Chunking splits a document into passages."),
  ],
  [
    line("F2", 24, 72, 700, "Chapter 2: Methods"),
    line("F1", 12, 72, 660, "Each page keeps its own text."),
  ],
  [], // a page with no text layer
]);

// noisy.pdf: what a typeset book looks like to an extractor. Every page has a running header and a
// printed page number (the first PDF page is printed as page 3). Pages 1 and 2 have words split
// across lines.
const header = line("F1", 9, 72, 760, "The RAG Handbook");
const footer = (n) => line("F1", 9, 300, 40, String(n));
write("tests/fixtures/noisy.pdf", "The RAG Handbook", [
  [
    header,
    line("F2", 24, 72, 700, "Chapter 1: Noise"),
    line("F1", 12, 72, 660, "Cleaning removes extraction noise before chunking."),
    line("F1", 12, 72, 642, "Words are split with a hyph-"),
    line("F1", 12, 72, 624, "en across lines."),
    footer(3),
  ],
  [
    header,
    line("F2", 16, 72, 700, "1.1 Details"),
    line("F1", 12, 72, 670, "The header and the page number repeat on every page."),
    line("F1", 12, 72, 652, "Embeddings turn sentences into vec-"),
    line("F1", 12, 72, 634, "tors that can be compared."),
    footer(4),
  ],
  [header, line("F1", 12, 72, 700, "Body text of the third page."), footer(5)],
  [header, line("F1", 12, 72, 700, "Body text of the fourth page."), footer(6)],
  [header, line("F1", 12, 72, 700, "Body text of the fifth page."), footer(7)],
  [header, line("F1", 12, 72, 700, "Body text of the sixth page."), footer(8)],
]);
