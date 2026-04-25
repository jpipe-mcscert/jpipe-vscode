grammar Jpipe

entry Unit:
    (body+=Justification | body+=Template | imports+=Load)+;

Load:
    'load' path=STRING ('as' namespace=ID)?;

Justification:
    'justification' id=ID ('implements' parent=[Template:QualifiedRef])?
    ( '{' contents=JustificationBody '}' | 'is' operator=QualifiedId '(' params=ParamsDecl? ')' config=RuleConfig? );

Template:
    'template' id=ID ('implements' parent=[Template:QualifiedRef])?
    ( '{' contents=TemplateBody '}' | 'is' operator=QualifiedId '(' params=ParamsDecl? ')' config=RuleConfig? );

type Body = JustificationBody | TemplateBody

JustificationBody:
    (body+=Evidence | body+=Strategy | body+=SubConclusion | body+=Conclusion | rels+=Relation)+;

TemplateBody:
    (body+=Evidence | body+=Strategy | body+=SubConclusion | body+=Conclusion | body+=AbstractSupport | rels+=Relation)+;

type JustificationElement = Evidence | Strategy | SubConclusion | Conclusion | AbstractSupport

Evidence:
    'evidence' id=QualifiedId 'is' name=STRING;

Conclusion:
    'conclusion' id=QualifiedId 'is' name=STRING;

Strategy:
    'strategy' id=QualifiedId 'is' name=STRING;

SubConclusion:
    'sub-conclusion' id=QualifiedId 'is' name=STRING;

AbstractSupport:
    '@support' id=QualifiedId 'is' name=STRING;

Relation:
    from=[JustificationElement:QualifiedRef] 'supports' to=[JustificationElement:QualifiedRef];

QualifiedId:
    parts+=ID (':' parts+=ID)*;

QualifiedRef returns string:
    ID (':' ID)*;

ParamsDecl:
    ids+=QualifiedId (',' ids+=QualifiedId)*;

RuleConfig:
    '{' entries+=KeyValDecl+ '}';

KeyValDecl:
    key=ID ':' value=STRING;


hidden terminal WS: /\s+/;
terminal ID: /[\w_]+/;
terminal STRING: /"(\\.|[^"\\])*"|'(\\.|[^'\\])*'/;

hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
