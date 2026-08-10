<div align="center">

![mcscert](https://raw.githubusercontent.com/jpipe-mcscert/jpipe-vscode/main/packages/extension/images/mcscert.png)

</div>


### Contributors

  - [Dr. Sébastien Mosser](https://mosser.github.io/), Associate Professor, McMaster University
  - [Andrew Bovbel](https://www.linkedin.com/in/andrewbovbel/), B.Eng. Student, McMaster University
  - [Nirmal Chaudhari](https://www.linkedin.com/in/nirmal2003/), B.Eng. Student, McMaster University
  - [Cass Braun](https://www.linkedin.com/in/cass-braun/), B.Eng. Student, McMaster University


### Using the plugin

#### Required software

The plugin requires the `jpipe` compiler to be vailable on your computer:
  - [https://www.jpipe.org/tutorials/install/](https://www.jpipe.org/tutorials/install/)

You can provide the compiler in three ways, selected via the `jpipe.executionMode` setting:

  - **cli** (recommended): the `jpipe` executable on your `PATH` (`jpipe.cliPath`).
  - **jar**: a JAR you downloaded yourself, run with `java` (`jpipe.jarFile`, `jpipe.javaExecutable`).
  - **managed** (easiest on Windows): run the **jPipe: Install Compiler from GitHub Release**
    command and pick a version. The extension downloads the selected compiler JAR over HTTPS
    from the [jpipe-compiler releases](https://github.com/jpipe-mcscert/jpipe-compiler/releases)
    into its own private storage and runs it with `java` — no manual path configuration. The
    downloaded JAR is an executable; the extension only fetches it after you explicitly pick a
    release, and periodically offers to update it. (Requires a Java runtime.)

#### How to use the plugin?

Simply open a file using the `.jd` extension.

#### Quick fixes and refactorings

Where the editor reports a problem it can repair, the lightbulb (`⌘.` / `Ctrl+.`) offers to do
it: write the declaration a template's `@support` demands, correct a mistyped operator or
config key, add the missing `load` for a model you referenced, or wire up a conclusion that
nothing supports yet.

Three more are offered for wherever your cursor is. Reach them from the lightbulb, from
**Refactor…** in the right-click menu (or `⌃⇧R` / `Ctrl+Shift+R`), or by name in the command
palette — *jPipe: Convert Justification to Template*, *Sort Elements*, *Extract Template*:

  - **Convert to template / justification** — switch what a model is. Converting a template says
    up front how many `@support` elements it would drop.
  - **Sort elements** — put a model's declarations in the order its argument reads: the
    conclusion first, then down through what supports it, one branch at a time, with a blank
    line opening each sub-argument.
  - **Extract template** — turn a justification into a reusable template plus a justification
    that implements it.

**Organize loads** — sort and de-duplicate the `load` statements at the top of a file — lives
under **Source Action…**, and in the command palette as *jPipe: Organize Loads*. It runs only
when you ask for it: reordering your source is a decision you make, not one that happens while
you save. It is deliberately not registered as `source.organizeImports`, so a global
organize-on-save setting kept for another language will not reach your `.jd` files.

When you do run it, it never removes a `load` whose path does not resolve — a half-typed path is
exactly the state a file is in while you are writing one.

#### Tutorials

Please visit [https://www.jpipe.org/tutorials/](https://www.jpipe.org/tutorials/) for examples and guidance o how to develop justificiation models using jPipe.

### How to contribute?

You can find more information about the jPipe project on the main repository: [https://github.com/jpipe-mcscert](https://github.com/jpipe-mcscert)

### AI assistance policy

Parts of this codebase were developed with the assistance of Claude (Anthropic), an AI coding assistant. We are transparent about this use and welcome AI-assisted contributions, subject to the following conditions:

- Pull requests must not be 100% AI-generated. Every contribution must reflect the understanding and judgement of a human author.
- Human authors are fully responsible for the correctness, quality, and appropriateness of their contributions, regardless of whether AI tools were used in their preparation.
- Reviewers may ask contributors to explain any part of their submission.


### Sponsors

We acknowledge the support of the _Natural Sciences and Engineering Research Council of Canada_ (NSERC), as well as McMaster University.