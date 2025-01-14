# Important note 

An active version of this repository has moved to [viperproject/lizard](https://github.com/viperproject/lizard). 

# Lizard: the Viper debugger
Lizard is a VS Code extension and an experimental visual debugger for the Viper intermediate verification language. It works with both Viper's backends (Silicon as well as Carbon), although not all Viper language features might work correctly. Hence, Lizard requires the Viper VS Code extension to be installed. Verification errors reported by Viper trigger Lizard to produce comprehensible counterexamples to failed assertions, postconditions, or invariants. 
Lizard displays the counterexample _next to_ the Viper program that failed to verify. 

# Core use case
Lizard's main purpose is debugging (unbounded) heap-manipulating Viper programs that are specified in terms of quantifier permissions (a.k.a. iterated separating conjunction). Lizard is especially useful in combination with Chuckwalla (Viper's prototypical extension for heap-reachability verification). However, it may be that at this time Chuckwalla is not yet implemented. 

# How it works
To generate a counterexample, Lizard combines the available type information with the information from the SMT model (normally produced by Z3 in an incomplete yet incomprehensible manner). Visualization is further facilitated by some preexpectation for the _shape_ of possible counterexamples. For example, it is expected that each method's footprint is represented as a set of references to the nodes, the fields of which may be accessed by the method. 

# Other use cases
Lizard might be useful also as a platform for prototyping other Viper debuggers, providing an API for querying SMT models from within Viper IDE. Lizard is written in TypeScript and uses things like Graphviz, Node.js, Webpack, WebView, HTML, CSS, and prayer. 

# For developers

To compile the project: 
1. clone the repo
2. run ```npm install``` to install the dependencies 
3. run ```npm run compile``` to build the extension 
4. run ```code lizard/``` to open the project in VS Code 
5. start the extension from the debug panel in VS Code 
6. run ```vsce package``` to assemble a portable distribution bundle

# Historical note
This extension is a follow-up project to the family of verification debugger prototypes developed as student projects at the Programming Methodology Group at ETH Zurich. In particular, some code is borrowed from Alessio Aurrechia's Master thesis project (which used symbolic execution traces and Alloy models, as opposed to Z3 models, to extract possible counterexamples). 
