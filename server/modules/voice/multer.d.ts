/**
 * Minimal ambient types for `multer`, covering ONLY what the voice module uses.
 *
 * WHY A LOCAL SHIM AND NOT `@types/multer`. multer ships no types and this repo
 * has no `@types/multer`; every other caller is plain JS (`routes/auth.js`,
 * `routes/settings.js`) where `checkJs:false` makes the absence invisible. The
 * voice router is TypeScript under `strict`, so the import needs a declaration.
 * Adding a dependency to land one route would touch package.json /
 * package-lock.json — files several parallel sessions are editing — for a
 * surface that uses four members of the API. If `@types/multer` is ever added,
 * DELETE THIS FILE: two declarations of the same module is a conflict, not a
 * belt-and-braces.
 *
 * Deliberately narrow: memory storage only (the audio must never touch disk),
 * and `single()` only (one recording per request).
 */
declare module 'multer' {
  import type { RequestHandler } from 'express';

  namespace multer {
    type File = {
      fieldname: string;
      originalname: string;
      mimetype: string;
      size: number;
      /** Present with memoryStorage — the only storage this module uses. */
      buffer: Buffer;
    };

    type StorageEngine = { _handleFile: unknown; _removeFile: unknown };

    type Options = {
      storage?: StorageEngine;
      limits?: {
        fileSize?: number;
        files?: number;
        fields?: number;
        parts?: number;
        fieldSize?: number;
      };
      fileFilter?: (
        req: unknown,
        file: File,
        callback: (error: Error | null, acceptFile?: boolean) => void,
      ) => void;
    };

    type Instance = {
      single(fieldName: string): RequestHandler;
    };

    /** Thrown for LIMIT_FILE_SIZE / LIMIT_FILE_COUNT / LIMIT_UNEXPECTED_FILE. */
    class MulterError extends Error {
      constructor(code: string, field?: string);
      code: string;
      field?: string;
    }

    function memoryStorage(): StorageEngine;
  }

  function multer(options?: multer.Options): multer.Instance;

  export = multer;
}
