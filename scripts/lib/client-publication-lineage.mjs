/** Shared pure serving epoch/CAS contract used by the ledger and sealed full-update capsule. */
/** Advance one verified receipt while retaining all protection owners and retirement history. */
export function advanceClientServingLineageRecord(ledger, input) {
    const current = ledger.clientPublicationServing ?? null;
    const hash = value => /^[a-f0-9]{64}$/.test(value || '');
    if (!hash(input.receiptDigest) || !hash(input.generationId) || !hash(input.baseReceiptDigest)
        || !hash(input.assetManifestDigest) || !hash(input.buildId)) throw new Error('client_serving_identity_invalid');
    if ((current?.receiptDigest ?? null) !== input.expectedReceiptDigest) throw new Error('client_serving_lineage_conflict');
    const now = input.now ?? new Date().toISOString();
    const generations = { ...(ledger.clientPublicationGenerations || {}) };
    if (current && current.generationId !== input.generationId) {
        const previous = generations[current.generationId];
        if (!previous?.serving) throw new Error('client_serving_epoch_invalid');
        generations[current.generationId] = { ...previous, serving: false, retiredAt: now };
    }
    const prior = generations[input.generationId];
    const renewed = !prior?.serving;
    generations[input.generationId] = { ...prior, assetManifestDigest: input.assetManifestDigest,
        serving: true, epoch: (prior?.epoch || 0) + (renewed ? 1 : 0),
        servedAt: renewed ? now : prior.servedAt, retiredAt: null,
        protectionOwners: [...new Set([...(prior?.protectionOwners || []), input.receiptDigest])] };
    return { ...ledger, clientPublicationServing: { receiptDigest: input.receiptDigest,
        baseReceiptDigest: input.baseReceiptDigest, generationId: input.generationId,
        buildId: input.buildId, assetManifestDigest: input.assetManifestDigest },
        clientPublicationGenerations: generations, updatedAt: now };
}
