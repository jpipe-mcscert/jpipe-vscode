/**
 * What a syntax error says, and where it points.
 *
 * The parser's own account of an unfinished declaration is misleading twice over. Writing
 *
 * ```
 * evidence
 * conclusion c is "A claim"
 * ```
 *
 * it reads `conclusion` as the name of the evidence — `evidence conclusion is "…"` is a perfectly
 * good declaration — and only fails one token later, at `c`. So the report blames the *next*
 * line, and says `Expecting token of type 'is' but found 'c'`, which describes the parser's
 * predicament rather than the author's mistake.
 *
 * Neither can be fixed by parsing differently; the input really is ambiguous until it fails. What
 * can be fixed is the account given of it: name the construct being written, say what it still
 * needs, and put the marker at the end of the last thing that was right — which is where the
 * missing token belongs, and the convention every other language server follows.
 */
import { LangiumParserErrorMessageProvider } from 'langium';
import type { IToken, TokenType } from 'chevrotain';

/** How each element declaration reads once finished, keyed by its grammar rule. */
const DECLARATION_SHAPES: Readonly<Record<string, string>> = {
    Evidence:        'evidence <name> is "<label>"',
    Strategy:        'strategy <name> is "<label>"',
    SubConclusion:   'sub-conclusion <name> is "<label>"',
    Conclusion:      'conclusion <name> is "<label>"',
    AbstractSupport: '@support <name> is "<label>"',
    Load:            'load "<path>"',
    Relation:        '<supporter> supports <supported>',
    KeyValDecl:      '<key>: "<value>"'
};

/**
 * The keyword each declaration opens with, so the construct can be named from what precedes the
 * error rather than from the rule that failed.
 *
 * The distinction matters: a declaration missing its *name* fails inside `QualifiedId`, which is
 * shared by all five element kinds and says nothing about which one is being written. The word
 * before the error does.
 */
const OPENING_KEYWORDS: Readonly<Record<string, string>> = {
    'evidence':       'Evidence',
    'strategy':       'Strategy',
    'sub-conclusion': 'SubConclusion',
    'conclusion':     'Conclusion',
    '@support':       'AbstractSupport',
    'load':           'Load'
};

/** Rule names arrive with padding characters attached; only the word part identifies the rule. */
function ruleOf(stack: readonly string[]): string | undefined {
    for (let i = stack.length - 1; i >= 0; i--) {
        const name = stack[i].replace(/\W/g, '');
        if (name in DECLARATION_SHAPES) return name;
    }
    return undefined;
}

/** The rule being parsed when an error was raised, if it is one we can describe. */
export function describedRule(error: { context?: { ruleStack?: string[] } }): string | undefined {
    return ruleOf(error.context?.ruleStack ?? []);
}

/** What a construct still needs, in the language's own words rather than the parser's. */
export function shapeOf(rule: string): string | undefined {
    return DECLARATION_SHAPES[rule];
}

export class JpipeParserErrorMessageProvider extends LangiumParserErrorMessageProvider {

    override buildMismatchTokenMessage(options: {
        expected: TokenType;
        actual: IToken;
        previous: IToken;
        ruleName: string;
    }): string {
        const rule = this.constructAt(options.ruleName, options.previous.image);
        const expected = options.expected.name;
        const wanted = expected === 'ID' ? 'a name' : `'${expected}'`;

        if (rule) {
            return `Unfinished ${describeRule(rule)}: expected ${wanted} after '${options.previous.image}'. Write it as ${DECLARATION_SHAPES[rule]}.`;
        }
        return `Expected ${wanted} after '${options.previous.image}', but found '${options.actual.image}'.`;
    }

    override buildNoViableAltMessage(options: {
        expectedPathsPerAlt: TokenType[][][];
        actual: IToken[];
        previous: IToken;
        customUserDescription: string;
        ruleName: string;
    }): string {
        const rule = this.constructAt(options.ruleName, options.previous.image);
        if (rule) {
            return `Unfinished ${describeRule(rule)} after '${options.previous.image}'. Write it as ${DECLARATION_SHAPES[rule]}.`;
        }
        return super.buildNoViableAltMessage(options);
    }

    override buildEarlyExitMessage(options: {
        expectedIterationPaths: TokenType[][];
        actual: IToken[];
        previous: IToken;
        customUserDescription: string;
        ruleName: string;
    }): string {
        const rule = options.ruleName.replace(/\W/g, '');
        // The body rules are the ones a user meets here, by leaving a model empty.
        if (rule === 'JustificationBody' || rule === 'TemplateBody') {
            return 'A model cannot be empty: it needs at least one element or relation.';
        }
        if (rule === 'RuleConfig') {
            return 'A config block cannot be empty: it needs at least one key, written as <key>: "<value>".';
        }
        return super.buildEarlyExitMessage(options);
    }

    /**
     * Which declaration is being written: the failing rule when it names one, otherwise the
     * keyword the author last typed.
     */
    private constructAt(ruleName: string, previousImage: string): string | undefined {
        const rule = ruleName.replace(/\W/g, '');
        if (rule in DECLARATION_SHAPES) return rule;
        return OPENING_KEYWORDS[previousImage];
    }
}

/** The construct's name as an author would say it. */
// (declared below the class so the class reads first)

function describeRule(rule: string): string {
    switch (rule) {
        case 'SubConclusion':   return 'sub-conclusion';
        case 'AbstractSupport': return '@support';
        case 'KeyValDecl':      return 'config entry';
        case 'Relation':        return 'relation';
        case 'Load':            return 'load';
        default:                return rule.toLowerCase();
    }
}
