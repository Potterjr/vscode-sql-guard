'use strict';

// Lightweight T-SQL scanner: finds statements that can hit a whole table.
//   - UPDATE / DELETE without a top-level WHERE, or whose WHERE is always true (1=1, x=5 OR 1=1)
//   - DROP ... / TRUNCATE TABLE (always, except #temp tables)
// Not a full parser — it tokenizes (skipping comments/strings/[identifiers]) and walks
// tokens with paren + CASE depth tracking. Dynamic SQL inside EXEC('...') is not inspected.

// Reserved words that begin a new statement. Only reserved words are listed, so an
// unbracketed column name can never collide with one.
const STATEMENT_START = new Set([
    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'DROP', 'TRUNCATE', 'CREATE', 'ALTER',
    'EXEC', 'EXECUTE', 'DECLARE', 'PRINT', 'IF', 'ELSE', 'BEGIN', 'END', 'WHILE', 'RETURN',
    'USE', 'GRANT', 'REVOKE', 'DENY', 'RAISERROR', 'COMMIT', 'ROLLBACK', 'SAVE', 'BREAK',
    'CONTINUE', 'GOTO', 'WAITFOR', 'OPEN', 'CLOSE', 'FETCH', 'DEALLOCATE', 'BACKUP',
    'RESTORE', 'DBCC', 'CHECKPOINT', 'KILL', 'SHUTDOWN', 'BULK', 'READTEXT', 'WRITETEXT',
    'UPDATETEXT',
]);

// UPDATE/DELETE preceded by these is not a DML statement
// (MERGE ... THEN DELETE, AFTER UPDATE triggers, ON DELETE CASCADE, GRANT UPDATE, ...).
const NOT_DML_AFTER = new Set(['THEN', 'FOR', 'AFTER', 'OF', 'ON', 'GRANT', 'REVOKE', 'DENY']);

// `IF UPDATE(col)` inside triggers.
const UPDATE_FN_AFTER = new Set(['IF', 'AND', 'OR', 'NOT', 'WHEN']);

const WORD_START = /[A-Za-z_@#\u0080-￿]/;
const WORD_CHAR = /[A-Za-z0-9_@#$\u0080-￿]/;

function tokenize(sql) {
    const tokens = [];
    const n = sql.length;
    let i = 0;
    while (i < n) {
        const c = sql[i];
        const next = sql[i + 1];

        if (/\s/.test(c)) { i++; continue; }

        if (c === '-' && next === '-') {
            while (i < n && sql[i] !== '\n') i++;
            continue;
        }

        if (c === '/' && next === '*') { // T-SQL block comments nest
            let depth = 1;
            i += 2;
            while (i < n && depth > 0) {
                if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; }
                else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; }
                else i++;
            }
            continue;
        }

        if (c === "'" || ((c === 'N' || c === 'n') && next === "'")) {
            const start = i;
            i += c === "'" ? 1 : 2;
            while (i < n) {
                if (sql[i] === "'") {
                    if (sql[i + 1] === "'") { i += 2; continue; }
                    i++;
                    break;
                }
                i++;
            }
            const quoted = sql.slice(start + (c === "'" ? 1 : 2), i - 1);
            tokens.push({ type: 'string', value: quoted.replace(/''/g, "'"), start, end: i });
            continue;
        }

        if (c === '[' || c === '"') {
            const close = c === '[' ? ']' : '"';
            const start = i;
            i++;
            while (i < n) {
                if (sql[i] === close) {
                    if (sql[i + 1] === close) { i += 2; continue; }
                    i++;
                    break;
                }
                i++;
            }
            tokens.push({ type: 'ident', value: sql.slice(start + 1, i - 1), start, end: i });
            continue;
        }

        if (WORD_START.test(c)) {
            const start = i;
            while (i < n && WORD_CHAR.test(sql[i])) i++;
            const value = sql.slice(start, i);
            const upper = value.toUpperCase();
            const lineStart = sql.lastIndexOf('\n', start - 1) + 1;
            const isGo = upper === 'GO' && sql.slice(lineStart, start).trim() === '';
            tokens.push({ type: isGo ? 'go' : 'word', value, upper, start, end: i });
            continue;
        }

        if (/[0-9.]/.test(c)) {
            const start = i;
            while (i < n && /[0-9.eE]/.test(sql[i])) i++;
            tokens.push({ type: 'number', value: sql.slice(start, i), start, end: i });
            continue;
        }

        tokens.push({ type: 'punct', value: c, start: i, end: i + 1 });
        i++;
    }
    return tokens;
}

const isWord = (t, ...words) => t && t.type === 'word' && words.includes(t.upper);
const isPunct = (t, ch) => t && t.type === 'punct' && t.value === ch;

// Index of the first token of the statement after `from`, or tokens.length.
// Also reports the index of the top-level WHERE (-1 if none).
function scanStatement(tokens, from, kind) {
    let parens = 0;
    let cases = 0;
    let seenSet = false;
    let whereAt = -1;
    let i = from;
    for (; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.type === 'go') break;
        if (t.type === 'punct') {
            if (t.value === '(') parens++;
            else if (t.value === ')') { if (--parens < 0) break; }
            else if (t.value === ';' && parens === 0) break;
            continue;
        }
        if (t.type !== 'word') continue;
        if (t.upper === 'CASE') { cases++; continue; }
        if (t.upper === 'END' && cases > 0) { cases--; continue; }
        if (parens > 0) continue;
        if (t.upper === 'ELSE' && cases > 0) continue;
        if (t.upper === 'WHERE') { if (whereAt < 0) whereAt = i; continue; }
        if (t.upper === 'SET') {
            if (kind === 'UPDATE' && !seenSet) { seenSet = true; continue; }
            break;
        }
        if (t.upper === 'WITH' && !isPunct(tokens[i + 1], '(')) break; // CTE, not a table hint
        if (STATEMENT_START.has(t.upper)) break;
    }
    return { end: i, whereAt };
}

const COMPARE = {
    '=': (a, b) => a === b,
    '<>': (a, b) => a !== b,
    '!=': (a, b) => a !== b,
    '<': (a, b) => a < b,
    '>': (a, b) => a > b,
    '<=': (a, b) => a <= b,
    '>=': (a, b) => a >= b,
};

function literal(t) {
    if (t.type === 'number') {
        const n = Number(t.value);
        return Number.isFinite(n) ? n : undefined;
    }
    if (t.type === 'string') return t.value.toLowerCase(); // default collations are case-insensitive
    return undefined;
}

function closingParen(tokens, open) {
    let depth = 0;
    for (let i = open; i < tokens.length; i++) {
        if (isPunct(tokens[i], '(')) depth++;
        else if (isPunct(tokens[i], ')') && --depth === 0) return i;
    }
    return -1;
}

// Splits [from, to) on a top-level AND/OR, ignoring ones inside parens or CASE.
function splitTopLevel(tokens, from, to, keyword) {
    const parts = [];
    let parens = 0;
    let cases = 0;
    let start = from;
    for (let i = from; i < to; i++) {
        const t = tokens[i];
        if (isPunct(t, '(')) parens++;
        else if (isPunct(t, ')')) parens--;
        else if (isWord(t, 'CASE')) cases++;
        else if (isWord(t, 'END') && cases > 0) cases--;
        else if (parens === 0 && cases === 0 && isWord(t, keyword)) {
            parts.push([start, i]);
            start = i + 1;
        }
    }
    parts.push([start, to]);
    return parts;
}

// `<literal> <op> <literal>` that evaluates to true, or a parenthesized always-true condition.
function isTautology(tokens, from, to) {
    if (isPunct(tokens[from], '(') && closingParen(tokens, from) === to - 1) {
        return isAlwaysTrue(tokens, from + 1, to - 1);
    }
    if (to - from !== 3 && to - from !== 4) return false;
    const left = literal(tokens[from]);
    const right = literal(tokens[to - 1]);
    const op = tokens.slice(from + 1, to - 1).map(t => (t.type === 'punct' ? t.value : ' ')).join('');
    if (left === undefined || typeof left !== typeof right || !COMPARE[op]) return false;
    if (typeof left === 'string' && !['=', '<>', '!='].includes(op)) return false;
    return COMPARE[op](left, right);
}

// WHERE conditions that match every row: `1=1`, `'a'='a'`, `(1=1)`, `x = 5 OR 1=1`.
// `1=1 AND x = 5` still filters, so it is not flagged.
function isAlwaysTrue(tokens, from, to) {
    if (from >= to) return false;
    return splitTopLevel(tokens, from, to, 'OR').some(([orFrom, orTo]) =>
        splitTopLevel(tokens, orFrom, orTo, 'AND').every(([f, t]) => f < t && isTautology(tokens, f, t)));
}

// The WHERE condition runs until the statement end or an OPTION (...) query hint.
function conditionEnd(tokens, from, end) {
    for (let i = from; i < end; i++) {
        if (isWord(tokens[i], 'OPTION')) return i;
    }
    return end;
}

// Name of the object targeted by DROP/TRUNCATE (skipping TABLE/IF EXISTS/etc).
function targetName(tokens, from) {
    for (let i = from; i < tokens.length && i < from + 6; i++) {
        const t = tokens[i];
        if (t.type === 'word' && ['TABLE', 'IF', 'EXISTS'].includes(t.upper)) continue;
        if (t.type === 'word' || t.type === 'ident') return t.value;
        return '';
    }
    return '';
}

// Batches that define a proc/function/trigger only store the body; nothing runs.
function isModuleDefinition(tokens, start) {
    let i = start;
    if (isWord(tokens[i], 'CREATE') && isWord(tokens[i + 1], 'OR') && isWord(tokens[i + 2], 'ALTER')) i += 3;
    else if (isWord(tokens[i], 'CREATE', 'ALTER')) i += 1;
    else return false;
    return isWord(tokens[i], 'PROC', 'PROCEDURE', 'FUNCTION', 'TRIGGER');
}

function snippet(sql, start, end) {
    const text = sql.slice(start, end).replace(/\s+/g, ' ').trim();
    return text.length > 90 ? text.slice(0, 87) + '...' : text;
}

/**
 * @param {string} sql
 * @returns {{kind: string, message: string, start: number, end: number, snippet: string}[]}
 */
function analyze(sql) {
    const tokens = tokenize(sql);
    const findings = [];
    let batchStart = 0;
    let skipBatch = isModuleDefinition(tokens, 0);

    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.type === 'go') {
            batchStart = i + 1;
            skipBatch = isModuleDefinition(tokens, batchStart);
            continue;
        }
        if (skipBatch || t.type !== 'word') continue;

        const prev = tokens[i - 1];
        const next = tokens[i + 1];

        if (t.upper === 'UPDATE' || t.upper === 'DELETE') {
            if (isWord(prev, ...NOT_DML_AFTER) || isPunct(prev, ',')) continue;
            if (t.upper === 'UPDATE' && isWord(next, 'STATISTICS')) continue;
            if (t.upper === 'UPDATE' && isPunct(next, '(') && isWord(prev, ...UPDATE_FN_AFTER)) continue;

            const { end, whereAt } = scanStatement(tokens, i + 1, t.upper);
            let message;
            if (whereAt < 0) {
                message = `${t.upper} ไม่มี WHERE — จะกระทบทุกแถวในตาราง`;
            } else if (isAlwaysTrue(tokens, whereAt + 1, conditionEnd(tokens, whereAt + 1, end))) {
                message = `${t.upper} มี WHERE ที่เป็นจริงเสมอ (เช่น 1=1) — จะกระทบทุกแถวในตาราง`;
            }
            if (message) {
                const last = tokens[end - 1] || t;
                findings.push({
                    kind: t.upper,
                    message,
                    start: t.start,
                    end: last.end,
                    snippet: snippet(sql, t.start, last.end),
                });
            }
            continue;
        }

        if (t.upper === 'DROP' || (t.upper === 'TRUNCATE' && isWord(next, 'TABLE'))) {
            const name = targetName(tokens, i + 1);
            if (name.startsWith('#')) continue; // temp tables are fine
            const { end } = scanStatement(tokens, i + 1, t.upper);
            const last = tokens[end - 1] || t;
            findings.push({
                kind: t.upper,
                message: t.upper === 'DROP' ? 'DROP — ลบ object ทิ้ง' : 'TRUNCATE — ล้างข้อมูลทั้งตาราง',
                start: t.start,
                end: last.end,
                snippet: snippet(sql, t.start, last.end),
            });
        }
    }
    return findings;
}

module.exports = { analyze, tokenize };
