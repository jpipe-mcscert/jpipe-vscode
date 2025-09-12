# jPipe - VS Code Extension & Language Server

<div align="center">

![mcscert](https://raw.githubusercontent.com/jpipe-mcscert/assets/refs/heads/main/mcscert/m24-mcscert_left-col_png.png)


</div>

## Contributors

  - [Dr. Sébastien Mosser](https://mosser.github.io/), Associate Professor, McMaster University
  - [Nirmal Chaudhari](https://www.linkedin.com/in/nirmal2003/), B.Eng. Student, McMaster University
  - [Cass Braun](https://www.linkedin.com/in/cass-braun/), B.Eng. Student, McMaster University
  - [Andrew Bovbel](https://www.linkedin.com/in/andrewbovbel/), B.Eng. Student, McMaster University

## How to contribute?

You can find more information about the jPipe project on the main repository: [https://github.com/jpipe-mcscert](https://github.com/jpipe-mcscert)

## Repository Organization

- `packages/extension`: Code specific to the VS Code platform
  - Visualization of justification models (preview)
  - Interaction with the jPipe compiler
- `package/language`: Language definition for the Language Server
  - jPipe grammar using Langium;
  - Validation rules
  - Scoping rules

## Contributing to the project

### How to setup the development environment?

```
mosser@azrael jpipe-vscode % npm install
mosser@azrael jpipe-vscode % npm install -g @vscode/vsce
```

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

### Sponsors

We acknowledge the support of McMaster University, McMaster Centre for Software Certification, and the _Natural Sciences and Engineering Research Council of Canada_ (NSERC).


