grammar Jpipe

entry Unit:
    (body+=Justification | body+=Template | imports+=Load)*;

/**
 * Top-level elements: Justification, Templates, File import
 */
Load:
    'load' filePath=STRING;

Justification: 
    'justification' name=ID ('implements' parent=[Template:ID])? '{' contents=JustificationBody '}';

Template: 
    'template' name=ID ('implements' parent=[Template:ID])? '{' contents=TemplateBody '}';

type Body = JustificationBody | TemplateBody

JustificationBody:
    (body+=Evidence | body+=Strategy | body+=SubConclusion | body+=Conclusion | rels+=Relation)+;

TemplateBody:
    (body+=Evidence | body+=Strategy | body+=SubConclusion | body+=Conclusion | body+=AbstractSupport | rels+=Relation)+;

/**
 * Contents of justification / templates
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