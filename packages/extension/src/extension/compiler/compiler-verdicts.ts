/**
 * What each compiler's version means for this extension, kept by resolved command (jpipe-vscode
 * ADR-VSC-0032). vscode-free, so its rules are tested; `ImageGenerator` asks the compiler and
 * hands the answer here.
 *
 * One record per compiler, what it last printed for `--version` and what that means, where there
 * used to be three maps that had to agree (#119):
 *
 * - **A usable verdict is kept.** The version is a property of the build, and asking it before
 *   every save would be a second process for a fact that cannot change. Keyed by the resolved
 *   command, so pointing `cliPath` or `jarFile` at a different build asks again.
 * - **A refusal is asked again at every use**, because the next thing its user does is update the
 *   compiler, often in place under the same command, and a cached refusal would outlive the
 *   update until the window is reloaded. It holds while the compiler answers as it did, and is
 *   judged afresh once the answer changes.
 * - **A compiler that rejected `diagnostic -f json` is refused** whatever its version said: it is
 *   older than the version it claims. That is the same refusal, held against what it printed.
 * - **A compiler that cannot be asked is let through** (`unknown`), and the run itself reports the
 *   real problem; a refusal it earned stays while it cannot be asked. Not kept otherwise,
 *   since the failure may be passing, a cold JVM over the timeout, and keeping it would let an old
 *   compiler through for the rest of the session.
 */
import type { CompilerVerdict } from '../requirements.js';

/** All that is known of one compiler. */
interface Entry {
    /** What `--version` last printed, kept across an ask that failed and across `forget`. */
    lastOutput?: string;
    /** The verdict to use without asking, when one is usable. */
    usable?: CompilerVerdict;
    /**
     * Set once the compiler rejected `diagnostic -f json`: what it had printed then, `null` if it
     * never could be asked. It is refused while it answers the same.
     */
    refusedWhile?: string | null;
}

const REJECTED_JSON: CompilerVerdict = { kind: 'too-old', version: undefined };

export class CompilerVerdicts {
    private readonly entries = new Map<string, Entry>();

    /** The verdict to use without asking the compiler, or `undefined` when it must be asked. */
    cached(command: string): CompilerVerdict | undefined {
        const entry = this.entries.get(command);
        return entry?.refusedWhile === undefined ? entry?.usable : undefined;
    }

    /**
     * Record what the compiler printed for `--version`, `undefined` when it could not be asked,
     * and return what it means: a refusal held while the answer is unchanged, otherwise `judge`'s
     * verdict on the output, kept when it is usable.
     */
    answer(command: string, output: string | undefined, judge: (output: string) => CompilerVerdict): CompilerVerdict {
        const entry = this.entryOf(command);
        if (output !== undefined) entry.lastOutput = output;
        if (entry.refusedWhile !== undefined) {
            // Held while it answers the same, and while it cannot be asked at all: one failed
            // ask, a cold JVM over the timeout, says nothing about whether it was updated.
            if (output === undefined || output === entry.refusedWhile) return REJECTED_JSON;
            entry.refusedWhile = undefined;
        }
        if (output === undefined) return { kind: 'unknown' };
        const verdict = judge(output);
        entry.usable = verdict.kind === 'too-old' ? undefined : verdict;
        return verdict;
    }

    /** The compiler rejected `diagnostic -f json`: refuse it while it answers as it last did. */
    rejectJson(command: string): void {
        const entry = this.entryOf(command);
        entry.refusedWhile = entry.lastOutput ?? null;
        entry.usable = undefined;
    }

    /** Ask the compiler again at its next use, as Check jPipe Installation wants; a refusal stays. */
    forget(command: string): void {
        const entry = this.entries.get(command);
        if (entry) entry.usable = undefined;
    }

    private entryOf(command: string): Entry {
        let entry = this.entries.get(command);
        if (!entry) {
            entry = {};
            this.entries.set(command, entry);
        }
        return entry;
    }
}
