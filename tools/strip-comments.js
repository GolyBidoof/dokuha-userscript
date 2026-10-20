'use strict';
/*
 *
 * This is deliberately not a regex: a hand-written single-pass lexer walks the
 * source and tracks exactly the constructs where `//` or `/*` are not comments,
 * and where a `/` is not the start of a regex:
 *
 *
 * Regex-versus-division is decided from the preceding significant token, using
 * the usual JavaScript rule (after an identifier that is not a keyword, a
 * number, a string, a template, a regex, `)`, `]`, or an object-literal `}` a
 * slash divides). `{` is classified block-vs-object as it is pushed so that a
 * `/` after `}` can be decided too. A slash that claims to open a regex but has
 * no terminator before the end of the line is treated as division and left
 * alone; nothing here rewrites a token, it only deletes comments and folds
 * whitespace, so the worst case is a construct left unstripped, never a
 * corrupted script.
 *
 * The output keeps the source's line structure and indentation and folds runs
 * of blank lines to at most one, so the artifact stays readable and any test
 * that slices the bundle by a `\n    function ...` boundary still works. The
 * metadata block is not passed through here at all: build.mjs renders it
 * verbatim from src/_meta/00-header.txt.
 *
 * CommonJS on purpose: build.mjs (ESM) imports it and tests/*.js require it, so
 * both strip with the byte-identical implementation.
 */

// After one of these identifiers a `/` opens a regex literal (they are the
// keywords that syntactically expect an expression next).
const REGEX_AFTER_KEYWORD = new Set([
    'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
    'throw', 'do', 'else', 'yield', 'await', 'case', 'default',
]);

// Longest first, so `>>>=` beats `>>>` beats `>>` beats `>`.
const OPERATORS = [
    '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '&&=', '||=', '??=',
    '>>>', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '**', '++', '--',
    '+=', '-=', '*=', '%=', '&=', '|=', '^=', '<<', '>>', '/=',
];

function isWhitespace(c) {
    return c === ' ' || c === '\t' || c === '\n' || c === '\r' ||
        c === '\f' || c === '\v' || c === '\u00a0' || c === '\ufeff';
}

function isDigit(c) {
    return c >= '0' && c <= '9';
}

function isIdStart(c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$' ||
        (c !== undefined && c.charCodeAt(0) > 127);
}

function isIdPart(c) {
    return isIdStart(c) || isDigit(c);
}

// A token is either code (copied verbatim), whitespace, or a comment (dropped).
// `prev` is the significant token that precedes the current position, which is
// all the context the `/` decision needs.
function tokenize(src) {
    const segs = [];
    const n = src.length;
    let i = 0;
    let prev = null;

    const push = (type, from, to) => {
        if (to > from) segs.push({ type, text: src.slice(from, to) });
    };

    function regexAllowed() {
        if (prev === null) return true;
        if (prev.kind === 'name') return REGEX_AFTER_KEYWORD.has(prev.value);
        if (prev.kind === 'number' || prev.kind === 'string' ||
            prev.kind === 'template' || prev.kind === 'regex') return false;
        const v = prev.value;
        if (v === ')' || v === ']') return false;
        if (v === '}') return prev.brace === 'block';
        if (v === '++' || v === '--') return false;
        return true;
    }

    // `{` is an object literal when an expression sits to its left and a block
    // when a statement does. Only a `/` immediately after the matching `}`
    // reads this, so the ambiguous corners are harmless either way.
    function classifyBrace() {
        if (prev && prev.kind === 'op' && prev.brace === 'object' && prev.value === '{') return 'object';
        if (prev === null) return 'block';
        if (prev.kind === 'name') {
            const v = prev.value;
            if (v === 'else' || v === 'do' || v === 'try' || v === 'finally') return 'block';
            return 'object';
        }
        if (prev.kind === 'op') {
            const v = prev.value;
            if (v === ')' || v === '=>' || v === ';' || v === '{' || v === '}') return 'block';
            return 'object';
        }
        return 'object';
    }

    function scanRegex(start) {
        let j = start + 1;
        let inClass = false;
        let closed = false;
        while (j < n) {
            const c = src[j];
            if (c === '\\') { j += 2; continue; }
            if (c === '\n' || c === '\r') return -1;
            if (inClass) { if (c === ']') inClass = false; j++; continue; }
            if (c === '[') { inClass = true; j++; continue; }
            if (c === '/') { j++; closed = true; break; }
            j++;
        }
        if (!closed) return -1;
        while (j < n) {
            const c = src[j];
            if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) j++;
            else break;
        }
        return j;
    }

    function scanString(start, quote) {
        let j = start + 1;
        while (j < n) {
            const c = src[j];
            if (c === '\\') { j += 2; continue; }
            if (c === quote) { j++; break; }
            if (c === '\n' || c === '\r') break;
            j++;
        }
        return Math.min(j, n);
    }

    function scanNumber(start) {
        let j = start;
        if (src[j] === '0' && (src[j + 1] === 'x' || src[j + 1] === 'X' ||
            src[j + 1] === 'b' || src[j + 1] === 'B' ||
            src[j + 1] === 'o' || src[j + 1] === 'O')) {
            j += 2;
            while (j < n && /[0-9a-fA-F_]/.test(src[j])) j++;
        } else {
            while (j < n && /[0-9_]/.test(src[j])) j++;
            if (src[j] === '.') {
                j++;
                while (j < n && /[0-9_]/.test(src[j])) j++;
            }
            if (src[j] === 'e' || src[j] === 'E') {
                j++;
                if (src[j] === '+' || src[j] === '-') j++;
                while (j < n && /[0-9_]/.test(src[j])) j++;
            }
        }
        if (src[j] === 'n') j++;
        return j;
    }

    function matchOperator(start) {
        const c = src[start];
        if (c === '?' && src[start + 1] === '.' && !isDigit(src[start + 2])) return '?.';
        for (const op of OPERATORS) {
            if (src.startsWith(op, start)) return op;
        }
        return c;
    }

    // A template literal is code, except that the code inside each `${ ... }`
    // is lexed like any other expression so its comments and blank lines go.
    function scanTemplate() {
        const start = i;
        push('code', start, start + 1);
        i = start + 1;
        let chunk = i;
        while (i < n) {
            const c = src[i];
            if (c === '\\') { i += 2; continue; }
            if (c === '`') {
                push('code', chunk, i + 1);
                i++;
                prev = { kind: 'template' };
                return;
            }
            if (c === '$' && src[i + 1] === '{') {
                push('code', chunk, i + 2);
                i += 2;
                prev = null; // an expression starts here: a leading `/` is a regex
                scan(true);
                if (i < n && src[i] === '}') { push('code', i, i + 1); i++; }
                chunk = i;
                continue;
            }
            i++;
        }
        push('code', chunk, n);
        prev = { kind: 'template' };
    }

    function scan(stopAtBrace) {
        const braces = [];
        while (i < n) {
            const c = src[i];

            if (isWhitespace(c)) {
                const from = i;
                while (i < n && isWhitespace(src[i])) i++;
                push('ws', from, i);
                continue;
            }

            if (c === '/') {
                const d = src[i + 1];
                if (d === '/') {
                    const from = i;
                    i += 2;
                    while (i < n && src[i] !== '\n' && src[i] !== '\r') i++;
                    push('comment', from, i);
                    continue;
                }
                if (d === '*') {
                    const from = i;
                    i += 2;
                    while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
                    i = Math.min(n, i + 2);
                    push('comment', from, i);
                    continue;
                }
                if (regexAllowed()) {
                    const end = scanRegex(i);
                    if (end !== -1) { push('code', i, end); prev = { kind: 'regex' }; i = end; continue; }
                }
                if (d === '=') { push('code', i, i + 2); prev = { kind: 'op', value: '/=' }; i += 2; }
                else { push('code', i, i + 1); prev = { kind: 'op', value: '/' }; i += 1; }
                continue;
            }

            if (c === "'" || c === '"') {
                const end = scanString(i, c);
                push('code', i, end);
                prev = { kind: 'string' };
                i = end;
                continue;
            }

            if (c === '`') { scanTemplate(); continue; }

            if (c === '{') {
                const kind = classifyBrace();
                braces.push(kind);
                push('code', i, i + 1);
                prev = { kind: 'op', value: '{', brace: kind };
                i++;
                continue;
            }

            if (c === '}') {
                if (braces.length) {
                    const kind = braces.pop();
                    push('code', i, i + 1);
                    prev = { kind: 'op', value: '}', brace: kind };
                    i++;
                    continue;
                }
                if (stopAtBrace) return;
                push('code', i, i + 1);
                prev = { kind: 'op', value: '}', brace: 'block' };
                i++;
                continue;
            }

            if (c === '(' || c === ')' || c === '[' || c === ']') {
                push('code', i, i + 1);
                prev = { kind: 'op', value: c };
                i++;
                continue;
            }

            if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
                const end = scanNumber(i);
                push('code', i, end);
                prev = { kind: 'number' };
                i = end;
                continue;
            }

            if (isIdStart(c)) {
                const from = i;
                i++;
                while (i < n && isIdPart(src[i])) i++;
                push('code', from, i);
                prev = { kind: 'name', value: src.slice(from, i) };
                continue;
            }

            const op = matchOperator(i);
            push('code', i, i + op.length);
            prev = { kind: 'op', value: op };
            i += op.length;
        }
    }

    scan(false);
    return segs;
}

// Folds the whitespace and comments between two code tokens. Newlines are kept
// (at most one blank line), indentation after the last newline is kept, and a
// run of spaces on one line becomes a single space. A comment never glues two
// tokens together: it always leaves a separator behind.
function foldWhitespace(raw) {
    if (!raw) return '';
    let newlines = 0;
    let last = -1;
    for (let k = 0; k < raw.length; k++) {
        if (raw[k] === '\n') { newlines++; last = k; }
    }
    if (newlines === 0) return ' ';
    const indent = raw.slice(last + 1);
    return '\n'.repeat(Math.min(newlines, 2)) + indent;
}

function render(segs) {
    let out = '';
    let pending = '';
    for (const seg of segs) {
        if (seg.type === 'ws') { pending += seg.text; continue; }
        if (seg.type === 'comment') {
            if (seg.text.startsWith('//')) {
                pending += ' ';
            } else {
                let newlines = 0;
                for (let k = 0; k < seg.text.length; k++) {
                    if (seg.text[k] === '\n') newlines++;
                }
                pending += newlines ? '\n'.repeat(Math.min(newlines, 2)) : ' ';
            }
            continue;
        }
        let sep = foldWhitespace(pending);
        pending = '';
        if (out === '') {
            // No leading blank lines; keep the first line's indentation so the
            // bundle still matches a `\n    function ...` boundary.
            sep = sep.indexOf('\n') === -1 ? '' : sep.slice(sep.lastIndexOf('\n') + 1);
        }
        out += sep + seg.text;
    }
    return out;
}

function stripSource(src) {
    return render(tokenize(src));
}

module.exports = { stripSource, tokenize };
