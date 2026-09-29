import { describe, expect, it } from 'vitest';
import { docxText, extractText, normalizeText, pdfText } from './documents';
import { notesDocxBase64, resumePdf } from './fixtures';

const fixtures: Record<string, () => Uint8Array> = {
  'resume.pdf': () => new TextEncoder().encode(resumePdf),
  'notes.docx': () => Uint8Array.from(atob(notesDocxBase64), character => character.charCodeAt(0)),
};
const fixture = (name: string) => fixtures[name]().buffer as ArrayBuffer;
// Node runs PDF.js's legacy build (its worker runs in-process there).
const nodePdfJs = () => import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as Promise<typeof import('pdfjs-dist')>;

describe('documents', () => {
  it('reads PDF text with line breaks', async () => {
    expect(await pdfText(fixture('resume.pdf'), nodePdfJs)).toBe('Jane Doe - Software Engineer\nBuilt a Kafka pipeline processing 2M events per day');
  });

  it('reads Word documents, including escaped characters', async () => {
    expect(await docxText(fixture('notes.docx'))).toBe('Jane Doe\nSoftware Engineer at Acme & Co.\nLed a team of 4 to ship a <realtime> dashboard');
  });

  it('picks the reader by file type', async () => {
    expect(await extractText(new File(['# Notes\r\n\r\n\r\n\r\nShipped  v2   \n'], 'notes.md', { type: 'text/markdown' }))).toBe('# Notes\n\nShipped  v2');
    expect(await extractText(new File([fixture('notes.docx')], 'Notes.DOCX'))).toContain('Acme & Co.');
    expect(await extractText(new File([fixture('resume.pdf')], 'resume.pdf', { type: 'application/pdf' }), nodePdfJs)).toContain('Kafka');
    await expect(extractText(new File(['x'], 'old.doc'))).rejects.toThrow(/\.docx or PDF/);
    await expect(extractText(new File(['x'], 'photo.png', { type: 'image/png' }))).rejects.toThrow(/Unsupported file type/);
    await expect(docxText(new TextEncoder().encode('not a zip').buffer as ArrayBuffer)).rejects.toThrow(/Word document/);
  });

  it('normalizes whitespace', () => {
    expect(normalizeText('  a \t\n\n\n\nb\r\nc  ')).toBe('a\n\nb\nc');
  });
});
