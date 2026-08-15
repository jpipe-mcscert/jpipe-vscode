# jPipe - VS Code Extension & Language Server

<div align="center">

![mcscert](https://raw.githubusercontent.com/jpipe-mcscert/jpipe-vscode/main/packages/extension/images/mcscert.png)

</div>

## Contributors

  - [Dr. Sébastien Mosser](https://mosser.github.io/), Associate Professor, McMaster University
  - [Cass Braun](https://www.linkedin.com/in/cass-braun/), B.Eng. Student, McMaster University
  - [Andrew Bovbel](https://www.linkedin.com/in/andrewbovbel/), B.Eng. Student, McMaster University
  - [Nirmal Chaudhari](https://www.linkedin.com/in/nirmal2003/), B.Eng. Student, McMaster University

## Contributing to the plugin

You can find more information about the jPipe project on the main repository: [https://github.com/jpipe-mcscert](https://github.com/jpipe-mcscert)

### Repository Organization

- `packages/extension`: Code specific to the VS Code platform
  - Visualization of justification models (preview)
  - Interaction with the jPipe compiler
- `package/language`: Language definition for the Language Server
  - jPipe grammar using Langium;
  - Validation rules
  - Scoping rules

### Where are the architecture decisions recorded?

In [`docs/adr/`](docs/adr/README.md), one file per decision — why the language server is its own
package, why there are five TypeScript projects, why the glob matcher is a hand-written port
rather than a dependency, and so on. Read it before making a structural change; the reasoning
behind a boundary is rarely visible from the code that respects it.

Records here are prefixed `VSC` (`ADR-VSC-0004`). The compiler
([jpipe-compiler](https://github.com/jpipe-mcscert/jpipe-compiler/tree/main/docs/adr)) numbers
its own from `0001`, and both are cited from this repository's source — so when citing one, name
the repository.

### What has to be green before a pull request merges?

Two checks, both required on `main`:

- **`build`** — a clean build, both test suites, and a real `vsce package`.
- **`Build and analyze`** — SonarQube Cloud, with the
  [Quality Gate](https://sonarcloud.io/dashboard?id=jpipe-mcscert_jpipe-vscode) enforced. The
  job fails if the gate fails, so a red check here means the gate said no.

Those are the names to search for when adding them under **Settings → Branches**. Note that a
pull request's checks list renders them with their workflow in front — *Build VS Code extension
/ build*, *SonarQube / Build and analyze* — but the required-status-check name is the bare job
name shown above.

The gate judges **new code only**. Existing debt is baselined and will not block you; what it
asks is that a change does not add uncovered, duplicated or smelly code. Coverage comes from
`npm run test:coverage`, which you can run locally to see what CI will see.

One limitation worth knowing: **a pull request opened from a fork cannot be analysed**, because
GitHub does not give fork workflows access to repository secrets, so the analysis has no token
and the check fails. If you do not have write access, open an issue or ask a maintainer to push
your branch here — `git fetch <your-fork> <branch> && git push origin HEAD:contrib/<name>` — and
retarget the pull request at it. See [ADR-VSC-0009](docs/adr/vsc-0009-sonarcloud-as-mandatory-quality-gate.md).

### How to setup the development environment?

#### Prerequisite: Volta

The Node.js toolchain is pinned in `package.json`, and [Volta](https://volta.sh) is what
enforces that pin. Install it **before** anything else:

```
mosser@azrael ~ % brew install volta      # or: curl https://get.volta.sh | bash
mosser@azrael ~ % volta setup
```

`volta setup` wires Volta into your shell — open a new terminal afterwards. From then on,
running `node` or `npm` inside this repository automatically uses the pinned versions
(currently Node 22.22.2 / npm 10.9.7), downloading them on first use. These are the same
versions the CI workflows use, so what builds locally is what builds in CI.

This is not optional tidiness. Without Volta you get whatever `node` your `PATH` happens to
point at, which may not be a version this project builds under — on Node 26, for instance,
`npm run langium:generate` fails with `TypeError: Invalid URL` inside `langium-cli`'s
configuration validation.

#### Installing the dependencies

```
mosser@azrael jpipe-vscode % npm install
mosser@azrael jpipe-vscode % npm install -g @vscode/vsce
```

`vsce` is installed globally, outside the pinned toolchain, and is only needed to package
or publish the extension.

### How to build and run the project?

- To generate the language artifacts based on the grammar
```
mosser@azrael jpipe-vscode % npm run langium:generate
```

- To build the extension:
```
mosser@azrael jpipe-vscode % npm run build
```

- To run the project in a new VS Code instance:
  - Simply press `F5`, it'll open a new VS Code environment with the plugin started.

### How to build a releasable VS Code extension?

- Building the extension
```
mosser@azrael jpipe-vscode % cd packages/extension 
mosser@azrael extension % vsce package -o jpipe-vscode.vsix
```

- Installing the extension locally:
```
mosser@azrael extension % code --install-extension jpipe-vscode.vsix
```

- Publishing the extension to the marketplace
```
mosser@azrael extension % vsce publish
```

### How to cut a release?

Releases are driven by `scripts/release.sh`, which mirrors the script of the same name in
[jpipe-compiler](https://github.com/jpipe-mcscert/jpipe-compiler). It has two verbs, and
**neither one tags, pushes or publishes** — those stay deliberate, human steps.

#### 1. Prepare, on `main`

```
mosser@azrael jpipe-vscode % ./scripts/release.sh prepare 1.4.0
```

This sets the version in all four places it has to agree — the three `package.json` files
plus the `jpipe-language` dependency inside `packages/extension/package.json` — reconciles
`package-lock.json`, flips the changelog's `### v1.4.0 (Unreleased)` heading to today's
date, runs the build and both test suites, and commits the result as
`chore(release): 1.4.0`. It refuses to start if the tree is dirty, you are not on an
up-to-date `main`, the tag already exists, or the changelog has no entries under the
version you named.

Add `--dry-run` to see the changes without writing anything.

The four-location dance is the reason this is a script rather than a command: `npm version`
handles three of them, but only with `--no-workspaces-update`, because otherwise npm tries
to resolve the still-old `jpipe-language` dependency against the registry and fails with a
`404` — that package is workspace-local and never published. The dependency and the
lockfile then have to be brought into line separately, in that order.

#### 2. Preflight, before tagging

```
mosser@azrael jpipe-vscode % git push
mosser@azrael jpipe-vscode % ./scripts/release.sh preflight 1.4.0
```

`preflight` is read-only. It re-runs everything `.github/workflows/release.yml` validates —
the four-way version comparison, the tag being on `main` — plus a full clean build, both
test suites, a real `vsce package`, and the SonarCloud quality gate on `main`. The point is
that the workflow's checks otherwise only fail *after* the tag is public, which is the
awkward thing to undo.

The gate is checked here because `release.yml` cannot: it runs against the tag, while the
gate runs against `main`, so a release cut from a red `main` would otherwise ship code the
project has already declined to merge. An unreachable SonarCloud is a warning rather than a
failure — a release should not be blocked by somebody else's outage.

The diagnostic vocabulary is compared against a `jpipe-compiler` checkout beside this one, for
the same reason and with the same escape: CI has no such checkout, so this is the only place the
comparison can run, and a missing checkout warns rather than fails. Point it elsewhere with
`npm run check:codes -- /path/to/jpipe-compiler`.

#### 3. Tag

```
mosser@azrael jpipe-vscode % git tag v1.4.0 && git push origin v1.4.0
```

Pushing the tag is what triggers the release: the workflow packages the VSIX, creates the
GitHub Release and publishes to the Marketplace.

### AI assistance policy

Parts of this codebase were developed with the assistance of Claude (Anthropic), an AI coding assistant. We are transparent about this use and welcome AI-assisted contributions, subject to the following conditions:

- Pull requests must not be 100% AI-generated. Every contribution must reflect the understanding and judgement of a human author.
- Human authors are fully responsible for the correctness, quality, and appropriateness of their contributions, regardless of whether AI tools were used in their preparation.
- Reviewers may ask contributors to explain any part of their submission.

## Sponsors

We acknowledge the support of McMaster University, McMaster Centre for Software Certification, and the _Natural Sciences and Engineering Research Council of Canada_ (NSERC).


