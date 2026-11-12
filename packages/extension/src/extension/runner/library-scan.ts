/**
 * Finding jpipe-runner steps in a Python file by reading it, never by running it.
 *
 * A step library is imported to be run, and importing a module runs its top-level code. Listing
 * the libraries of a workspace must not do that — it happens on every keystroke, to every Python
 * file — so this reads the text: a small tokenizer that knows where strings and comments are,
 * then a scan for the decorators jpipe-runner exports (jpipe-vscode ADR-VSC-0025).
 *
 * What counts as a step is what jpipe-runner's authoring guide shows: `@evidence`, `@strategy`,
 * `@sub_conclusion` or `@conclusion` with parentheses, imported by name from `jpipe_runner`
 * (aliases included), or reached through `import jpipe_runner [as x]`. A decorator re-exported
 * through another module of the project is not seen; the runner would see it, so the cost of that
 * miss is a library this view does not list, never one it lists wrongly.
 */

export const STEP_KINDS = ['evidence', 'strategy', 'sub_conclusion', 'conclusion'] as const;
export type StepKind = typeof STEP_KINDS[number];

const RUNNER_MODULE = 'jpipe_runner';

/** A step the file declares. */
export interface Step {
    kind: StepKind;
    /** The element ids given as string literals; an id computed at run time cannot be read. */
    ids: string[];
    /** The decorated function, if the decorator is followed by one. */
    functionName?: string;
    /** Zero-based line of the decorator. */
    line: number;
}

type Token =
    | { type: 'name'; value: string; line: number }
    | { type: 'string'; value: string; formatted: boolean; line: number }
    | { type: 'op'; value: string; line: number }
    | { type: 'newline'; line: number };

const OPENERS = new Set(['(', '[', '{']);
const CLOSERS = new Set([')', ']', '}']);
const TWO_CHAR_OPS = new Set(['==', '!=', '<=', '>=', ':=', '->', '**', '//', '<<', '>>']);
const STRING_PREFIX = /^[rRbBuUfF]{1,2}$/;
const NAME_START = /[\p{L}_]/u;
const NAME_PART = /[\p{L}\p{N}_]/u;

/**
 * Python, reduced to what the scan needs: names, string literals with their contents, operators,
 * and the ends of logical lines. Comments vanish, and so does a newline inside brackets, which is
 * how a decorator spread over several lines stays one statement.
 */
export function tokenize(text: string): Token[] {
    const tokens: Token[] = [];
    let line = 0;
    let depth = 0;
    let i = 0;
    const newline = () => {
        if (depth === 0 && tokens.length > 0 && tokens[tokens.length - 1].type !== 'newline') {
            tokens.push({ type: 'newline', line });
        }
    };
    while (i < text.length) {
        const c = text[i];
        if (c === '\n') { newline(); line++; i++; continue; }
        if (c === ' ' || c === '\t' || c === '\r' || c === '\f') { i++; continue; }
        if (c === '\\' && text[i + 1] === '\n') { line++; i += 2; continue; }
        if (c === '\\' && text[i + 1] === '\r' && text[i + 2] === '\n') { line++; i += 3; continue; }
        if (c === '#') {
            while (i < text.length && text[i] !== '\n') i++;
            continue;
        }
        if (NAME_START.test(c)) {
            let j = i + 1;
            while (j < text.length && NAME_PART.test(text[j])) j++;
            const word = text.slice(i, j);
            if ((text[j] === '"' || text[j] === "'") && STRING_PREFIX.test(word)) {
                const read = readString(text, j, /[fF]/.test(word), line);
                tokens.push(read.token);
                line = read.line;
                i = read.end;
                continue;
            }
            tokens.push({ type: 'name', value: word, line });
            i = j;
            continue;
        }
        if (c === '"' || c === "'") {
            const read = readString(text, i, false, line);
            tokens.push(read.token);
            line = read.line;
            i = read.end;
            continue;
        }
        if (/\d/.test(c)) {
            let j = i + 1;
            while (j < text.length && /[\w.]/.test(text[j])) j++;
            tokens.push({ type: 'op', value: 'number', line });
            i = j;
            continue;
        }
        const pair = text.slice(i, i + 2);
        if (TWO_CHAR_OPS.has(pair)) {
            tokens.push({ type: 'op', value: pair, line });
            i += 2;
            continue;
        }
        if (OPENERS.has(c)) depth++;
        if (CLOSERS.has(c)) depth = Math.max(0, depth - 1);
        tokens.push({ type: 'op', value: c, line });
        i++;
    }
    newline();
    return tokens;
}

/** A string literal starting at its opening quote. Its value is its contents, escapes left as written. */
function readString(text: string, start: number, formatted: boolean, startLine: number) {
    const quote = text[start];
    const triple = text.slice(start, start + 3) === quote.repeat(3);
    const delimiter = triple ? quote.repeat(3) : quote;
    let line = startLine;
    let i = start + delimiter.length;
    const contentStart = i;
    while (i < text.length) {
        if (text[i] === '\\') {
            // Even in a raw string a backslash keeps the next quote from closing it.
            if (text[i + 1] === '\n') line++;
            i += 2;
            continue;
        }
        if (text.startsWith(delimiter, i)) {
            const value = text.slice(contentStart, i);
            return { token: { type: 'string' as const, value, formatted, line: startLine }, line, end: i + delimiter.length };
        }
        if (text[i] === '\n') {
            line++;
            // An unterminated single-quoted string ends at the line, as Python's tokenizer would
            // complain there; carrying on would swallow the rest of the file.
            if (!triple) break;
        }
        i++;
    }
    return { token: { type: 'string' as const, value: text.slice(contentStart, i), formatted, line: startLine }, line, end: i };
}

/** The names a file binds to jpipe-runner: decorator names to their kind, and module aliases. */
interface Imports {
    decorators: Map<string, StepKind>;
    modules: Set<string>;
}

const isStepKind = (name: string): name is StepKind => (STEP_KINDS as readonly string[]).includes(name);

/** Split the token stream into logical lines. */
function statements(tokens: readonly Token[]): Token[][] {
    const result: Token[][] = [];
    let current: Token[] = [];
    for (const token of tokens) {
        if (token.type === 'newline') {
            if (current.length > 0) result.push(current);
            current = [];
        } else {
            current.push(token);
        }
    }
    if (current.length > 0) result.push(current);
    return result;
}

const isName = (t: Token | undefined, value?: string): t is Extract<Token, { type: 'name' }> =>
    t?.type === 'name' && (value === undefined || t.value === value);
const isOp = (t: Token | undefined, value: string) => t?.type === 'op' && t.value === value;

function readImports(lines: readonly Token[][]): Imports {
    const imports: Imports = { decorators: new Map(), modules: new Set() };
    for (const tokens of lines) {
        // from jpipe_runner import a, b as c   /   from jpipe_runner import (a, b)   /   import *
        if (isName(tokens[0], 'from') && isName(tokens[1], RUNNER_MODULE) && isName(tokens[2], 'import')) {
            const names = tokens.slice(3).filter(t => !isOp(t, '(') && !isOp(t, ')'));
            if (isOp(names[0], '*')) {
                for (const kind of STEP_KINDS) imports.decorators.set(kind, kind);
                continue;
            }
            for (let i = 0; i < names.length; i++) {
                const imported = names[i];
                if (!isName(imported)) continue;
                let local = imported.value;
                if (isName(names[i + 1], 'as') && isName(names[i + 2])) {
                    local = (names[i + 2] as Extract<Token, { type: 'name' }>).value;
                    i += 2;
                }
                if (isStepKind(imported.value)) imports.decorators.set(local, imported.value);
            }
        }
        // import jpipe_runner   /   import os, jpipe_runner as jr   /   import jpipe_runner.x
        if (isName(tokens[0], 'import')) {
            for (let i = 1; i < tokens.length; i++) {
                if (!isName(tokens[i], RUNNER_MODULE) || (i > 1 && !isOp(tokens[i - 1], ','))) continue;
                // `import jpipe_runner.x` binds `jpipe_runner` too; `import jpipe_runner.x as y`
                // binds `y` to the submodule, which has no step decorators.
                let end = i + 1;
                while (isOp(tokens[end], '.') && isName(tokens[end + 1])) end += 2;
                const dotted = end > i + 1;
                if (isName(tokens[end], 'as') && isName(tokens[end + 1])) {
                    if (!dotted) imports.modules.add((tokens[end + 1] as Extract<Token, { type: 'name' }>).value);
                } else {
                    imports.modules.add(RUNNER_MODULE);
                }
            }
        }
    }
    return imports;
}

/** The kind a decorator line names, if it is a step decorator, and where its `(` is. */
function decoratorKind(tokens: readonly Token[], imports: Imports): { kind: StepKind; open: number } | undefined {
    const first = tokens[1];
    if (!isName(first)) return undefined;
    // @evidence(…) or an alias of it
    if (isOp(tokens[2], '(')) {
        const kind = imports.decorators.get(first.value);
        return kind ? { kind, open: 2 } : undefined;
    }
    // @jpipe_runner.evidence(…) or @jr.evidence(…)
    const member = tokens[3];
    if (imports.modules.has(first.value) && isOp(tokens[2], '.') && isName(member) && isOp(tokens[4], '(')) {
        return isStepKind(member.value) ? { kind: member.value, open: 4 } : undefined;
    }
    return undefined;
}

/**
 * The positional string-literal arguments of a call whose `(` is at `open`: the element ids.
 *
 * Reading stops at the first keyword argument or unpacking, which is where jpipe-runner's
 * decorators stop taking ids. An argument that is not a plain literal — a name, an f-string, an
 * expression — is skipped: its value only exists when the code runs.
 */
function literalArguments(tokens: readonly Token[], open: number): string[] {
    const ids: string[] = [];
    let depth = 0;
    let argument: Token[] = [];
    const flush = () => {
        const strings = argument.filter((t): t is Extract<Token, { type: 'string' }> => t.type === 'string');
        // Adjacent literals are one string to Python: "release:" "e1".
        if (argument.length > 0 && strings.length === argument.length && strings.every(s => !s.formatted)) {
            ids.push(strings.map(s => s.value).join(''));
        }
        argument = [];
    };
    for (let i = open + 1; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.type === 'op' && OPENERS.has(token.value)) depth++;
        if (token.type === 'op' && CLOSERS.has(token.value)) {
            if (depth === 0) { flush(); break; }
            depth--;
        }
        if (depth === 0) {
            if (isOp(token, ',')) { flush(); continue; }
            if (isName(token) && isOp(tokens[i + 1], '=') && argument.length === 0) break;
            if ((isOp(token, '*') || isOp(token, '**')) && argument.length === 0) break;
        }
        argument.push(token);
    }
    return ids;
}

/** Every step `text` declares, in the order written. */
export function scanLibrary(text: string): Step[] {
    return scanFile(text).steps;
}

/**
 * Whether `text` is a step library, and its steps.
 *
 * A file is one when it applies a step decorator, or imports one by name from `jpipe_runner`:
 * a library just started, with its imports written and no step yet, is a library being written,
 * and dropping it from the list until its first step would make it vanish the moment it is
 * created. A file importing only `Pass` and `Fail`, or the module without applying a decorator
 * from it, is a helper, and is not one.
 */
export function scanFile(text: string): { isLibrary: boolean; steps: Step[] } {
    // Nearly every Python file is not a step library; most never mention the module at all.
    if (!text.includes(RUNNER_MODULE)) return { isLibrary: false, steps: [] };
    const lines = statements(tokenize(text));
    const imports = readImports(lines);
    if (imports.decorators.size === 0 && imports.modules.size === 0) return { isLibrary: false, steps: [] };
    const steps = stepsIn(lines, imports);
    return { isLibrary: steps.length > 0 || imports.decorators.size > 0, steps };
}

function stepsIn(lines: readonly Token[][], imports: Imports): Step[] {
    const steps: Step[] = [];
    let pending: Step[] = [];
    for (const tokens of lines) {
        if (isOp(tokens[0], '@')) {
            const found = decoratorKind(tokens, imports);
            if (found) {
                pending.push({ kind: found.kind, ids: literalArguments(tokens, found.open), line: tokens[0].line });
            }
            continue;
        }
        const def = isName(tokens[0], 'async') ? 1 : 0;
        if (isName(tokens[def], 'def') && isName(tokens[def + 1])) {
            const name = (tokens[def + 1] as Extract<Token, { type: 'name' }>).value;
            steps.push(...pending.map(step => ({ ...step, functionName: name })));
        } else {
            steps.push(...pending);
        }
        pending = [];
    }
    steps.push(...pending);
    return steps;
}
