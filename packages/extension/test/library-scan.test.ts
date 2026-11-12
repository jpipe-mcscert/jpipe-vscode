import { describe, expect, test } from 'vitest';
import { scanFile, scanLibrary } from '../src/extension/runner/library-scan.js';

/**
 * Recognising a jpipe-runner step library from its text.
 *
 * Two failures matter: a library left out of the Libraries view, so it can never be selected for
 * a run, and a file listed that is not one — which a run would load for nothing. Both come from
 * the same place: a tokenizer that loses track of what is code and what is a string or comment.
 */

const steps = (text: string) => scanLibrary(text).map(s => [s.kind, s.ids, s.functionName]);

describe('a step library', () => {

    test('as the README writes one', () => {
        expect(steps(`
from pathlib import Path

from jpipe_runner import Fail, Outcome, Pass, evidence, strategy


@evidence("release:e1", observes={"report": "mock/junit.xml"}, produces=["tests_pass"])
def the_test_suite_passes(report: Path) -> Outcome:
    """[evidence] The test suite passes"""
    return Pass(tests_pass=True)


@strategy("release:s", consumes=["tests_pass"])
def all_release_gates_pass(tests_pass: bool) -> Outcome:
    return Pass()
`)).toEqual([
            ['evidence', ['release:e1'], 'the_test_suite_passes'],
            ['strategy', ['release:s'], 'all_release_gates_pass']
        ]);
    });

    test('with a decorator spread over several lines, and several ids', () => {
        expect(steps(`
from jpipe_runner import evidence

@evidence(
    "rigor:r17:e_metric",
    'rigor:r18:e',  # an alias from composition
    observes={"metrics": "reports/metrics.csv"},
    produces=["metrics_reported"],
)
def report_metrics(metrics):
    pass
`)).toEqual([['evidence', ['rigor:r17:e_metric', 'rigor:r18:e'], 'report_metrics']]);
    });

    test('with every kind, imported in parentheses', () => {
        expect(steps(`
from jpipe_runner import (
    conclusion,
    evidence,
    strategy,
    sub_conclusion,
)

@sub_conclusion("j:sc")
def a(): ...
@conclusion("j:c")
def b(): ...
`).map(s => s[0])).toEqual(['sub_conclusion', 'conclusion']);
    });

    test('with the decorators renamed on import', () => {
        expect(steps(`
from jpipe_runner import evidence as ev, strategy as st
@ev("j:e")
def e(): ...
@st("j:s")
def s(): ...
`).map(s => s[0])).toEqual(['evidence', 'strategy']);
    });

    test('through the module, with or without an alias', () => {
        expect(steps(`
import os, jpipe_runner
import jpipe_runner as jr

@jpipe_runner.evidence("j:e1")
def one(): ...

@jr.strategy("j:s")
async def two(): ...
`)).toEqual([['evidence', ['j:e1'], 'one'], ['strategy', ['j:s'], 'two']]);
    });

    test('through a submodule import, which binds the package name too', () => {
        expect(steps('import jpipe_runner.outcomes\n@jpipe_runner.evidence("j:e")\ndef e(): ...\n'))
            .toEqual([['evidence', ['j:e'], 'e']]);
    });

    test('with a star import', () => {
        expect(steps('from jpipe_runner import *\n@evidence("j:e")\ndef e(): ...\n')).toHaveLength(1);
    });

    test('with other decorators stacked around the step', () => {
        expect(steps(`
import functools
from jpipe_runner import evidence

@functools.lru_cache
@evidence("j:e")
@other_decorator(1, 2)
def e(): ...
`)).toEqual([['evidence', ['j:e'], 'e']]);
    });

    test('keeps ids that are adjacent literals, and skips ones computed at run time', () => {
        expect(steps(`
from jpipe_runner import evidence
MODEL = "j"
@evidence("j:" "e1", MODEL + ":e2", f"{MODEL}:e3", ID)
def e(): ...
`)).toEqual([['evidence', ['j:e1'], 'e']]);
    });

    test('a string literal with a backslash-escaped quote does not end early', () => {
        expect(steps(`from jpipe_runner import evidence
x = "a \\" @evidence('nope')"
@evidence("j:e")
def e(): ...
`)).toEqual([['evidence', ['j:e'], 'e']]);
    });

    test('on Windows line endings, and after a line continuation', () => {
        expect(steps('from jpipe_runner \\\r\n    import evidence\r\n@evidence("j:e")\r\ndef e(): ...\r\n'))
            .toEqual([['evidence', ['j:e'], 'e']]);
    });
});

describe('not a step library', () => {

    test('a file that never mentions jpipe_runner', () => {
        expect(scanLibrary('@evidence("j:e")\ndef e(): ...\n')).toEqual([]);
    });

    test('a file that imports the runner but declares no step', () => {
        expect(scanLibrary('from jpipe_runner import Pass, Fail\n\ndef helper():\n    return Pass()\n')).toEqual([]);
    });

    test('decorators that only appear in comments and strings', () => {
        expect(scanLibrary(`
from jpipe_runner import evidence
# @evidence("j:commented")
"""
Usage:
    @evidence("j:in_a_docstring")
    def f(): ...
"""
EXAMPLE = '@evidence("j:in_a_string")'
`)).toEqual([]);
    });

    test('a step decorator used without parentheses, which the runner rejects', () => {
        expect(scanLibrary('from jpipe_runner import evidence\n@evidence\ndef e(): ...\n')).toEqual([]);
    });

    test('a same-named decorator imported from somewhere else', () => {
        expect(scanLibrary('import jpipe_runner\nfrom mylib import evidence\n@evidence("j:e")\ndef e(): ...\n')).toEqual([]);
    });

    test('a submodule imported under its own name, which has no step decorators', () => {
        expect(scanLibrary('import jpipe_runner.outcomes as o\n@o.evidence("j:e")\ndef e(): ...\n')).toEqual([]);
    });

    test('an unterminated string does not swallow the rest of the file', () => {
        expect(steps('from jpipe_runner import evidence\nx = "oops\n@evidence("j:e")\ndef e(): ...\n'))
            .toEqual([['evidence', ['j:e'], 'e']]);
    });
});

describe('a library being written', () => {

    test('importing a step decorator is enough, before its first step', () => {
        expect(scanFile('from jpipe_runner import Fail, Outcome, Pass, evidence, strategy\n'))
            .toEqual({ isLibrary: true, steps: [] });
    });

    test('importing only outcomes is a helper, not a library', () => {
        expect(scanFile('from jpipe_runner import Pass, Fail\n').isLibrary).toBe(false);
    });

    test('importing the module without applying a decorator is a helper too', () => {
        expect(scanFile('import jpipe_runner\nprint(jpipe_runner.__version__)\n').isLibrary).toBe(false);
    });

    test('a decorator mentioned only in a comment does not make a library', () => {
        expect(scanFile('# from jpipe_runner import evidence\n').isLibrary).toBe(false);
    });
});
