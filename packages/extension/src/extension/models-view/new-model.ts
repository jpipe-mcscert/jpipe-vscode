/**
 * Creating a model: every decision, none of the editor.
 *
 * The Models view offers New Justification…, New Template…, and New Justification Implementing a
 * template. Asking one question — the name — and working the rest out is what keeps that from
 * being a chain of dialogs, and the working out is all here, where it can be tested
 * (jpipe-vscode ADR-VSC-0004): whether a name is usable, which file it goes to, which folder that
 * file goes in, the `load` an implementation needs, and the text that is written.
 *
 * URIs are handled as strings throughout. A `file:` URI's path is POSIX on every platform —
 * `file:///c%3A/models/a.jd` on Windows — so POSIX path arithmetic on it is correct everywhere,
 * where `fsPath` arithmetic would not be.
 */
import { posix } from 'node:path';

export type NewModelKind = 'justification' | 'template';

/**
 * Words the grammar reserves. A model named after one would not parse: the lexer reads it as the
 * keyword, never as a name. Kept in step with `jpipe.langium` by a test that reads the grammar.
 */
export const RESERVED_WORDS: readonly string[] = [
    'as', 'conclusion', 'evidence', 'implements', 'is', 'justification', 'load', 'strategy',
    'supports', 'template'
];

/** The grammar's `ID` terminal, anchored. */
const IDENTIFIER = /^\w+$/;

/** What is wrong with a model name, or `undefined` if nothing is. Blocks creation. */
export function nameError(name: string, namesInTargetFile: readonly string[] = []): string | undefined {
    if (name.length === 0) return 'Give the model a name.';
    if (!IDENTIFIER.test(name)) return 'A name may only contain letters, digits and underscores.';
    if (RESERVED_WORDS.includes(name)) return `'${name}' is a jPipe keyword and cannot name a model.`;
    if (namesInTargetFile.includes(name)) return `That file already declares a model named '${name}'.`;
    return undefined;
}

/**
 * Something worth knowing about a usable name, or `undefined`. Does not block: two models may
 * share a name in different files, but a file loading both could not tell them apart.
 */
export function nameWarning(name: string, namesElsewhere: readonly string[]): string | undefined {
    return namesElsewhere.includes(name)
        ? `Another file already has a model named '${name}'; a file loading both will be ambiguous.`
        : undefined;
}

/**
 * The model name in kebab case: `ReleaseSignoff` → `release-signoff`, `HTTPServer` →
 * `http-server`, `release_v2` → `release-v2`. Runs of capitals stay one word, so an acronym is
 * not spelled out a letter at a time.
 */
export function kebabCase(name: string): string {
    return name
        .replace(/([a-z\d])([A-Z])/g, '$1-$2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
        .replace(/_+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase();
}

export const fileNameFor = (name: string): string => `${kebabCase(name)}.jd`;

/** The URI of the directory containing `uri`. */
export function dirnameOf(uri: string): string {
    const slash = uri.lastIndexOf('/');
    return slash < 0 ? uri : uri.slice(0, slash);
}

export function joinUri(folder: string, file: string): string {
    return `${folder.replace(/\/+$/, '')}/${file}`;
}

/** What `chooseFolder` decides from. */
export interface FolderContext {
    /** The model the command was invoked on, if any — a template being implemented, a selected row. */
    contextUri?: string;
    /** The `.jd` file in the active editor, if any. */
    activeUri?: string;
    /** Every model file in the workspace. */
    modelUris: readonly string[];
    /** The workspace folders, in order. */
    workspaceFolders: readonly string[];
}

/**
 * Where a new model's file goes, without asking.
 *
 * Beside the model the command was invoked on — an implementation next to its template; failing
 * that, beside the file being edited; failing that, in the folder that already holds the most
 * models, which is where a project keeps them; and last, the first workspace folder. A tie for
 * "most models" goes to the shallower folder, then alphabetically, so the answer is stable.
 */
export function chooseFolder(context: FolderContext): string | undefined {
    if (context.contextUri) return dirnameOf(context.contextUri);
    if (context.activeUri) return dirnameOf(context.activeUri);
    const counts = new Map<string, number>();
    for (const uri of context.modelUris) {
        const folder = dirnameOf(uri);
        counts.set(folder, (counts.get(folder) ?? 0) + 1);
    }
    const ranked = [...counts].sort(([a, m], [b, n]) =>
        n - m || a.split('/').length - b.split('/').length || a.localeCompare(b));
    return ranked[0]?.[0] ?? context.workspaceFolders[0];
}

/** The path a `load` in `fromFile` writes to reach `toFile`: relative, `/`-separated. */
export function relativeLoadPath(fromFile: string, toFile: string): string {
    const from = decodeURIComponent(new URL(dirnameOf(fromFile)).pathname);
    const to = decodeURIComponent(new URL(toFile).pathname);
    return posix.relative(from, to);
}

/** The template a new justification implements. */
export interface ImplementedTemplate {
    name: string;
    uri: string;
}

/**
 * The text of a new model, as a snippet: tab stops on the labels, and on the ids, which are
 * mirrored into the relations so renaming one renames its uses.
 *
 * A justification is the smallest argument that builds — evidence supporting a strategy
 * supporting a conclusion — and a template the same with an `@support` in place of the evidence,
 * since a template must have one. Starting from something that builds is what keeps a model from
 * landing in the Errors group the moment it exists. Laid out as the formatter lays it out, so
 * format-on-save has nothing to say about it.
 *
 * An implementation is the other case: what it must contain is decided by its template, which the
 * language server knows and this module does not. It is written as an empty body, which the
 * server answers with one diagnostic per `@support` still to override, and the flow then applies
 * the server's own fix for those. No tab stops, since the text is not inserted as a snippet.
 */
export function modelSnippet(kind: NewModelKind, name: string, template?: ImplementedTemplate): string {
    if (template) return `justification ${name} implements ${template.name} {\n}\n`;
    const leaf = kind === 'template' ? '@support  ' : 'evidence  ';
    return [
        `${kind} ${name} {`,
        `    ${leaf} \${1:e} is "\${2:Evidence}"`,
        `    strategy   \${3:s} is "\${4:Strategy}"`,
        `    conclusion \${5:c} is "\${6:Conclusion}"`,
        `    \${1:e} supports \${3:s}`,
        `    \${3:s} supports \${5:c}`,
        `}`,
        ''
    ].join('\n');
}

/** A `load` line, as Organize Loads writes them. */
export const loadLine = (path: string): string => `load "${path}"`;

/**
 * Whether `text` already loads `targetUri` with a literal path. A glob that happens to match it is
 * not recognised; the cost of that miss is one redundant `load`, which resolves to a file already
 * loaded and changes nothing.
 */
export function loadsFile(text: string, fileUri: string, targetUri: string): boolean {
    const folder = dirnameOf(fileUri);
    for (const match of text.matchAll(/^\s*load\s+"([^"]*)"/gm)) {
        const path = match[1];
        if (/[*?[{]/.test(path)) continue;
        const resolved = path.startsWith('/') ? `file://${path}` : new URL(path, `${folder}/`).toString();
        if (sameUri(resolved, targetUri)) return true;
    }
    return false;
}

function sameUri(a: string, b: string): boolean {
    const norm = (u: string) => decodeURIComponent(new URL(u).pathname);
    return norm(a) === norm(b);
}

/**
 * Where to put a new `load` in an existing file: the line after its last `load`, or line 0 when it
 * has none, so loads stay together at the top.
 */
export function loadInsertionLine(text: string): number {
    const lines = text.split('\n');
    let last = -1;
    lines.forEach((line, i) => { if (/^\s*load\s/.test(line)) last = i; });
    return last + 1;
}

/**
 * What a model appended to an existing file is preceded by: enough newlines to leave exactly one
 * blank line after what is there, and none at all in an empty file.
 */
export function appendSeparator(text: string): string {
    if (text.trim().length === 0) return '';
    if (text.endsWith('\n\n')) return '';
    return text.endsWith('\n') ? '\n' : '\n\n';
}
