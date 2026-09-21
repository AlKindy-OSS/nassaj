import express from 'express';

export const GLOBAL_BODY_LIMIT = '1mb';

export function isPayloadTooLargeError(error) {
  return error?.status === 413 || error?.type === 'entity.too.large';
}

/** Returns parser instances for direct security testing without booting the server. */
export function createGlobalBodyParsers() {
  return [
    express.json({
      limit: GLOBAL_BODY_LIMIT,
      type: (req) => {
        const contentType = req.headers['content-type'] || '';
        if (contentType.includes('multipart/form-data')) {
          return false;
        }
        return contentType.includes('json');
      },
    }),
    express.urlencoded({ limit: GLOBAL_BODY_LIMIT, extended: true }),
  ];
}

/** Installs bounded parsers before authentication while leaving multipart untouched. */
export function installGlobalBodyParsers(app) {
  for (const parser of createGlobalBodyParsers()) {
    app.use(parser);
  }
}
