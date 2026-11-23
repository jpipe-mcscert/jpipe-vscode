/**
 * What each compiler's version means for this extension, kept by resolved command (jpipe-vscode
 * ADR-VSC-0032). vscode-free, so its rules are tested; `ImageGenerator` asks the compiler and
 * hands the answer here.
 *
 * One fact per compiler, what it printed for `--version` and the verdict drawn from it, where
 * there used to be three maps that had to agree (#119):
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
 *   real problem; a refusal it earned stays while it still cannot be asked. Not kept otherwise,
 *   since the failure may be passing, a cold JVM over the timeout, and keeping it would let an old
 *   compiler through for the rest of the session.
 */
import type { CompilerVerdict } from '../requirements.js';

interface Entry {
    /** What `--version` printed at the last ask; `null` when it could not be asked. */
    readonly output: string | null;
    readonly verdict: CompilerVerdict;
}

const REJECTED_JSON: CompilerVerdict = { kind: 'too-old', version: undefined };

export class CompilerVerdicts {
    private readonly entries = new Map<string, Entry>();

    /** The verdict to use without asking the compiler, or `undefined` when it must be asked. */
    cached(command: string): CompilerVerdict | undefined {
        const entry = this.entries.get(command);
        return entry && entry.output !== null && entry.verdict.kind !== 'too-old' ? entry.verdict : undefined;
    }

    /**
     * Record what the compiler printed for `--version`, `undefined` when it could not be asked,
     * and return what it means: a refusal held while the answer is unchanged, otherwise `judge`'s
     * verdict on the output.
     */
    answer(command: string, output: string | undefined, judge: (output: string) => CompilerVerdict): CompilerVerdict {
        const printed = output ?? null;
        const previous = this.entries.get(command);
        if (previous?.verdict.kind === 'too-old' && previous.output === printed) return previous.verdict;
        const verdict: CompilerVerdict = printed === null ? { kind: 'unknown' } : judge(printed);
        this.entries.set(command, { output: printed, verdict });
        return verdict;
    }

    /** The compiler rejected `diagnostic -f json`: refuse it while it answers as it last did. */
    rejectJson(command: string): void {
        this.entries.set(command, { output: this.entries.get(command)?.output ?? null, verdict: REJECTED_JSON });
    }

    /** Ask the compiler again at its next use, as Check jPipe Installation wants; a refusal stays. */
    forget(command: string): void {
        if (this.entries.get(command)?.verdict.kind !== 'too-old') this.entries.delete(command);
    }
}
