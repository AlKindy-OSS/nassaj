/**
 * Minimal SPDX license-expression parser and allowlist evaluator for the
 * release license gate (ADR-174 §6.5). Grammar (SPDX 2.3 Annex D subset):
 *
 *   or   := and ("OR" and)*
 *   and  := with ("AND" with)*
 *   with := atom ("WITH" id)?
 *   atom := id | "(" or ")"
 *
 * Operators are upper-case only, as the specification requires; anything
 * else is refused as unparseable instead of being guessed at. Dependency-free
 * so it can ship inside the public build script.
 */

const ID = /^(?:LicenseRef-|DocumentRef-[A-Za-z0-9.-]+:LicenseRef-)?[A-Za-z0-9][A-Za-z0-9.-]*\+?$/;
const OPERATORS = new Set(['AND', 'OR', 'WITH']);
const MAX_EXPRESSION_LENGTH = 512;

/** Error thrown for a malformed expression. */
export class SpdxParseError extends Error {
    constructor(detail) {
        super(`spdx expression is unparseable: ${detail}`);
        this.name = 'SpdxParseError';
    }
}

function tokenize(expression) {
    if (typeof expression !== 'string' || expression.length === 0 || expression.length > MAX_EXPRESSION_LENGTH) {
        throw new SpdxParseError('empty or over-long');
    }
    const tokens = expression.replace(/([()])/g, ' $1 ').trim().split(/\s+/);
    for (const token of tokens) {
        if (token === '(' || token === ')' || OPERATORS.has(token)) continue;
        if (!ID.test(token)) throw new SpdxParseError(`bad token ${JSON.stringify(token)}`);
    }
    return tokens;
}

/**
 * Parse an SPDX expression into a tree of
 * `{ type: 'license', id }`, `{ type: 'with', id, exception }`,
 * `{ type: 'and' | 'or', items }`.
 * @param {string} expression
 * @returns {object}
 */
export function parseSpdxExpression(expression) {
    const tokens = tokenize(expression);
    let index = 0;
    const peek = () => tokens[index];
    const take = () => tokens[index++];

    const parseAtom = () => {
        const token = take();
        if (token === '(') {
            const inner = parseOr();
            if (take() !== ')') throw new SpdxParseError('unbalanced parenthesis');
            return inner;
        }
        if (token === undefined || token === ')' || OPERATORS.has(token)) {
            throw new SpdxParseError('expected a license identifier');
        }
        return { type: 'license', id: token };
    };
    const parseWith = () => {
        const atom = parseAtom();
        if (peek() !== 'WITH') return atom;
        take();
        const exception = take();
        if (atom.type !== 'license' || exception === undefined || exception === '(' || exception === ')'
            || OPERATORS.has(exception)) {
            throw new SpdxParseError('WITH needs a license on the left and an exception on the right');
        }
        return { type: 'with', id: atom.id, exception };
    };
    const parseList = (operator, next) => {
        const items = [next()];
        while (peek() === operator) { take(); items.push(next()); }
        return items.length === 1 ? items[0] : { type: operator.toLowerCase(), items };
    };
    const parseAnd = () => parseList('AND', parseWith);
    function parseOr() { return parseList('OR', parseAnd); }

    const tree = parseOr();
    if (index !== tokens.length) throw new SpdxParseError('trailing tokens');
    return tree;
}

/** Render a parsed tree back to a canonical expression string. */
export function formatSpdxTree(tree, parentType = null) {
    if (tree.type === 'license') return tree.id;
    if (tree.type === 'with') return `${tree.id} WITH ${tree.exception}`;
    const text = tree.items.map(item => formatSpdxTree(item, tree.type)).join(` ${tree.type.toUpperCase()} `);
    return parentType ? `(${text})` : text;
}

/**
 * Pick an allowlisted reading of the expression: every AND term must be
 * allowed; for an OR the alternative with the best (lowest) preference rank
 * is elected, ties going to the one written first. `X WITH Y` is allowed only
 * when the exact string is allowlisted.
 * @param {object} tree parsed expression
 * @param {Set<string>|string[]} allowed allowlisted identifiers; an array's
 *   order is the preference order (most permissive first)
 * @returns {object|null} the elected sub-tree, or null when nothing qualifies
 */
export function electAllowedLicense(tree, allowed) {
    const rank = new Map([...allowed].map((id, index) => [id, index]));
    const elected = elect(tree, rank);
    return elected ? elected.tree : null;
}

function elect(tree, rank) {
    if (tree.type === 'license' || tree.type === 'with') {
        const id = tree.type === 'license' ? tree.id : `${tree.id} WITH ${tree.exception}`;
        return rank.has(id) ? { tree, cost: rank.get(id) } : null;
    }
    const items = tree.items.map(item => elect(item, rank));
    if (tree.type === 'or') {
        return items.filter(Boolean).reduce((best, item) => (!best || item.cost < best.cost ? item : best), null);
    }
    if (!items.every(Boolean)) return null;
    return { tree: { type: 'and', items: items.map(item => item.tree) }, cost: Math.max(...items.map(item => item.cost)) };
}

/** Every identifier (and `X WITH Y` unit) named anywhere in the tree. */
export function spdxLicenseIds(tree) {
    if (tree.type === 'license') return [tree.id];
    if (tree.type === 'with') return [`${tree.id} WITH ${tree.exception}`];
    return tree.items.flatMap(spdxLicenseIds);
}
