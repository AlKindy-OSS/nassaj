const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseNassajReleaseVersion(value) {
    if (typeof value !== 'string' || !EXACT_VERSION.test(value)) return null;
    const parts = value.split('.').map(Number);
    return parts.every(Number.isSafeInteger) ? parts : null;
}

export function isNassajReleaseVersion(value) {
    return parseNassajReleaseVersion(value) !== null;
}

export function compareNassajReleaseVersions(left, right) {
    const a = parseNassajReleaseVersion(left);
    const b = parseNassajReleaseVersion(right);
    if (!a || !b) throw new TypeError('Nassaj releases must use canonical four-part versions');
    for (let index = 0; index < 4; index += 1) {
        if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
    }
    return 0;
}

export function releaseTagForVersion(version) {
    if (!isNassajReleaseVersion(version)) throw new TypeError('Invalid Nassaj release version');
    return `v${version}`;
}
