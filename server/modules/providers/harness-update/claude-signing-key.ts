/**
 * Anthropic's Claude Code release-signing public key (ADR-215 stage B, ش3),
 * as a binary OpenPGP keyring for `gpgv --keyring`. Source:
 * https://downloads.claude.ai/keys/claude-code.asc (fetched 2026-10-20),
 * dearmored with `gpg --dearmor`. The committed `keys/claude-code.asc` is the
 * reviewable original; a test dearmors it in-process (CRC-24 checked) and pins
 * that this constant equals it byte for byte and carries the pinned
 * fingerprint (B-1718: no binary keyring in the tree). Embedded so the built server needs no asset copy step.
 */

/** Full 40-hex fingerprint gpgv must report in VALIDSIG (pinned, ADR-215 §3.1). */
export const CLAUDE_SIGNING_FINGERPRINT = '31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE';

/** Binary keyring (base64) holding exactly the key above. */
export const CLAUDE_SIGNING_KEYRING_BASE64 =
  'mQINBGnK73ABEACnbytJXkjweYrwIr0aLEFRlH+C0nF44KxFc7gQmJ6PjSPMGZADdxZcaixU7zZl8WxEpVO0wLmIH8cf2zGO' +
  'dyuZg1Yaugk1vHb2b8WBhAGCQJdPgB8WXquedepEYtk56uP/gCoTjJDUZluEGBHnlnuujSJ4orxEdhSykEoAUfJZGEILPpMd' +
  'bphFt/Sn+Eb/TxM5jpKPdwnv8AShNF/1mZU1fWTQq9tRKJUakZj04gdaDFElQXakCtTij+GT6yoYCARSHwGO+PC/Pr6q4tc+' +
  'D7LRjxSBvUWDoFSmlqb/PJ1hj9D/7I2Oe4XXniAPWMR56KvxHlzOzrNQdJujbJdSkCwh1ZijkSd3y8ayW5WYUTGdRab99NUw' +
  'agzlabe/VVF6kzJ0Scn5q3PihB2Y9Bwo0CKnkYk7a7KT77EWv0Kkq+VHmOtqX3a2hhX+b6a6ve9rzJ1qZYGj+obv/C3Sx1Lz' +
  'UjAfqVy7RJDf2uAoP5t2g8u/TkSpUxhMVEjZBkSxYZhMyzQM6t8IgkUfnSrIPTHixbDWARZ4beMOBjxyPZK1nP7OOrNR3TkK' +
  'JtwLMQAabURCDnL0PjS0iwBTU4jtumBD1XSULyWuoTvMljrpQr1nV1oDyOt0OLqaKA2McWtd9PdXhC8y2EIg7TmrTlJLfHYb' +
  'dmkiCYj4J49Q8HWkN/6WE+RTUwARAQABtD5BbnRocm9waWMgQ2xhdWRlIENvZGUgUmVsZWFzZSBTaWduaW5nIDxzZWN1cml0' +
  'eUBhbnRocm9waWMuY29tPokCUQQTAQoAOxYhBDHd3iTd+rZ59C170rqpKf8afsrOBQJpyu9wAhsPBQsJCAcCAiICBhUKCQgL' +
  'AgQWAgMBAh4HAheAAAoJELqpKf8afsrOl5IP/2I8X1dFy5xYczWB/coIxGjuzS/V6ByZGZZEJsbr04pmuHiFUykJqPGWGQ6q' +
  'U0YF5iEwvEkaagS5m7DzhSEf3FM3Cgafax/6d70tar9Vr1D+w6uPfxetu7u/WYJpaolIsdh5fTrBh9zSM1Njl8FM8wG8CwZQ' +
  'jS33Oa7d8cwRkgdUWbt6LXgz+cTQNuBnBgW6Ks7oZFI25dfu0ojDR+aDFJg4+4wZoyDLPvJz1SIrJ5WFGs67zsx9SfS3yZnf' +
  'XKmBe+f0dUy+GJ2nFZrXFf99+c0dPEHYO8DCeAHZizjkFrdYtUHdDU0YDYEGkLJabE+pgcpkHf5EvsZzHsyDbl95W/eh7pcX' +
  'MbwkN+W4CBYUE9X4uHhqzWaC5yAVRWUA1BJ9V4LjZfHPLEJt0I3TxzXiEg9/BVeaTYq9RjaxIFo9Nfk158HqJY6SA5jslBlx' +
  'Gv/No8u+xVcze2UJyGVfEIUfm92+0UAIkny3+5cuVV0ICzJxXlXj0CnLM9Lt50wEp3suVwuBEviCbZ08eAH1Ht8gbBdSsiOk' +
  'IU8CX3v/scwHHx5q0+NBL6xLrQObg13atRXBlKObfElkPN3lTUbUnJOW4U8uSjH8VRP+AujKWMDFe7x0zCs+iYY1mTOvbrTS' +
  '9n3CmZUmbynZ+E/QWNENpW/pDNZdWFy43PASmML5FHu4m9Sn';
