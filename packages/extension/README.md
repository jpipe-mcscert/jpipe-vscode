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

The plugin requires the `jpipe` compiler to be available on your computer:
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

You get syntax highlighting, live validation, completion, hover and go-to-definition across the
files a model `load`s, quick fixes on the lightbulb (`⌘.` / `Ctrl+.`), refactorings under
**Refactor…**, **Format Document** (`⇧⌥F` / `Shift+Alt+F`) to lay a model out, and a diagram
preview you can export. Everything is also in the command palette under *jPipe*. The tutorials
below walk through them.

#### Tutorials

Please visit [https://www.jpipe.org/tutorials/](https://www.jpipe.org/tutorials/) for examples and guidance on how to develop justification models using jPipe.

### How to contribute?

You can find more information about the jPipe project on the main repository: [https://github.com/jpipe-mcscert](https://github.com/jpipe-mcscert)

### AI assistance policy

Parts of this codebase were developed with the assistance of Claude (Anthropic), an AI coding assistant. We are transparent about this use and welcome AI-assisted contributions, subject to the following conditions:

- Pull requests must not be 100% AI-generated. Every contribution must reflect the understanding and judgement of a human author.
- Human authors are fully responsible for the correctness, quality, and appropriateness of their contributions, regardless of whether AI tools were used in their preparation.
- Reviewers may ask contributors to explain any part of their submission.


### Sponsors

We acknowledge the support of the _Natural Sciences and Engineering Research Council of Canada_ (NSERC), as well as McMaster University.