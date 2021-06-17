import { Func } from "mocha"
import { type } from "os"
import { stringify } from "querystring"
import { FunctionBreakpoint } from "vscode"
import { Logger } from "./logger"

export interface ViperLocation {
    start: string
    end: string
    file: string
}

export interface ViperDefinition {
    name: string
    location: ViperLocation
    scopeStart: ViperLocation | "global"
    scopeEnd: ViperLocation | "global"
    type: { name: string, viperType: { kind: string, typename: any, isConcrete?: boolean } }
}

export interface ModelEntry {
    type: string
}

export class ConstantEntry implements ModelEntry {
    type = 'constant_entry'
    value: string
    constructor(v: string) {
        this.value = v
    }
}

export function getConstantEntryValue(entry: ModelEntry): string {
    if (entry.type !== 'constant_entry') {
        throw `expected entry of type 'constant_entry'; got '${entry.type}'`
    }
    return (<ConstantEntry> entry).value
}

export interface FunctionValue {
    args: Array<ModelEntry>
    name: string
}

export class ApplicationEntry implements ModelEntry {
    type = 'application_entry'
    value: FunctionValue
    constructor(value: FunctionValue) {
        this.value = value
    }
}

export interface ModelCase {
    args: Array<ModelEntry>
    value: ModelEntry
}

export class MapEntry implements ModelEntry {
    type = 'map_entry'
    cases: Array<ModelCase>  
    default: ModelEntry
    constructor(cs: Array<ModelCase>, df: ModelEntry) {
        this.cases = cs
        this.default = df
    }
}

// class FieldMapCase implements ModelCase {
//     constructor(public state: ModelEntry,
//                 public reciever: ModelEntry, 
//                 public ) {
//         args
//     }
// }

// class FieldMapEntry extends MapEntry {
    
//     constructor()
// }

// class PartialResult {
//     [Key: string]: 
// }

// class PartialMapApplication {
    
//     private value: string | PartialResult

//     constructor(public m_entry: MapEntry, 
//                 public partial_args: Array<string>) {}
    
//     public get() {
//         return this.value
//     }
// }

export interface Model {
    [Key: string]: ModelEntry
}

export interface ViperType {
    typename: string
    innerval: string | undefined
}

export class RefType implements ViperType {
    typename = "Ref"
    constructor(public innerval: string | undefined = undefined) {}
}

export class IntType implements ViperType {
    typename = "Int"
    constructor(public innerval: string | undefined = undefined) {}
}

export class BoolType implements ViperType {
    typename = "Bool"
    constructor(public innerval: string | undefined = undefined) {}
}

export class PermType implements ViperType {
    typename = "Perm"
    constructor(public innerval: string | undefined = undefined) {}
}

export class SetType implements ViperType {
    typename: string
    constructor(public innerval: string | undefined = undefined, 
                public type_arg: ViperType) {
        this.typename = `Set[${type_arg.typename}]`
    }
}

export class OtherType implements ViperType {
    typename = "Other"
    constructor(public innerval: string | undefined = undefined) {}
}

// TODO: support other types e.g. Maps, Multisets, etc. 

export class Node {
    constructor(public name: string,                // e.g. "X@7@12"
                public type: ViperType | undefined, // e.g. "Ref" (undefined for internal values for which we do not know the exact type)
                public id: number,                  // 0, 1, 2, ...
                public val: string,                 // e.g. "$Ref!val!0"
                public proto: string | undefined = undefined) {}  // e.g. "X"
}

export class Graph {
    constructor(public name: string, 
                //public state: string, 
                public node_ids: Array<number>) {}
}

// class StatefulGraph extends Graph {
//     constructor(public name: string,
//                 public )
// }

export class Relation {
    constructor(public name: string,        // e.g. "NEXT", "edge", or "exists_path"
                public state: string,       // Heap@@1
                public pred: Node, 
                public succ: Node) {}
}

export class GraphModel {
    constructor(
        public graph: Graph,
        public nodes: Array<Node>,

        public fields: Array<Relation>,
        public edges: Array<Relation>,
        public paths: Array<Relation>,

        public equivalence_classes: EquivClasses) {}
}

class EquivClasses {
    [Key: string]: Array<Node>   // mapping inner values to nodes
}

export class Session {
    public programDefinitions: Array<ViperDefinition> | undefined = undefined
    public model: Model | undefined = undefined

    public isSilicon(): boolean {
        return this.backend.includes('silicon')
    }
    public isCarbon(): boolean {
        return this.backend.includes('carbon')
    }    
    constructor(public backend: string, 
                private __next_node_id = 0) {}

    private freshNodeId(): number {
        let next_node_id = this.__next_node_id
        this.__next_node_id ++
        return next_node_id
    }

    private mkNode(name: string, innerval: string, proto: string | undefined = undefined): Node {
        // Internal nodes might be of unknown type
        let typ: ViperType | undefined = this.viper_type!(name)
        return new Node(name, typ, this.freshNodeId(), innerval, proto)
    }

    static myRelations = ['[2]', '[3]', '[4:=]', 
                          'exists_path_', 'exists_path', 
                          'edge_', 'edge', '$$', '$$\'']

    public setProgramDefs(pds: Array<ViperDefinition>): void {
        this.programDefinitions = pds
    }

    public parseModel(m: Model): void {
        if (!(typeof m === 'object' && m !== null)) {
            Logger.error(`model must be a JavaScript object`)
            return
        }
        var valid_model = true

        // check model
        Object.entries(m).forEach(entry => {
            let key = entry[0]
            let value = entry[1]
            if (!(typeof value === 'object' && value !== null)) {
                Logger.error(`model entry values must be objects`)
                valid_model = false
                return
            }
            if (!value.hasOwnProperty('type')) {
                Logger.error(`model entry values must be objects with field 'type'`)
                valid_model = false
                return
            }
            valid_model = true
        })

        // save model 
        if (valid_model) {
            this.model = <Model> m
        } else {
            Logger.info(`model not updated sinse there were failed sanity checks`)
        }
    }

    private atoms: Array<Node> | undefined = undefined
    private states: Array<string> | undefined = undefined 
    private extended_equiv_classes: EquivClasses | undefined = undefined

    private graphModel: GraphModel | undefined = undefined

    public preProcessRawModel(): void {
        // 0. Collect types
        this.precomputeTypes()

        // 1. Collect program states 
        this.states = this.collectStates()

        // 2. Extract all atoms (i.e. top-level constant_entries) from the raw model. 
        this.atoms = new Array<Node>()
        Object.entries(this.model!).forEach(pair => {
            let name = pair[0]
            let constant_entry = pair[1]
            if (constant_entry.type === 'constant_entry') {
                let innerval = (<ConstantEntry> constant_entry).value
                let new_node = this.mkNode(name, innerval)
                this.atoms!.push(new_node)
            }
        })

        // 3. Compute equivalence classes amongst all atoms
        this.extended_equiv_classes = this.collectEquivClasses(this.atoms!)
    }

    private collectEquivClasses(nodes: Array<Node>): EquivClasses {
        let res: EquivClasses = new EquivClasses()

        nodes.forEach(node => {
            if (res.hasOwnProperty(node.val)) {
                res[node.val].push(node)
            } else {
                res[node.val] = [node]
            }
        })

        return res
    }

    private collectGraphNodes(): Array<Node> {
        
        let names = this.getDefinitionNames('Local')
                    .concat(this.getDefinitionNames('Argument'))
                    .concat(this.nullNodeName())

        // Find atoms that define graph nodes
        let graph_nodes = names.flatMap(proto => this.atoms!.filter(atom => atom.name.startsWith(proto)))

        // Check that all expected nodes are defined in each state
        if (graph_nodes.length < names.length) {
            Logger.warn(`could not find definitions for some graph nodes in raw model`)
        }

        return graph_nodes
    }

    private collectFields(nodes: Array<Node>): Array<Relation> {
        let fnames = this.getDefinitionNames('Field')

        // Deduce relations for each field, node, state
        let state_to_field_val_funs = fnames.flatMap(fname => 
            nodes.flatMap(node => {
                let state_to_rels = this.collectFieldValueInfo(node, fname)
                return this.states!.map(state => {
                    let adj_node = state_to_rels(state)
                    return new Relation(fname, state, node, adj_node)
                })
            }))

        return state_to_field_val_funs
    }

    public produceGraphModel(): GraphModel {
        let nodes = this.collectGraphNodes()
        let fields = this.collectFields(nodes)
        
        let graph = new Graph('G', nodes.map(n => n.id))
        
        let equivalence_classes = this.collectEquivClasses(nodes)

        // TODO: edges, paths
        this.graphModel = new GraphModel(graph, nodes, fields, [], [], equivalence_classes)  

        return this.graphModel!
    }

    private getDefinitionNames(type: string): Array<string> {
        return this.programDefinitions!.filter(def => def.type.name === type).flatMap(def => def.name)
    }

    private getDefinitionModelValues(idn: string): Array<[string, ModelEntry]> {
        return Object.entries(this.model!).filter(mapEntry => mapEntry[0].startsWith(idn))
    }

    private collectDependentEntriesRec(entry_path: Array<string>, 
                                       entry: ModelEntry, value: string): Array<[Array<string>, ModelEntry]> {
        switch(entry.type) {
            case 'constant_entry': 
                if ((<ConstantEntry> entry).value === value) {
                    return [[entry_path, entry]]
                } else {
                    return []
                }

            case 'application_entry':
                let fun = (<ApplicationEntry> entry).value
                return fun.args.flatMap(arg => 
                    this.collectDependentEntriesRec(entry_path.concat([fun.name]), arg, value))

            case 'map_entry': 
                let map = (<MapEntry> entry)
                let res1 = this.collectDependentEntriesRec(entry_path.concat('default'), map.default, value)
                let res2 = map.cases.flatMap(caseEntry => {
                    let res11 = this.collectDependentEntriesRec(entry_path.concat('value'), caseEntry.value, value)
                    let res21 = caseEntry.args.flatMap((arg, index) => {
                        return this.collectDependentEntriesRec(entry_path.concat(`arg${index}`), arg, value)
                    })
                    return res11.concat(res21)
                })
                return res1.concat(res2)
                
            default: 
                Logger.error(`unsupported model entry type: ${entry.type}`)
                return []
        }
    }

    private collectDependentEntries(dep_value: string): Array<[Array<string>, ModelEntry]> {
        return Object.entries(this.model!).flatMap(entry => 
            this.collectDependentEntriesRec([entry[0]], entry[1], dep_value))
    }

    private collectFieldValueInfo(node: Node, fname: string): (state: string) => Node {
        let rel_name = this.fieldLookupRelationName(fname)
        let rel_maybe = Object.entries(this.model!).find(pair => pair[0] === rel_name)
        if (!rel_maybe) {
            throw `model does not contain the expected relation '${rel_name}' for field ${fname}`
        } 
        let rel = rel_maybe![1]
        if (rel.type !== 'map_entry') {
            throw `field-value relation '${rel_name}' must be of type 'map_entry'`
        }
        let field_node_val = this.fieldNodeValue(fname)
        let simple_fun = this.partiallyApplyFieldMapEntry(<MapEntry> rel, node.val, field_node_val)
        return (state: string) => {
            let succ_innerval = simple_fun(state)
            let succ: Node
            if (this.extended_equiv_classes!.hasOwnProperty(succ_innerval)) {
                let succs = this.extended_equiv_classes![succ_innerval]
                if (succs.length > 1) {
                    Logger.warn(`multiple values are possible for ${node.name}.${fname}; ` + 
                                `perhaps there are multiple program states involved?`)
                }
                succ = succs[0]
            } else {
                // this is a fresh value; create a new atom to support it
                let name = `${node.name}.${fname}`
                Logger.warn(`no atom found for value ${succ_innerval} of ${name} in state ${state}`)
                succ = this.mkNode(name, succ_innerval)
                this.extended_equiv_classes![succ_innerval] = new Array<Node>(succ)
            }
            return succ
        }
    }

    private getAtomsByInnerVal(innerval: string): Array<Node> {
        return this.atoms!.filter(atom => atom.val === innerval)
    }

    private appleEntry(entry: ModelEntry, args: Array<string>): string {
        if (entry.type === 'constant_entry') {
            let const_entry = <ConstantEntry> entry
            return const_entry.value
        } else if (entry.type === 'function_entry') {
            throw `entries of type 'function_entry' are not yet supported`
        } else {
            let map_entry = <MapEntry> entry
            let res_entry_maybe = map_entry.cases.find(map_case => {
                
                let matches = args.map((arg, index) => {
                    let case_arg = getConstantEntryValue(map_case.args[index])
                    return arg === case_arg
                })
                return matches.every(x => x)
            })
            if (res_entry_maybe) {
                let case_entry = res_entry_maybe!.value
                let case_val = getConstantEntryValue(case_entry)
                return case_val
            } else {
                let default_entry = map_entry.default
                let default_val = getConstantEntryValue(default_entry)
                return default_val
            } 
        }
    }

    private getEntriesViaRegExp(pattern: RegExp): Array<[string, ModelEntry]> {
        return Object.entries(this.model!).filter(pair => pattern.test(pair[0]))
    }
    
    /** Backend-specific code */

    private nullNodeName(): string {
        return this.isCarbon() ? 'null' : '$Ref.null'
    }

    private collectStates(): Array<string> {
        return Object.entries(this.model!).filter(pair => {
            let entry_name = pair[0]
            let entry = pair[1]
            if (this.isCarbon()) {
                return entry_name.startsWith('Heap@@')
            } else {
                return entry.type === 'constant_entry' && (<ConstantEntry> entry).value.startsWith('$FVF<')
            }
        }).map(pair => (<ConstantEntry> pair[1]).value)
    }

    private partiallyApplyFieldMapEntry(m_entry: MapEntry, reciever: string, field: string | undefined): (state: string) => string {

        let res_map = new Map<string, string>()

        m_entry.cases.forEach(map_case => {
            let state_entry = map_case.args[0]
            let state = getConstantEntryValue(state_entry)

            // Check if this case matches the provided partial arguments
            let first_entry = map_case.args[1]
            let first = getConstantEntryValue(first_entry)
        
            if (field) {
                let second_entry = map_case.args[2]
                let second = getConstantEntryValue(second_entry)
                if (first === reciever && second === field) {
                    let val = getConstantEntryValue(map_case.value)
                    res_map.set(state, val)
                }
            } else {
                if (first === reciever) {
                    let val = getConstantEntryValue(map_case.value)
                    res_map.set(state, val)
                }   
            }
        })

        let default_entry = m_entry.default
        let default_val = getConstantEntryValue(default_entry)
        
        return (state: string) => {
            if (res_map.has(state)) {
                return res_map.get(state)!
            } else {
                return default_val
            }
        }
    }

    private fieldLookupRelationName(fname: string): string {
        return this.isCarbon() ? '[3]' : `$FVF.lookup_${fname}`
    }

    private fieldNodeValue(fname: string): string | undefined {
        if (this.isCarbon()) {
            let field_node_entry = this.model![fname]
            let field_node_val = getConstantEntryValue(field_node_entry)
            return field_node_val
        } else {
            return undefined
        }
    }

    // PRECOMPUTE
    private viper_type: ((nodename: string) => ViperType) | undefined = undefined 
    private carbon_type: ((value: string) => ViperType) | undefined = undefined
    private silicon_type: ((value: string) => ViperType) | undefined = undefined

    private static serializeConcreteViperTypeRec: (typ: any) => string = (typ: any) => {
        if (typ.kind === 'atomic') {
            return typ.typename
        } else if (typ.hasOwnProperty('collection')) {
            let collection = typ.collection
            if (collection === 'Set' || collection === 'Seq' || collection === 'MultiSet') {
                let elem_type: string = Session.serializeConcreteViperTypeRec(typ.elements)
                return `${collection}[${elem_type}]`

            } else if (collection == 'Map') {
                let keys_type: string = Session.serializeConcreteViperTypeRec(typ.keys)
                let values_type: string = Session.serializeConcreteViperTypeRec(typ.values)
                return `Map[${keys_type},${values_type}]`
            } else {
                let type_args: Array<string> = typ.typeParams.map((t: any) => Session.serializeConcreteViperTypeRec(t))
                return `${collection}[${type_args.join(',')}]`
            }
        } else {
            throw `serialization of type ${typ} is not supported`
        }
    }

    private precomputeTypes() {

        // Type information from Viper

        let viper_type_map = new Map<string, ViperType>()    // for mapping values to types
        let viper_type_cache = new Map<string, ViperType>()  // for reusing the types whenever possible

        let viper_Bool_type = new BoolType();                viper_type_cache.set('Bool', viper_Bool_type)
        let viper_Int_type  = new IntType();                 viper_type_cache.set('Int', viper_Int_type)
        let viper_Ref_type  = new RefType();                 viper_type_cache.set('Ref', viper_Ref_type)
        let viper_Perm_type = new PermType();                viper_type_cache.set('Perm', viper_Perm_type)
        let viper_Wand_type = new OtherType('Wand');         viper_type_cache.set('Wand', viper_Wand_type)
        let viper_Internal_type = new OtherType('Internal'); viper_type_cache.set('Internal', viper_Internal_type)

        let strToType = (strRepr: string) => {
            if (viper_type_cache.has(strRepr)) {
                return viper_type_cache.get(strRepr)!
            } else {
                let new_type: ViperType
                if (strRepr === 'Set[Ref]') {
                    new_type = new SetType(undefined, viper_Ref_type)
                } else {
                    // TODO: track types more precisely
                    new_type = new OtherType(strRepr)
                }
                viper_type_cache.set(strRepr, new_type)
                return new_type
            }
        }

        
        // let viper_SetOfRefs_type = new SetType(undefined, viper_Ref_type)
        // viper_type_cache.set('Set[Ref]', viper_SetOfRefs_type)

        // Collect things that should be statically typed
        let typed_definitions = this.programDefinitions!.filter(def => def.type.hasOwnProperty('viperType'))
        
        // Map typed things to types
        typed_definitions.forEach(typed_def => {
            let thing = typed_def.name
            let vipertype = typed_def.type.viperType
            let typename: string

            if (vipertype.kind === 'atomic') {
                // Atomic types are normally already cached, unless it is backend-specific
                if (vipertype.typename.hasOwnProperty('smtName')) {
                    // The rare case
                    typename = <string> vipertype.typename.smtName
                } else {
                    // The normal case
                    typename = <string> vipertype.typename
                }     
            } else if (vipertype.kind === 'generic') {
                // Generic types can be concrete of with (partially-) instantiated type perameters. 
                if (vipertype.isConcrete) {
                    // This must be a collection (Seq[T], Set[T], Map[T,S], $CustomType[A,B,C,...])
                    typename = Session.serializeConcreteViperTypeRec(vipertype.typename)
                } else {
                    // Non-concrete collection types are pre-serialized
                    typename = vipertype.typename
                }
            } else if (vipertype.kind === 'extension') {
                // Extension types are pre-serialized for now 
                // (See ViperServer viper/server/frontends/http/jsonWriters/ViperIDEProtocol.scala)
                typename = vipertype.typename
            } else {
                // TODO: generalize to arbitrary types
                typename = vipertype.typename
            }

            let typ = strToType(typename)
            viper_type_map.set(thing, typ)
        })

        this.viper_type = (nodename: string) => {
            let typed_thing: string
            if (this.isCarbon()) {
                typed_thing = nodename
            } else {
                let m = nodename.match(/(.*)@\d+@\d+/)
                if (m && m[1]) {
                    typed_thing = m[1]
                } else {
                    typed_thing = nodename
                }
            }
            return viper_type_map.get(typed_thing)!
        }

        // Type informtion from the SMT model
        if (this.isCarbon()) {
            let carbon_type_map = new Map<string, ViperType>()
            
            // Refs
            let ref_type_val = getConstantEntryValue(this.model!.RefType)
            carbon_type_map.set(ref_type_val, new RefType(ref_type_val))
            
            // Bools
            let bool_type_val = getConstantEntryValue(this.model!.boolType)
            carbon_type_map.set(bool_type_val, new BoolType(bool_type_val))

            // Ints
            let int_type_val = getConstantEntryValue(this.model!.intType)
            carbon_type_map.set(int_type_val, new IntType(int_type_val))

            // Perms
            let perm_type_val = getConstantEntryValue(this.model!.permType)
            carbon_type_map.set(perm_type_val, new PermType(perm_type_val))

            // Sets
            let map_type_entries = this.getEntriesViaRegExp(/MapType\d+Type/)  // FIXME
            // map_type_entries.map(map_type_entry => {})
            // let set_of_refs_type_val = this.appleEntry(this.model!.)

            this.carbon_type = (value: string) => {
                if (carbon_type_map.has(value)) {
                    let typ = carbon_type_map.get(value)!
                    return typ
                } else {
                    let new_type = new OtherType(value)
                    carbon_type_map.set(value, new_type)
                    return new_type
                }
            }

        } else {
            // FIXME: default types are never cached

            let silicon_type_cache = new Map<string, ViperType>()

            let viper_Bool_type = new BoolType()
            silicon_type_cache.set("true", viper_Bool_type)
            silicon_type_cache.set("false", viper_Bool_type)
            
            silicon_type_cache.set("$Snap.unit", new OtherType("$Snap.unit"))

            let viper_Int_type = new IntType()
            let viper_Ref_type = new RefType()
            let viper_Perm_type = new PermType()

            silicon_type_cache.set("$Ref", viper_Ref_type)
            silicon_type_cache.set("Set<$Ref>", new SetType(undefined, viper_Ref_type))

            this.silicon_type = (value: string) => {
                if (silicon_type_cache.has(value)) {
                    let typ = silicon_type_cache.get(value)!
                    return typ
                } else {
                    let int_rep = parseInt(value)
                    let float_rep = parseInt(value)
                    if (float_rep !== float_rep) {
                        // Non-numeric value (uninterpreted)
                        let m = value.match(/(.*)!val!\d+/)
                        
                        if (!m || !m[1]) {
                            throw `cannot deduce value type for '${value}'`
                        }
                        let typename = m[1]
                        if (silicon_type_cache.has(typename)) {
                            return silicon_type_cache.get(typename)!
                        } else {
                            let new_type = new OtherType(typename)
                            silicon_type_cache.set(typename, new_type)
                            return new_type
                        }
                        
                    } else if (int_rep === float_rep) {
                        // Integer value
                        silicon_type_cache.set(value, viper_Int_type)
                        return viper_Int_type
                        
                    } else {
                        // Floating point value (permission amount)
                        silicon_type_cache.set(value, viper_Perm_type)
                        return viper_Perm_type
                    }
                }
            }
        }
    }

    private getInnerValueType(innerval: string): ViperType {
        if (this.isCarbon()) {
            let type_map = (<MapEntry> this.model!.type)
            let type_val = this.appleEntry(type_map, [innerval])
            let viper_type = this.carbon_type!(type_val)
            if (viper_type) {
                return viper_type
            } else {
                // FIXME
                return {typename: 'UnsupportedType', innerval: '-1'}
            }
        } else {
            return this.silicon_type!(innerval)
        }
    }
}
