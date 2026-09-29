// Reads the text of files people add to their context, entirely in the browser (nothing is uploaded).

export const acceptedFiles = '.pdf,.docx,.txt,.md,.markdown,.csv,.json,application/pdf,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

type PdfJs = typeof import('pdfjs-dist');
const loadPdfJs = async (): Promise<PdfJs> => {
  const [pdfjs, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs;
};

/** Collapses the whitespace noise that PDF and Word extraction leaves behind. */
export const normalizeText = (text: string) => text.replace(/\r\n?/g, '\n').replace(/[ \t\f\v]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

export async function extractText(file: File, pdfjs: () => Promise<PdfJs> = loadPdfJs): Promise<string> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf') || file.type === 'application/pdf') return pdfText(await file.arrayBuffer(), pdfjs);
  if (name.endsWith('.docx')) return docxText(await file.arrayBuffer());
  if (name.endsWith('.doc')) throw new Error('Older .doc files cannot be read. Save it as .docx or PDF.');
  if (file.type.startsWith('text/') || /\.(txt|md|markdown|csv|json)$/.test(name)) return normalizeText(await file.text());
  throw new Error('Unsupported file type. Add a PDF, Word (.docx), or text file.');
}

export async function pdfText(data: ArrayBuffer, pdfjs: () => Promise<PdfJs> = loadPdfJs) {
  const { getDocument } = await pdfjs();
  // Text extraction only, without console warnings about font data that rendering would need.
  const task = getDocument({ data: new Uint8Array(data), verbosity: 0 }); const pdf = await task.promise;
  try {
    const pages: string[] = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const content = await (await pdf.getPage(number)).getTextContent();
      pages.push(content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : '') : '').join(''));
    }
    const text = normalizeText(pages.join('\n\n'));
    if (!text) throw new Error('This PDF has no selectable text (it may be a scanned image).');
    return text;
  } finally { await task.destroy(); }
}

/** A .docx is a zip archive; its body text lives in word/document.xml. */
export async function docxText(data: ArrayBuffer) {
  const xml = await readZipEntry(new Uint8Array(data), 'word/document.xml');
  if (xml === null) throw new Error('This file does not look like a Word document.');
  const text = xml.replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>|<\/w:p>/g, '\n').replace(/<[^>]+>/g, '')
    .replace(/&(lt|gt|amp|quot|apos|#\d+|#x[\da-f]+);/gi, (_, entity: string) => ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" } as Record<string, string>)[entity.toLowerCase()] ?? String.fromCodePoint(entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)));
  return normalizeText(text);
}

async function readZipEntry(bytes: Uint8Array, entryName: string): Promise<string | null> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1; // End-of-central-directory record, searched from the end (it may be followed by a comment).
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65_557); index--) if (view.getUint32(index, true) === 0x06054b50) { end = index; break; }
  if (end < 0) return null;
  let offset = view.getUint32(end + 16, true);
  for (let entry = view.getUint16(end + 10, true); entry > 0; entry--) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) return null;
    const method = view.getUint16(offset + 10, true), size = view.getUint32(offset + 20, true), nameLength = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (name === entryName) {
      const local = view.getUint32(offset + 42, true);
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const compressed = bytes.subarray(start, start + size);
      if (method === 0) return new TextDecoder().decode(compressed);
      if (method !== 8) return null;
      return new Response(new Blob([compressed.slice()]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
    }
    offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  return null;
}
