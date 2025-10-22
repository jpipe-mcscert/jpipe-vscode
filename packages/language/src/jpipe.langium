grammar Jpipe

entry Unit:
    (body+=Justification | body+=Pattern | imports+=Load)*;

/**
 * Top-level elements: Justification, Patterns, File import
 */
Load:
    'load' filePath=STRING;

Justification: 
    'justification' name=ID ('implements' parent=[Pattern:ID])? '{' contents=JustificationBody '}';

Pattern: 
    'pattern' name=ID ('implements' parent=[Pattern:ID])? '{' contents=PatternBody '}';

type Body = JustificationBody | PatternBody

JustificationBody:
    (body+=Evidence | body+=Strategy | body+=SubConclusion | body+=Conclusion | rels+=Relation)+;

PatternBody:
    (body+=Evidence | body+=Strategy | body+=SubConclusion | body+=Conclusion | body+=AbstractSupport | rels+=Relation)+;

/**
 * Contents of justification / patterns
 */

type JustificationElement = Evidence | Strategy | SubConclusion | Conclusion | AbstractSupport

Evidence: 
    'evidence' name=ID 'is' label=STRING;

Conclusion: 
    'conclusion' name=ID 'is' label=STRING;

Strategy:
    'strategy' name=ID 'is' label=STRING;

SubConclusion:
    'sub-conclusion' name=ID 'is' label=STRING;


AbstractSupport:
    '@support' name=ID 'is' label=STRING;

Relation:
    from=[JustificationElement:ID] 'supports' to=[JustificationElement:ID];

hidden terminal WS: /\s+/;
terminal ID: /[\w_]+/;
terminal STRING: /"(\\.|[^"\\])*"|'(\\.|[^'\\])*'/;

hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;