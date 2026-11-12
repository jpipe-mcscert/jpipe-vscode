/**
 * Creating a step library: every decision, none of the editor (jpipe-vscode ADR-VSC-0004).
 *
 * As with New Justification…, one question is asked — here the module name — and the rest is
 * worked out: the folder, the file name, and what the file starts with.
 */
import { chooseFolder, kebabCase } from '../models-view/new-model.js';

/** Python's reserved words: a module named after one cannot be imported by name. */
const PYTHON_KEYWORDS = new Set([
    'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
    'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in',
    'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield'
]);

/**
 * What is wrong with a module name, or `undefined`.
 *
 * The runner imports a library "as the module named after its file", so the name follows
 * Python's rules for one: an identifier, not a keyword. A trailing `.py` is accepted, since that
 * is what people type when they are thinking of the file.
 */
export function moduleNameError(input: string): string | undefined {
    const name = stripPy(input);
    if (name.length === 0) return 'Give the library a name.';
    if (!/^[A-Za-z_]\w*$/.test(name)) {
        return 'A Python module name may only contain letters, digits and underscores, and cannot start with a digit.';
    }
    if (PYTHON_KEYWORDS.has(name)) return `'${name}' is a Python keyword and cannot name a module.`;
    return undefined;
}

export const stripPy = (input: string): string => input.trim().replace(/\.py$/, '');

export const libraryFileName = (input: string): string => `${stripPy(input)}.py`;

/** The name offered to start with: after the model in question, `release_steps`, or just `steps`. */
export function defaultLibraryName(modelName: string | undefined): string {
    if (!modelName) return 'steps';
    const snake = kebabCase(modelName).replaceAll('-', '_');
    return /^[A-Za-z_]/.test(snake) ? `${snake}_steps` : 'steps';
}

/**
 * Where a new library goes: with the libraries there already are — in the folder holding most
 * of them — or, for the first one, beside the model in question; failing both, the first
 * workspace folder.
 */
export function libraryFolder(libraryUris: readonly string[], modelUri: string | undefined, workspaceFolders: readonly string[]): string | undefined {
    if (libraryUris.length > 0) return chooseFolder({ modelUris: libraryUris, workspaceFolders });
    return chooseFolder({ contextUri: modelUri, modelUris: [], workspaceFolders });
}

const AUTHORING_GUIDE = 'https://github.com/jpipe-mcscert/jpipe-runner/blob/main/docs/authoring.md';

/**
 * What a new library starts with: what it is for, where to learn to write one, and the imports a
 * step needs — which is also what makes the Libraries view list it before it has a step.
 */
export function librarySkeleton(modelName: string | undefined): string {
    const subject = modelName ? `the ${modelName} justification` : 'a justification';
    return [
        `"""Steps checking ${subject} with jpipe-runner.`,
        '',
        'Each step is a function decorated with the element it implements, named by its id',
        `(for instance "${modelName ?? 'release'}:e1"). Writing one: ${AUTHORING_GUIDE}`,
        '"""',
        '',
        'from pathlib import Path',
        '',
        'from jpipe_runner import Fail, Outcome, Pass, evidence, strategy',
        ''
    ].join('\n');
}
