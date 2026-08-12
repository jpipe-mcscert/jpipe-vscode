# ADR-VSC-0018: The Windows launch rules are a `cross-spawn` port, and its regexes stay as written

**Date:** 2026-08-11
**Status:** Accepted

## Context

Node spawns processes with `CreateProcessW`, which appends `.exe` only when the command has no
extension. A compiler distributed as a batch shim — `jpipe.cmd`, which is what Scoop produces
from `"bin": [["jpipe.ps1", "jpipe"]]` — is therefore invisible to `execFile('jpipe', …)` and
fails with `spawn jpipe ENOENT`, while the identical name works in a terminal. This was a real
report, not a hypothetical.

The one-line fix is `shell: true`. It is the wrong one: the extension passes user-controlled
paths (`jpipe.cliPath`, `jpipe.jarFile`) and the diagram name read out of a `.jd` file, and a
shell would interpret every one of them. Command injection through a `.jd` file someone was sent
is not a defensible failure mode for a modelling tool.

So the command is resolved to a concrete file the way Windows resolves it, and only a batch shim
— which genuinely cannot be launched any other way — goes through `cmd.exe`, with each argument
escaped for it. Those escaping rules are not obvious. They come from `cross-spawn`, which derived
them from the analysis at <https://qntm.org/cmd>, and getting them wrong reintroduces exactly the
injection that avoiding `shell: true` was meant to prevent.

## Decision

`process-launcher.ts` carries a **verbatim port** of `cross-spawn`'s `cmd.exe` escaping, rather
than a dependency on `cross-spawn` or a rewrite. Platform, environment and filesystem are
injected, so the Windows rules are exercised by `process-launcher.test.ts` on any runner —
without which none of this would be tested at all, since CI is Linux.

**The two escaping regexes stay exactly as `cross-spawn` writes them:**

```ts
escaped = escaped.replace(/(\\*)"/g, '$1$1\\"');
escaped = escaped.replace(/(\\*)$/, '$1$1');
```

SonarCloud raises `typescript:S8786` on both — a nested quantifier means superlinear backtracking
on a pathological input. That is true, and it is suppressed in `sonar-project.properties`, scoped
to this rule and this file.

## Rationale

- **What the rule is warning about does not apply here.** The input is a command path from the
  user's own settings and a diagram name from a file they opened. The worst case is that someone
  hangs their own editor with a filename made of several thousand backslashes. There is no remote
  attacker and no shared service.
- **What a rewrite would cost is severe and silent.** These two lines decide whether an argument
  reaches the compiler intact or is re-parsed by `cmd.exe`. A "simplification" that changes the
  backslash-doubling arithmetic reintroduces the injection this design exists to prevent, on
  Windows only, where none of the maintainers develop.
- Depending on `cross-spawn` instead was considered. It pulls in a package to reach two functions
  and one path-resolution routine, and the port is what makes the rules injectable and therefore
  testable on Linux. That trade is the same one ADR-VSC-0004 makes everywhere else.
- The suppression is in the properties file, not the SonarCloud UI, for the reason given in
  ADR-VSC-0007's second amendment: an exemption is a decision, and this project's decisions live
  in the repository where they are reviewed with the code.

## What this does *not* cover

Deliberately narrow — one rule, one file. Anything else Sonar raises here is an ordinary finding.

In particular `typescript:S7780` on the same line is **not** covered:

```ts
escaped = escaped.replace(/(\\*)"/g, '$1$1\\"');
//                                    ^^^^^^^^ the replacement string, not the regex
```

`String.raw` there is a change of spelling with an identical result. The argument above is about
*behaviour that must not change*, and it does not stretch to how a string is quoted. Extending it
that far would turn a specific claim into a blanket exemption for the file, which is how these
stop meaning anything. That finding stays open and will be fixed with the others.

## Consequences

- `process-launcher.ts` must be re-checked against `cross-spawn` if its escaping is ever revised
  upstream. Nothing automated enforces this — the same coupling ADR-VSC-0007 records for the
  glob matcher, and with the same weakness.
- The suppression hides two genuine findings from the dashboard. A reader of SonarCloud alone
  would not know these regexes were ever examined; this record is the counterweight.
- If the day comes that `shell: true` looks tempting again, the reason it was refused is here
  rather than in a commit message.
