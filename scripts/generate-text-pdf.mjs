// Writes tests/fixtures/media/text-20-pages.pdf: a 20-page text PDF (Helvetica, one heading and three lines
// per page) for the OCR e2e gate. Hand-written PDF objects, no dependencies; the xref offsets are computed.
// Run: node scripts/generate-text-pdf.mjs
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGES = 20;
const OUT = join(import.meta.dirname, '..', 'tests', 'fixtures', 'media', 'text-20-pages.pdf');

/** Escapes text for a PDF string literal. */
const literal = (text) => `(${text.replace(/[\\()]/g, (char) => `\\${char}`)})`;

function pageContent(n) {
  const lines = [
    `This is page ${n} of the ORtoolbox OCR test document.`,
    'It carries a text layer, so pdf.js can read it too.',
    `The last line of page ${n} ends here.`,
  ];
  return [
    `BT /F1 24 Tf 72 720 Td ${literal(`Page ${n} of ${PAGES}`)} Tj ET`,
    `BT /F1 12 Tf 16 TL 72 680 Td ${lines.map((line) => `${literal(line)} Tj T*`).join(' ')} ET`,
  ].join('\n');
}

// Objects 1 (catalog), 2 (page tree), 3 (font), then a page and its content stream per page.
const pageObject = (n) => 4 + (n - 1) * 2;
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  `<< /Type /Pages /Kids [${Array.from({ length: PAGES }, (_, i) => `${pageObject(i + 1)} 0 R`).join(' ')}] /Count ${PAGES} >>`,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
];
for (let n = 1; n <= PAGES; n++) {
  const content = pageContent(n);
  objects.push(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${pageObject(n) + 1} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  );
}

let pdf = '%PDF-1.4\n';
const offsets = [];
objects.forEach((body, index) => {
  offsets.push(Buffer.byteLength(pdf, 'latin1'));
  pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
});
const xref = Buffer.byteLength(pdf, 'latin1');
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

writeFileSync(OUT, pdf, 'latin1');
console.log(`Wrote ${OUT} (${Buffer.byteLength(pdf, 'latin1')} bytes, ${PAGES} pages)`);
