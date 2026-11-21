/**
 * Launching jpipe-runner: which program, and with what arguments. No VS Code, so it is tested.
 *
 * The runner is a Python program, installed in the workspace's own environment beside the
 * packages its steps import; `python-environment.ts` decides which that is. What is here is the
 * other mode, a program the user names, and what is common to both.
 */
import { expandTilde } from '../compiler/compiler-invocation.js';
import { RECOMMENDED, meetsMinimum, releaseNumbers } from '../requirements.js';

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
 * Whether the jpipe-runner release that will run streams its events with `--events PATH`: the
 * recommended release and later do (`RECOMMENDED.runner`, 4.1; jpipe-runner ADR-0030), its
 * development builds included (`4.1.0.dev0`).
 *
 * An unknown release is not asked, the reverse of `dataflowFlag`'s choice: a runner that does not
 * know the option stops before anything runs, while a run without its events is only shown when
 * it ends, as before (jpipe-vscode ADR-VSC-0033).
 */
export function streamsEvents(runnerRelease: string | undefined): boolean {
    const numbers = releaseNumbers(runnerRelease);
    return numbers !== undefined && meetsMinimum(numbers, RECOMMENDED.runner);
}

/** What jpipe-runner exits with when its command line is wrong, an unknown option among them. */
export const USAGE_EXIT = 2;
/**
 * What it exits with when a file could not be read or written: a diagram among them, which
 * includes a drawing that needs Graphviz when it is not installed.
 */
export const FILE_PROBLEM_EXIT = 4;

/**
 * What to launch a run again without, when it ended with `exitCode` and no report, having asked
 * for a drawing (`drew`) and for its events (`streamed`); `undefined` when launching it again
 * would end the same way. Nothing ran in either case, so launching again costs nothing.
 *
 * - **The events**, on a usage error: a development build of 4.1 from before `--events` reports
 *   the release that has it, and refuses the option.
 * - **The drawing**, when a file could not be written: most often, Graphviz is missing.
 */
export function relaunchWithout(exitCode: number | undefined, drew: boolean, streamed: boolean): 'events' | 'drawing' | undefined {
    if (streamed && exitCode === USAGE_EXIT) return 'events';
    if (drew && exitCode === FILE_PROBLEM_EXIT) return 'drawing';
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
