/** Shared side-effect-free first-forward plan checks for preparation and execution. */
import { forwardValueSha256 as digest } from './release-runtime-forward-child-protocol.mjs';
const check = (ok, reason) => { if (!ok) throw Error(`forward_initialization_${reason}`); };

/** Reject plans not supported by the existing execution consumer; performs no I/O. */
export function validateFirstForwardPlans(config) {
    const { supervisorPlan, mutatorPlan } = config.forwardActivation;
    check(digest(supervisorPlan) === config.expected.supervisorPlanSha256
        && digest(mutatorPlan) === config.expected.mutatorPlanSha256, 'plan_pin_changed');
    for (const list of [supervisorPlan.sources, mutatorPlan.sources]) {
        check(Array.isArray(list) && list.length > 0 && list.length <= 64, 'inventory_missing'); let previous = '';
        for (const source of list) { check(typeof source.sourceId === 'string' && source.sourceId > previous, 'inventory_order'); previous = source.sourceId; }
    }
    for (const source of mutatorPlan.sources) {
        check(['system', 'user'].includes(source.scope) && /^[A-Za-z0-9_.@-]+\.(service|timer)$/.test(source.unit)
            && !source.unit.startsWith('pm2-') && !source.unit.includes('cloudflared')
            && (source.scope !== 'user' || /^[a-z_][a-z0-9_-]{0,31}$/.test(source.user || ''))
            && /^[a-f0-9]{64}$/.test(source.configurationSha256 || '')
            && typeof source.cgroupPath === 'string' && source.cgroupPath.startsWith('/') && source.cgroupPath !== '/'
            && !source.cgroupPath.includes('..'), 'unsupported_inhibitor');
        if (source.optional) check(Array.isArray(source.creationSourceIds) && source.creationSourceIds.length > 0
            && source.creationSourceIds.every(id => mutatorPlan.sources.some(other => other.sourceId === id && !other.optional)), 'absent_creation_uncontrolled');
    }
    check(Array.isArray(mutatorPlan.inventory) && mutatorPlan.inventory.length > 0, 'launch_inventory_missing');
    for (const source of supervisorPlan.sources) {
        check(['pm2-dump-json', 'pm2-ecosystem-json'].includes(source.format)
            && Array.isArray(source.writerSourceIds) && source.writerSourceIds.length > 0
            && source.writerSourceIds.every(id => mutatorPlan.sources.some(item => item.sourceId === id)), 'writer_inventory_missing');
    }
}
