/**
 * Launching jpipe-runner: which program, and with what arguments. No VS Code, so it is tested.
 *
 * The runner is a Python program, usually installed in the project's virtual environment beside
 * the packages its steps import (its README says so). Looking there first is what makes the Run
 * button work in a project set up the way the runner recommends, with nothing to configure.
 */
import * as path from 'node:path';
import { expandTilde } from '../compiler/compiler-invocation.js';

/** The library-selection setting: workspace paths of the checked step libraries. */
export const LIBRARIES_SETTING = 'runner.libraries';
/** An explicit runner program, overriding the search. */
export const RUNNER_COMMAND_SETTING = 'runner.command';

export const DEFAULT_RUNNER = 'jpipe-runner';

export interface RunnerContext {
    /** `jpipe.runner.command`, possibly empty. */
    configured: string;
    /** The workspace folder the model belongs to, as a file-system path. */
    folder: string | undefined;
    platform: NodeJS.Platform;
    home: string;
    exists: (file: string) => boolean;
}

/**
 * The runner program: the configured one; otherwise the one in the workspace's `.venv` or `venv`;
 * otherwise `jpipe-runner` from `PATH`.
 */
export function resolveRunner(context: RunnerContext): string {
    const configured = context.configured.trim();
    if (configured) return expandTilde(configured, context.home);
    if (context.folder) {
        const [bin, program] = context.platform === 'win32'
            ? ['Scripts', 'jpipe-runner.exe']
            : ['bin', 'jpipe-runner'];
        for (const venv of ['.venv', 'venv']) {
            const candidate = path.join(context.folder, venv, bin, program);
            if (context.exists(candidate)) return candidate;
        }
    }
    return DEFAULT_RUNNER;
}

/** `-l` once per library, then the compiled justification, as `jpipe-runner --help` documents. */
export function runnerArguments(libraries: readonly string[], justification: string): string[] {
    return [...libraries.flatMap(library => ['-l', library]), justification];
}

/** Why a model cannot be run, or `undefined` if it can. */
export function cannotRun(kind: 'justification' | 'template' | undefined, name: string): string | undefined {
    if (kind === 'template') {
        return `${name} is a template, which is abstract: run a justification that implements it.`;
    }
    return undefined;
}
