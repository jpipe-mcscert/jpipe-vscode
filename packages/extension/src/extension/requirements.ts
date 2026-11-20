/**
 * What this release of the extension needs from the programs it drives, in one place.
 *
 * Each entry is the **oldest** version this release works with; there is no newest
 * (jpipe-vscode ADR-VSC-0032). Raising one is a user-facing change, recorded in the changelog,
 * since it can stop a setup that worked yesterday. Everything here is a decision over facts
 * gathered elsewhere — a version printed by a program, an extension installed or not — so it is
 * tested (ADR-VSC-0004).
 */

/** A version as its release numbers: `[3, 0, 0]`, `[3, 11]`. */
export type ReleaseNumbers = readonly number[];

export const REQUIREMENTS = {
    /**
     * The jPipe compiler. 3.0.0 is the first whose `process -f PYTHON` writes step libraries for
     * jpipe-runner 4, which Scaffold Step Library relies on and the runner below requires. It also
     * has `diagnostic -f json` (2.4.0), which the preview's diagnostics read.
     */
    compiler: [3, 0, 0],
    /**
     * jpipe-runner: the first release whose API step libraries are written against,
     * `from jpipe_runner import evidence, strategy`, which is what New Library… writes and what
     * the Libraries view looks for. Earlier releases install and import, but have neither
     * decorator, so the editor flags every import of them and a run finds no step.
     */
    runner: [4, 0, 0],
    /** The Python jpipe-runner runs on, from its README. */
    python: [3, 11]
} as const satisfies Record<string, ReleaseNumbers>;

/** `[3, 0, 0]` → `3.0.0`. */
export const formatRelease = (numbers: ReleaseNumbers): string => numbers.join('.');

/**
 * Whether `version` is at least `minimum`, comparing release numbers only.
 *
 * A missing number counts as 0, so `[3, 11]` meets `[3, 11, 0]`. A prerelease tag takes no part:
 * a `3.0.0-SNAPSHOT` or `3.0.0-rc1` is a build *of* 3.0.0 and carries its features. Semver orders
 * it below 3.0.0, which is right when choosing the newer of two releases and wrong here, where
 * it would refuse every development build of the release that introduces what is needed.
 */
export function meetsMinimum(version: ReleaseNumbers, minimum: ReleaseNumbers): boolean {
    for (let i = 0; i < Math.max(version.length, minimum.length); i++) {
        const have = version[i] ?? 0;
        const need = minimum[i] ?? 0;
        if (have !== need) return have > need;
    }
    return true;
}

/* ------------------------------------------------------------------------------- compiler */

/** Where users of the `cli` and `jar` modes are sent to update the compiler themselves. */
export const COMPILER_INSTALL_GUIDE = 'https://www.jpipe.org/tutorials/install/';

/**
 * What a compiler's version means for this extension.
 *
 * `unknown` is a compiler that could not be asked, or printed nothing that reads as a version: it
 * is let through, since the run itself then either works or reports the real problem, and a build
 * that rejects an option it should have is caught there (`isUnknownOptionFailure`).
 */
export type CompilerVerdict =
    | { kind: 'supported'; version: string }
    | { kind: 'too-old'; version: string | undefined }
    | { kind: 'unknown' };

/** The verdict for a version as `parseCompilerVersion` reads it. */
export function compilerVerdict(
    version: { nums: ReleaseNumbers; pre: string | undefined } | undefined
): CompilerVerdict {
    if (!version) return { kind: 'unknown' };
    const shown = `${formatRelease(version.nums)}${version.pre ? `-${version.pre}` : ''}`;
    return meetsMinimum(version.nums, REQUIREMENTS.compiler)
        ? { kind: 'supported', version: shown }
        : { kind: 'too-old', version: shown };
}

/**
 * Why a compiler that is too old is not used, in one sentence. `version` is undefined for a
 * build that never said which it is and turned out not to know an option this extension needs.
 */
export function compilerTooOldMessage(version: string | undefined): string {
    const which = version ? `jPipe compiler ${version}` : 'This jPipe compiler';
    return `${which} is too old for this version of the extension, which needs ${formatRelease(REQUIREMENTS.compiler)} or newer.`;
}

/** Thrown in place of running a compiler that is too old, so a caller can tell it from a failed run. */
export class CompilerTooOldError extends Error {
    constructor(readonly version: string | undefined) {
        super(compilerTooOldMessage(version));
        this.name = 'CompilerTooOldError';
    }
}

/**
 * The way out of a compiler that is too old, by execution mode: the managed mode installs a newer
 * release itself, and the others are sent to the install guide, since the compiler is theirs.
 */
export function compilerUpdate(executionMode: string): { label: string; kind: 'install' | 'guide' } {
    return executionMode === 'managed'
        ? { label: 'Update the Compiler', kind: 'install' }
        : { label: 'How to Update', kind: 'guide' };
}

/* -------------------------------------------------------------------------------- Pylance */

/**
 * Pylance, Microsoft's Python language server. It is what checks a step library against
 * jpipe-runner as it is written, and what underlines an import the workspace's environment
 * cannot satisfy, which the environment fix answers. Wanted, not required: nothing about
 * running a model depends on it, and it exists only in Microsoft's own builds of VS Code, so
 * requiring it would stop the extension in every other editor.
 */
export const PYLANCE_EXTENSION = 'ms-python.vscode-pylance';

export const PYLANCE_OFFER =
    'Install Pylance so the editor checks your step libraries against jpipe-runner as you write them.';

/* ----------------------------------------------------------------- Check jPipe Installation */

/** What Check jPipe Installation found, each part from its own probe. */
export interface InstallationFacts {
    compiler: 'ready' | 'unreachable' | 'too-old';
    /**
     * Whether this workspace can run models. `external` is a runner command the user named,
     * whose environment is theirs; `none` is a workspace with no step library, which has no
     * reason to run anything yet.
     */
    runner: 'ready' | 'needs-setup' | 'external' | 'none';
    pylance: boolean;
}

/** What to do about the first problem in the report: the button the dialog offers. */
export type InstallationAction = 'compiler' | 'runner' | 'pylance';

/**
 * The headline and the one fix of the installation report.
 *
 * Problems are taken in the order a user meets them: no compiler means nothing works, a
 * workspace that cannot run means the ▶ button does not, and a missing Pylance only means less
 * help while writing steps. Only the compiler makes it an error, since it is the one thing every
 * feature beyond editing needs.
 */
export function installationSummary(facts: InstallationFacts): {
    severity: 'info' | 'warning' | 'error';
    title: string;
    action?: InstallationAction;
} {
    if (facts.compiler === 'unreachable') return { severity: 'error', title: 'Cannot access the jPipe compiler.' };
    if (facts.compiler === 'too-old') {
        return { severity: 'error', title: 'The jPipe compiler is too old for this extension.', action: 'compiler' };
    }
    if (facts.runner === 'needs-setup') {
        return { severity: 'warning', title: 'The jPipe compiler is ready, but this workspace cannot run models yet.', action: 'runner' };
    }
    const runs = facts.runner === 'none' ? '' : ' and can run models';
    if (!facts.pylance && facts.runner !== 'none') {
        return { severity: 'info', title: `jPipe is ready${runs}. Pylance would check your step libraries as you write them.`, action: 'pylance' };
    }
    return { severity: 'info', title: `jPipe is ready${runs}.` };
}

/** The report's line about the compiler's version. */
export function compilerLine(verdict: CompilerVerdict): string {
    const needed = `needs ${formatRelease(REQUIREMENTS.compiler)} or newer`;
    switch (verdict.kind) {
        case 'supported': return `Compiler: ${verdict.version}`;
        case 'too-old': return `Compiler: ${verdict.version ?? 'an older release'}, too old (${needed})`;
        case 'unknown': return `Compiler: version not reported (${needed})`;
    }
}

/**
 * The report's line about Pylance. The editor cannot tell a disabled extension from a missing
 * one, so neither does the line.
 */
export const pylanceLine = (installed: boolean): string =>
    installed ? 'Pylance: installed' : 'Pylance: not installed, or disabled';
