/**
 * Software WebAuthn authenticator for tests (B-1407). Produces genuinely
 * signed ES256 registration ('none' attestation) and assertion responses that
 * @simplewebauthn/server verifies for real, so user-verification, counter
 * regression and challenge binding are exercised end to end — no stubbed crypto.
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

import { isoCBOR } from '@simplewebauthn/server/helpers';

import { WEBAUTHN_ORIGINS, WEBAUTHN_RP_ID } from '../constants/webauthn.js';

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

const b64url = (bytes: Uint8Array | Buffer) => Buffer.from(bytes).toString('base64url');
const u32 = (value: number) => {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
};

export type SoftAuthenticator = ReturnType<typeof createSoftAuthenticator>;

/** Creates one authenticator holding one ES256 credential. */
export function createSoftAuthenticator() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credentialIdBytes = randomBytes(16);
  const id = b64url(credentialIdBytes);
  const rpIdHash = createHash('sha256').update(WEBAUTHN_RP_ID).digest();
  const origin = WEBAUTHN_ORIGINS[0];
  let counter = 0;

  const cosePublicKey = isoCBOR.encode(new Map<number, number | Uint8Array>([
    [1, 2], [3, -7], [-1, 1],
    [-2, new Uint8Array(Buffer.from(String(jwk.x), 'base64url'))],
    [-3, new Uint8Array(Buffer.from(String(jwk.y), 'base64url'))],
  ]));

  const clientData = (type: string, challenge: string) =>
    Buffer.from(JSON.stringify({ type, challenge, origin }));

  return {
    id,
    /** RegistrationResponseJSON for `challenge`. */
    register(challenge: string, { uv = true }: { uv?: boolean } = {}) {
      const flags = FLAG_UP | FLAG_AT | (uv ? FLAG_UV : 0);
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(credentialIdBytes.length);
      const authData = Buffer.concat([
        rpIdHash, Buffer.from([flags]), u32(0), Buffer.alloc(16), idLength, credentialIdBytes,
        Buffer.from(cosePublicKey),
      ]);
      const attestationObject = isoCBOR.encode(new Map<string, string | Map<string, string> | Uint8Array>([
        ['fmt', 'none'], ['attStmt', new Map<string, string>()], ['authData', new Uint8Array(authData)],
      ]));
      return {
        id, rawId: id, type: 'public-key' as const,
        response: {
          clientDataJSON: b64url(clientData('webauthn.create', challenge)),
          attestationObject: b64url(attestationObject),
          transports: ['internal'],
        },
        clientExtensionResults: {},
      };
    },
    /** AuthenticationResponseJSON for `challenge`; the counter advances unless given. */
    assert(challenge: string, { uv = true, signCount }: { uv?: boolean; signCount?: number } = {}) {
      counter = signCount ?? counter + 1;
      const authData = Buffer.concat([
        rpIdHash, Buffer.from([FLAG_UP | (uv ? FLAG_UV : 0)]), u32(counter),
      ]);
      const clientDataJSON = clientData('webauthn.get', challenge);
      const signed = Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]);
      return {
        id, rawId: id, type: 'public-key' as const,
        response: {
          clientDataJSON: b64url(clientDataJSON),
          authenticatorData: b64url(authData),
          signature: b64url(sign('sha256', signed, privateKey)),
        },
        clientExtensionResults: {},
      };
    },
  };
}
