/** Distinct readiness budgets for fault injection versus complete activation rehearsals. */
export function applyLabHealthPolicy(environment, policy) {
    if(!['bridge-fault','full'].includes(policy))throw Error('lab_health_policy_invalid');
    const result={...environment};
    if(policy==='bridge-fault')return {...result,WARM_READY_TIMEOUT_S:'1',POST_RESTART_HEALTH_ATTEMPTS:'2',POST_RESTART_HEALTH_INTERVAL_S:'0',NASSAJ_OID_HEALTH_ATTEMPTS:'2',NASSAJ_OID_HEALTH_INTERVAL_MS:'250'};
    for(const key of ['WARM_READY_TIMEOUT_S','POST_RESTART_HEALTH_ATTEMPTS','POST_RESTART_HEALTH_INTERVAL_S'])delete result[key];
    return {...result,NASSAJ_OID_HEALTH_ATTEMPTS:'90',NASSAJ_OID_HEALTH_INTERVAL_MS:'500'};
}

/** Check the effective saved PM2 application environment before producer/activation authority is requested. */
export function assertFullLabHealthPolicy(environment) {
    if(environment?.NASSAJ_OID_HEALTH_ATTEMPTS!=='90'||environment?.NASSAJ_OID_HEALTH_INTERVAL_MS!=='500'
        || ['WARM_READY_TIMEOUT_S','POST_RESTART_HEALTH_ATTEMPTS','POST_RESTART_HEALTH_INTERVAL_S'].some(key=>Object.hasOwn(environment,key)))throw Error('lab_full_health_policy_mismatch');
    return {policy:'full',attempts:90,intervalMs:500,shortWarmPostOverridesAbsent:true};
}
