// Dependency-free preview models and display limits shared by the parsers
// (lazy chunk) and the viewers (main chunk). Keep this file import-free so the
// viewers never pull jszip, docx-preview or DOMPurify into the main bundle.

export const MAX_SLIDES = 300;
/** Total extracted text kept for text-only previews (slides, OpenDocument text). */
export const MAX_TEXT_CHARS = 1_000_000;

export type SlideText = { number: number; paragraphs: string[] };
export type PresentationData = { slides: SlideText[]; truncated: boolean };

export type TextBlock = { text: string; /** Outline level for headings, null for paragraphs. */ heading: number | null };
export type TextDocumentData = { blocks: TextBlock[]; truncated: boolean };
