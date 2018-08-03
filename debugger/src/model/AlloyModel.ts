import { DebuggerSettings } from "../DebuggerSettings";
import { LogLevel } from "../logger";
import { mkString, indent } from "../util";

// TODO: Fix this
type Multiplicity = 'lone' | 'some' | 'one';

interface ModelPart {
    build(outputReadableModel: boolean): string;
}

export class Signature implements ModelPart {
    private isAbstract: boolean;
    private multiplicity: Multiplicity | undefined;
    private extendedSignature: string | undefined;
    private members: string[];
    private constraints: string[];
    private inSignature: string | undefined;

    constructor(readonly name: string) {
        this.isAbstract = false;
        this.members = [];
        this.constraints = [];
    }

    public extends(name: string) {
        this.extendedSignature = name;
        return this;
    }

    public in(name: string) {
        this.inSignature = name;
        return this;
    }

    public withMultiplicity(multiplicity: Multiplicity) {
        this.multiplicity = multiplicity;
        return this;
    }

    public withMember(decl: string) {
        this.members.push(decl);
        return this;
    }

    public withMembers(decls: string[]) {
        this.members = this.members.concat(decls);
        return this;
    }

    public withConstraint(constraint: string) {
        this.constraints.push(constraint);
        return this;
    }
    public withConstraints(constraints: string[]) {
        this.constraints = this.constraints.concat(constraints);
        return this;
    }

    public abstract() {
        this.isAbstract = true;
        return this;
    }

    public build(outputReadableModel: boolean) {
        let sig: string[] = [];
        const spacer = outputReadableModel ? "\n" : "";
        const indentLevel = outputReadableModel ? 2 : 0;

        if (this.isAbstract) {
            sig.push("abstract ");
        }
        if (this.multiplicity) {
            sig.push(this.multiplicity + " ");
        }
        sig.push(`sig ${this.name}`);
        if (this.extendedSignature) {
            sig.push(` extends ${this.extendedSignature}`);
        }
        if (this.inSignature) {
            sig.push(` in ${this.inSignature}`);
        }

        if (this.members.length > 0) {
            sig.push(mkString(indent(this.members, indentLevel), " {" + spacer, ", " + spacer, spacer + "}"));
        } else {
            sig.push(" {}");
        }

        if (this.constraints.length > 0) {
            sig.push(mkString(indent(this.constraints, indentLevel), " {" + spacer, " && " + spacer, spacer + "}"));
        }

        return sig.join("");
    }
}

class Comment implements ModelPart {
    constructor(readonly comment: string) {}
    build() {
        return '// ' + this.comment;
    }
}

class Fact implements ModelPart {
    constructor(readonly fact: string) {}

    build() {
        return `fact { ${this.fact} }`;
    }
}

const Blank: ModelPart = {
    build: () => ""
};

export class AlloyModelBuilder {

    private parts: ModelPart[];

    constructor() {
        this.parts = [];
    }

    public comment(text: string) {
        if (DebuggerSettings.logLevel === LogLevel.DEBUG) {
            this.parts.push(new Comment(text));
        }
    }

    public blank() {
        if (DebuggerSettings.logLevel === LogLevel.DEBUG) {
            this.parts.push(Blank);
        }
    }

    public signature(name: string) {
        const s =  new Signature(name);
        this.parts.push(s);
        return s;
    }

    public abstractSignature(name: string) {
        return this.signature(name).abstract();
    }

    public oneSignature(name: string) {
        return this.signature(name).withMultiplicity('one');
    }

    public loneSignature(name: string) {
        return this.signature(name).withMultiplicity('lone');
    }

    public fact(fact: string) {
        this.parts.push(new Fact(fact));
    }

    public fun(f: string) {
        this.parts.push({ build: () => f});
    }

    // TODO: Remove this.
    public text(t: string) {
        this.parts.push({ build: () => t});
    }

    public pred(p: string) {
        this.parts.push({ build: () => p});
    }

    public build(baseCount: number, countPerInstance: Map<string, number>): string {
        // TODO: Fix this
        const outputReadableModel = DebuggerSettings.logLevel === LogLevel.DEBUG;
        const model = this.parts
            .map(p => p.build(outputReadableModel))
            .join("\n");

        const counts: string[] = [];
        countPerInstance.forEach((count, instance) => {
            if (count > 0) {
                counts.push(`${count} ${instance}`);
            }
        });

        return model + '\n' +
            'pred generate() {}\n' +
            `run generate for ${baseCount} but ${counts.join(', ')}`;
    }
}