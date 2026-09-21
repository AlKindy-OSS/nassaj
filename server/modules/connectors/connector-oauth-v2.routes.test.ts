import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';

import {
  createConnectorOAuthV2Callback,
  createConnectorOAuthV2Routes,
} from './connector-oauth-v2.routes.js';

const withServer = async (app: express.Express, action: (origin: string) => Promise<void>) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    await action(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
};

test('fresh installs expose no OAuth writes, preserve legacy state, and reject environment-only origin', async () => {
  const prior = process.env.NASSAJ_CONNECTOR_OAUTH_V2;
  const priorOrigin = process.env.NASSAJ_PUBLIC_ORIGIN;
  delete process.env.NASSAJ_CONNECTOR_OAUTH_V2;
  process.env.NASSAJ_PUBLIC_ORIGIN = 'https://nassaj.example';
  try {
    const app = express();
    app.use(express.json());
    app.use('/oauth-v2', createConnectorOAuthV2Routes(() => { throw new Error('must stay inert'); }));
    app.get('/callback', createConnectorOAuthV2Callback(() => { throw new Error('must stay inert'); }));
    app.get('/callback', (_req, res) => res.status(204).end());
    await withServer(app, async origin => {
      const write = await fetch(`${origin}/oauth-v2/google-drive/start`, { method: 'POST' });
      assert.equal(write.status, 404);
      assert.equal((await write.json() as { code: string }).code, 'CONNECTOR_OAUTH_DISABLED');

      const legacy = await fetch(`${origin}/callback?state=legacy-state&code=ok`);
      assert.equal(legacy.status, 204);

      const v2 = await fetch(`${origin}/callback?state=v2.${'a'.repeat(43)}&code=ok`, {
        redirect: 'manual',
      });
      assert.equal(v2.status, 503);
      assert.equal(v2.headers.get('location'), null);
    });
  } finally {
    if (prior === undefined) delete process.env.NASSAJ_CONNECTOR_OAUTH_V2;
    else process.env.NASSAJ_CONNECTOR_OAUTH_V2 = prior;
    if (priorOrigin === undefined) delete process.env.NASSAJ_PUBLIC_ORIGIN;
    else process.env.NASSAJ_PUBLIC_ORIGIN = priorOrigin;
  }
});

test('V2 callback redirects to Connectors settings with opaque fixed status only', async () => {
  const prior = process.env.NASSAJ_CONNECTOR_OAUTH_V2;
  process.env.NASSAJ_CONNECTOR_OAUTH_V2 = '1';
  try {
    let shouldFail = false;
    let fanoutReady = true;
    const fanoutResults: unknown[] = [];
    const runtime = {
      canonicalOrigin: 'https://nassaj.example',
      engine: {
        callback: async () => {
          if (shouldFail) throw new Error('<script>provider diagnostic</script>');
          return {
            userId: 7, serviceId: 'google-drive', grantId: 'opaque', connectorId: 'drive-work-u7',
          };
        },
      },
      fanout: async (result: unknown) => {
        fanoutResults.push(result);
        return fanoutReady;
      },
    };
    const app = express();
    app.get('/callback', createConnectorOAuthV2Callback(() => runtime as never));
    await withServer(app, async origin => {
      const success = await fetch(`${origin}/callback?state=v2.${'a'.repeat(43)}&code=ok`, {
        redirect: 'manual',
      });
      assert.equal(success.status, 303);
      assert.equal(
        success.headers.get('location'),
        'https://nassaj.example/?settings=connectors&connectorOAuth=linked',
      );
      assert.deepEqual(fanoutResults, [{
        userId: 7, serviceId: 'google-drive', grantId: 'opaque', connectorId: 'drive-work-u7',
      }]);
      fanoutReady = false;
      const partial = await fetch(`${origin}/callback?state=v2.${'c'.repeat(43)}&code=ok`, {
        redirect: 'manual',
      });
      assert.equal(
        partial.headers.get('location'),
        'https://nassaj.example/?settings=connectors&connectorOAuth=distributionFailed',
      );
      shouldFail = true;
      const failed = await fetch(`${origin}/callback?state=v2.${'b'.repeat(43)}&code=secret`, {
        redirect: 'manual',
      });
      assert.equal(failed.status, 303);
      assert.equal(
        failed.headers.get('location'),
        'https://nassaj.example/?settings=connectors&connectorOAuth=failed',
      );
      assert.doesNotMatch(failed.headers.get('location') ?? '', /script|diagnostic|secret/u);
    });
  } finally {
    if (prior === undefined) delete process.env.NASSAJ_CONNECTOR_OAUTH_V2;
    else process.env.NASSAJ_CONNECTOR_OAUTH_V2 = prior;
  }
});
