#!/usr/bin/env node
/** Root-only fixed-token host dispatcher. It accepts no paths, commands, or URLs from the worker. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dispatchReleaseRuntimeHostOperation } from './lib/release-runtime-host-operations.mjs';
import { readInstalledHostConfiguration } from './lib/release-runtime-installed-config.mjs';

/** Read only the attested installed configuration before any dispatcher operation. */
export function readRootConfig() { return readInstalledHostConfiguration().value; }
/** Bound transport completion before any operation can acquire the journal lock. */
export async function readHostDispatcherInput(stream, { timeoutMs = 5_000, maximumBytes = 65_536 } = {}) {
    let timer;
    const read = async () => {
        const chunks = []; let size = 0;
        for await (const chunk of stream) {
            const bytes = Buffer.from(chunk); size += bytes.length;
            if (size > maximumBytes) throw new Error('host_dispatcher_input_too_large');
            chunks.push(bytes);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    };
    try {
        return await Promise.race([read(), new Promise((_, reject) => {
            timer = setTimeout(() => { reject(new Error('host_dispatcher_input_timeout')); stream.destroy(); }, timeoutMs);
        })]);
    } finally { clearTimeout(timer); }
}
async function main() {
    if (process.argv.length !== 3) throw new Error('host_dispatcher_action_invalid');
    const result = await dispatchReleaseRuntimeHostOperation(readRootConfig(), process.argv[2], await readHostDispatcherInput(process.stdin));
    const output = `${JSON.stringify(result)}\n`;
    if (Buffer.byteLength(output) > 65_536) throw new Error('host_dispatcher_output_too_large');
    process.stdout.write(output);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        process.stderr.write(`Nassaj host dispatcher blocked (${error?.message || 'failed'}).\n`); process.exitCode = 78;
    });
}
