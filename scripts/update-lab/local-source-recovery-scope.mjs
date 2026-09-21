/** Explicit laboratory coverage; omitting the scope always requires the full update cycle. */
export function recoveryLabScope(scope='full') {
    if(!['full','first-boot-only'].includes(scope))throw Error('recovery_lab_scope_invalid');
    return scope;
}

/** Complete only the requested scope; a first-boot result never claims next-update verification. */
export async function finishRecoveryLabScope(scope,completeNextUpdate) {
    if(recoveryLabScope(scope)==='first-boot-only')return {
        state:'source_recovery_first_boot_only_verified',stage:'first-boot-only-complete',nextUpdateVerified:false,
    };
    await completeNextUpdate();
    return {state:'source_recovery_and_next_button_update_verified',stage:'complete',nextUpdateVerified:true};
}
