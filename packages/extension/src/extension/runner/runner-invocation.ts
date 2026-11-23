/**
 * Launching jpipe-runner: which program, and with what arguments. No VS Code, so it is tested.
 *
 * The runner is a Python program, installed in the workspace's own environment beside the
 * packages its steps import; `python-environment.ts` decides which that is. What is here is the
 * other mode, a program the user names, and what is common to both.
 */
import { expandTilde } from '../compiler/compiler-invocation.js';
import { runnerHas } from '../requirements.js';

/**
 * The task type runs and environment fixes are launched as, contributed in `package.json`'s
 * `taskDefinitions`.
 */
export const RUN_TASK_TYPE = 'jpipe';

/** The library-selection setting: workspace paths of the checked step libraries. */
export const LIBRARIES_SETTING = 'runner.libraries';
/** Where models are run: the workspace's own environment, or a program the user names. */
export const ENVIRONMENT_SETTING = 'runner.environment';
export type EnvironmentMode = 'workspace' | 'command';
/** The runner program, in `command` mode. */
export const RUNNER_COMMAND_SETTING = 'runner.command';
/** Whether the editor is pointed at the workspace's environment. */
export const SELECT_IN_EDITOR_SETTING = 'runner.selectInEditor';
/** A local jpipe-runner checkout to run instead of a published release, for work on the runner. */
export const LOCAL_SOURCE_SETTING = 'runner.localSource';
/** Whether setting the environment up is offered unasked. */
export const OFFER_SETUP_SETTING = 'runner.offerSetup';
/** How many steps a run may run at a time: `auto`, or a number. */
export const JOBS_SETTING = 'runner.jobs';

export const DEFAULT_RUNNER = 'jpipe-runner';

/** The runner program in `command` mode: the one named, with `~` expanded, else `jpipe-runner` from `PATH`. */
export function resolveRunner(configured: string, home: string): string {
    return configured.trim() ? expandTilde(configured.trim(), home) : DEFAULT_RUNNER;
}

/** The option that asks jpipe-runner to draw the run's dataflow. */
export type DataflowFlag = '--dataflow' | '--diagram';

/**
 * Which option draws the dataflow, for the jpipe-runner release that will run (`4.0.0`,
 * `4.1.0.dev0`, `5.0.0rc1`).
 *
 * 4.0 drew two diagrams: `--diagram` the argument alone, `--dataflow` the argument with the files
 * and values its steps declare. The releases after it draw one, the dataflow, with `--diagram`,
 * and refuse `--dataflow` as an unknown option, so nothing runs (jpipe-runner ADR-0029). So 4.0.x
 * is asked for `--dataflow`, and everything else for `--diagram`, an unknown release included —
 * a runner named in the settings that does not answer `--version`, or a source checkout with no
 * version. On a 4.0 runner that draws the argument without its files and values; `--dataflow` on
 * a later one would stop every run (jpipe-vscode ADR-VSC-0031).
 */
export function dataflowFlag(runnerRelease: string | undefined): DataflowFlag {
    const [major, minor] = (runnerRelease ?? '').split('.').map(part => Number.parseInt(part, 10));
    return major === 4 && minor === 0 ? '--dataflow' : '--diagram';
}

/**
 * Whether the jpipe-runner release that will run streams its events with `--events PATH`: 4.1 and
 * later do (jpipe-runner ADR-0030), their development builds included (`4.1.0.dev0`).
 *
 * An unknown release is not asked, the reverse of `dataflowFlag`'s choice: a runner that does not
 * know the option stops before anything runs, while a run without its events is only shown when
 * it ends, as before (jpipe-vscode ADR-VSC-0033).
 */
export function streamsEvents(runnerRelease: string | undefined): boolean {
    return runnerHas(runnerRelease, 'events');
}

/** How many steps a run may run at a time, as the setting says: one per CPU, or a number. */
export type Jobs = 'auto' | number;

/**
 * The jobs setting, read: `auto`, or a whole number of at least 1, written as a number or as
 * text (`4` or `"4"`). Anything else is `invalid`, and runs as `auto`, the default.
 */
export function readJobs(value: unknown): { jobs: Jobs; invalid: boolean } {
    if (value === undefined || value === null || value === 'auto') return { jobs: 'auto', invalid: false };
    // As the setting's pattern in package.json has it, so that what the Settings editor accepts is what runs.
    const text = typeof value === 'number' || typeof value === 'string' ? String(value) : '';
    return /^[1-9]\d*$/.test(text) ? { jobs: Number.parseInt(text, 10), invalid: false } : { jobs: 'auto', invalid: true };
}

/**
 * Whether the jpipe-runner release that will run takes `--jobs`: 4.4 and later do (jpipe-runner
 * ADR-0038), their development builds included. An older one, or one whose release is unknown,
 * refuses the option and runs nothing, so it is run as before, one step at a time. A check calls
 * no step, so it is not asked either.
 */
export function runsJobs(runnerRelease: string | undefined, check = false): boolean {
    return !check && runnerHas(runnerRelease, 'jobs');
}

/**
 * The `--jobs` option for `jobs`, and the number it was lowered from when the setting asked for
 * more steps at a time than there are CPUs (`cores`, those this editor may use): `--jobs N` runs
 * up to N steps at once, each on a thread of its own, and more threads than CPUs only make them
 * wait for one another. `auto` is the runner's own count, one per CPU it may use.
 */
export function jobsArguments(jobs: Jobs, cores: number): { args: string[]; loweredFrom?: number } {
    if (jobs === 'auto') return { args: ['--jobs', 'auto'] };
    const cap = Math.max(1, Math.floor(cores));
    return jobs > cap ? { args: ['--jobs', String(cap)], loweredFrom: jobs } : { args: ['--jobs', String(jobs)] };
}

/** What jpipe-runner exits with when its command line is wrong, an unknown option among them. */
export const USAGE_EXIT = 2;
/**
 * What it exits with when a file could not be read or written: a diagram among them, which
 * includes a drawing that needs Graphviz when it is not installed.
 */
export const FILE_PROBLEM_EXIT = 4;

/** What a launch asked the runner for besides its report, each of which it may refuse. */
export interface AskedOptions {
    /** A drawing of the run: `--diagram`, or `--dataflow` on 4.0. */
    drew: boolean;
    /** Its events: `--events`. */
    streamed: boolean;
    /** Several steps at a time: `--jobs`. */
    jobs: boolean;
}

/**
 * What to launch a run again without, when it ended with `exitCode` and no report, having asked
 * for `asked`; `undefined` when launching it again would end the same way. Nothing ran in either
 * case, so launching again costs nothing.
 *
 * - **The jobs**, on a usage error: a development build of 4.4 from before `--jobs` reports the
 *   release that has it, and refuses the option. Only such a build is asked for it, and it knows
 *   `--events`, so the jobs are what it refused.
 * - **The events**, on a usage error: a development build of 4.1 from before `--events` reports
 *   the release that has it, and refuses the option.
 * - **The drawing**, when a file could not be written: most often, Graphviz is missing.
 */
export function relaunchWithout(exitCode: number | undefined, asked: AskedOptions): 'jobs' | 'events' | 'drawing' | undefined {
    if (exitCode === USAGE_EXIT) {
        if (asked.jobs) return 'jobs';
        if (asked.streamed) return 'events';
    }
    if (asked.drew && exitCode === FILE_PROBLEM_EXIT) return 'drawing';
    return undefined;
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
