/**
 * Tiny, dependency-free strict shape checker for attested JSON documents.
 * Unknown keys, missing keys, wrong types, out-of-range integers, over-long
 * strings and over-long arrays are all refused. Only JSON value kinds exist
 * here (no floats: every number must be a safe integer).
 */
import { failRelease } from './release-manifest-codes.mjs';

/** Shape constructors. Each returns a frozen descriptor consumed by assertShape. */
export const shape = Object.freeze({
    string: (pattern, maxLength = 256) => Object.freeze({ kind: 'string', pattern, maxLength }),
    integer: (min, max = Number.MAX_SAFE_INTEGER) => Object.freeze({ kind: 'integer', min, max }),
    oneOf: values => Object.freeze({ kind: 'oneOf', values: Object.freeze([...values]) }),
    nullable: inner => Object.freeze({ kind: 'nullable', inner }),
    object: (fields, optional = []) => Object.freeze({ kind: 'object', fields, optional: new Set(optional) }),
    array: (item, { min = 0, max, key } = {}) => Object.freeze({ kind: 'array', item, min, max, key }),
});

/** True for a JSON-parsed plain object (not an array, not a class instance). */
export function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

const CHECKERS = {
    string: checkString,
    integer: checkInteger,
    oneOf: checkOneOf,
    nullable: checkNullable,
    object: checkObject,
    array: checkArray,
};

/**
 * Assert `value` matches `spec`, else throw `code` naming the offending path.
 * @param {object} spec descriptor built with `shape`
 * @param {unknown} value candidate value
 * @param {string} where dotted path used in the error detail
 * @param {string} code reason code to throw on mismatch
 */
export function assertShape(spec, value, where, code) {
    const checker = CHECKERS[spec.kind];
    if (!checker) throw new TypeError(`unknown shape kind ${spec.kind}`);
    checker(spec, value, where, code);
}

function checkString(spec, value, where, code) {
    if (typeof value !== 'string') failRelease(code, `${where} must be a string`);
    if (value.length === 0 || value.length > spec.maxLength) failRelease(code, `${where} has an invalid length`);
    if (spec.pattern && !spec.pattern.test(value)) failRelease(code, `${where} has an invalid format`);
}

function checkInteger(spec, value, where, code) {
    if (!Number.isSafeInteger(value)) failRelease(code, `${where} must be a safe integer`);
    if (value < spec.min || value > spec.max) failRelease(code, `${where} is out of range`);
}

function checkOneOf(spec, value, where, code) {
    if (!spec.values.includes(value)) failRelease(code, `${where} is not an allowed value`);
}

function checkNullable(spec, value, where, code) {
    if (value !== null) assertShape(spec.inner, value, where, code);
}

function checkObject(spec, value, where, code) {
    if (!isPlainObject(value)) failRelease(code, `${where} must be an object`);
    for (const key of Object.keys(value)) {
        if (!Object.hasOwn(spec.fields, key)) failRelease(code, `${where} has an unknown field`);
    }
    for (const [key, fieldSpec] of Object.entries(spec.fields)) {
        if (!Object.hasOwn(value, key)) {
            if (!spec.optional.has(key)) failRelease(code, `${where}.${key} is missing`);
            continue;
        }
        assertShape(fieldSpec, value[key], `${where}.${key}`, code);
    }
}

function checkArray(spec, value, where, code) {
    if (!Array.isArray(value)) failRelease(code, `${where} must be an array`);
    if (value.length < spec.min || value.length > spec.max) failRelease(code, `${where} has an invalid length`);
    value.forEach((item, index) => assertShape(spec.item, item, `${where}[${index}]`, code));
    if (spec.key) assertUnique(value.map(spec.key), where, code);
}

function assertUnique(keys, where, code) {
    if (new Set(keys).size !== keys.length) failRelease(code, `${where} has duplicate entries`);
}

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit, no insignificant
 * whitespace. Used to require that attested bytes have exactly one reading
 * (no duplicate keys, no alternative number spellings, no BOM or padding).
 * @param {unknown} value JSON value
 * @returns {string}
 */
export function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (isPlainObject(value)) {
        const keys = Object.keys(value).sort();
        return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    if (value === undefined || typeof value === 'function' || typeof value === 'bigint') {
        throw new TypeError('value is not JSON');
    }
    return JSON.stringify(value);
}

/** Recursively freeze a parsed JSON value and return it. */
export function deepFreeze(value) {
    if (value !== null && typeof value === 'object') {
        Object.values(value).forEach(deepFreeze);
        Object.freeze(value);
    }
    return value;
}
