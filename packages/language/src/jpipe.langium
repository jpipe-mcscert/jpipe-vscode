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
    (body+=Evidence | body+=Strategy | rels+=Relation)+;

PatternBody:
    (body+=Evidence |  body+=Strategy |  body+=AbstractSupport | rels+=Relation)+;

/**
 * Contents of justification / patterns
 */

JustificationElementDeclaration:
    name=ID 'is' label=STRING;

type JustificationElement = Evidence | Strategy | AbstractSupport

Evidence: 
    'evidence' decl=JustificationElementDeclaration;

Strategy:
    'strategy' decl=JustificationElementDeclaration;

AbstractSupport:
    '@support' decl=JustificationElementDeclaration;

Relation:
    from=[JustificationElementDeclaration:ID] 'supports' to=[JustificationElementDeclaration:ID];



hidden terminal WS: /\s+/;
terminal ID: /[\w_]+/;
terminal STRING: /"(\\.|[^"\\])*"|'(\\.|[^'\\])*'/;

hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;