import { v4 as uuidv4 } from "uuid";
import {
    PreventableBaklavaEvent,
    BaklavaEvent,
    SequentialHook,
    IBaklavaEventEmitter,
    IBaklavaTapable,
} from "@baklavajs/events";
import type { INodeUpdateEventData } from "./eventDataTypes";
import type { Graph } from "./graph";
import type { NodeInterfaceDefinition, NodeInterface, NodeInterfaceDefinitionStates } from "./nodeInterface";
import { mapValues } from "./utils";

export interface CalculationContext<G = any, E = unknown> {
    globalValues: G;
    engine: E;
}

export type CalculateFunctionReturnType<O> = O | Promise<O> | void;

export type CalculateFunction<I, O> = (inputs: I, context: CalculationContext) => CalculateFunctionReturnType<O>;

export interface INodeState<I, O> {
    type: string;
    title: string;
    id: string;
    inputs: NodeInterfaceDefinitionStates<I> & NodeInterfaceDefinitionStates<Record<string, NodeInterface<any>>>;
    outputs: NodeInterfaceDefinitionStates<O> & NodeInterfaceDefinitionStates<Record<string, NodeInterface<any>>>;
}

export abstract class AbstractNode implements IBaklavaEventEmitter, IBaklavaTapable {
    /** Type of the node */
    public abstract type: string;
    /** Customizable display name of the node. */
    public abstract title: string;
    /** Unique identifier of the node */
    public id: string = uuidv4();

    public abstract inputs: Record<string, NodeInterface<any>>;
    public abstract outputs: Record<string, NodeInterface<any>>;

    public events = {
        loaded: new BaklavaEvent<AbstractNode, AbstractNode>(this),
        beforeAddInput: new PreventableBaklavaEvent<NodeInterface, AbstractNode>(this),
        addInput: new BaklavaEvent<NodeInterface, AbstractNode>(this),
        beforeRemoveInput: new PreventableBaklavaEvent<NodeInterface, AbstractNode>(this),
        removeInput: new BaklavaEvent<NodeInterface, AbstractNode>(this),
        beforeAddOutput: new PreventableBaklavaEvent<NodeInterface, AbstractNode>(this),
        addOutput: new BaklavaEvent<NodeInterface, AbstractNode>(this),
        beforeRemoveOutput: new PreventableBaklavaEvent<NodeInterface, AbstractNode>(this),
        removeOutput: new BaklavaEvent<NodeInterface, AbstractNode>(this),
        update: new BaklavaEvent<INodeUpdateEventData | null, AbstractNode>(this),
    };

    public hooks = {
        beforeLoad: new SequentialHook<INodeState<any, any>, AbstractNode>(this),
        afterSave: new SequentialHook<INodeState<any, any>, AbstractNode>(this),
    };

    protected graphInstance?: Graph;

    public abstract calculate?: CalculateFunction<any, any>;

    /**
     * Add an input interface to the node
     * @param key Key of the input
     * @param input The input instance
     * @returns True when the input was added, otherwise false (prevented by an event handler)
     */
    protected addInput(key: string, input: NodeInterface): boolean {
        return this.addInterface("input", key, input);
    }

    /**
     * Add an output interface to the node
     * @param key Key of the output
     * @param output The output instance
     * @returns True when the output was added, otherwise false (prevented by an event handler)
     */
    protected addOutput(key: string, output: NodeInterface): boolean {
        return this.addInterface("output", key, output);
    }

    /**
     * Remove an existing input
     * @param key Key of the input.
     */
    protected removeInput(key: string): boolean {
        return this.removeInterface("input", key);
    }

    /**
     * Remove an existing output
     * @param key Key of the output.
     */
    protected removeOutput(key: string): boolean {
        return this.removeInterface("output", key);
    }

    /**
     * This function will automatically be called as soon as the node is added to a graph.
     * @param editor Graph instance
     */
    public registerGraph(graph: Graph): void {
        this.graphInstance = graph;
    }

    public load(state: INodeState<any, any>): void {
        this.hooks.beforeLoad.execute(state);
        this.id = state.id;
        this.title = state.title;
        Object.entries(state.inputs).forEach(([k, v]) => {
            if (this.inputs[k]) {
                this.inputs[k].load(v);
            }
        });
        Object.entries(state.outputs).forEach(([k, v]) => {
            if (this.outputs[k]) {
                this.outputs[k].load(v);
            }
        });
        this.events.loaded.emit(this as any);
    }

    public save(): INodeState<any, any> {
        const inputStates = mapValues(this.inputs, (intf) => intf.save()) as NodeInterfaceDefinitionStates<any>;
        const outputStates = mapValues(this.outputs, (intf) => intf.save()) as NodeInterfaceDefinitionStates<any>;

        const state: INodeState<any, any> = {
            type: this.type,
            id: this.id,
            title: this.title,
            inputs: inputStates,
            outputs: outputStates,
        };
        return this.hooks.afterSave.execute(state);
    }

    /**
     * @virtual
     * Override this method to execute logic when the node is placed inside a graph
     */
    public onPlaced(): void {}

    /**
     * @virtual
     * Override this method to perform cleanup when the node is deleted
     */
    public onDestroy(): void {}

    protected initializeIo() {
        Object.entries(this.inputs).forEach(([key, intf]) => this.initializeIntf("input", key, intf));
        Object.entries(this.outputs).forEach(([key, intf]) => this.initializeIntf("output", key, intf));
    }

    private initializeIntf(type: "input" | "output", key: string, intf: NodeInterface) {
        intf.isInput = type === "input";
        intf.events.setValue.subscribe(this, () => this.events.update.emit({ type, name: key, intf }));
    }

    private addInterface(type: "input" | "output", key: string, intf: NodeInterface): boolean {
        const beforeEvent = type === "input" ? this.events.beforeAddInput : this.events.beforeAddOutput;
        const afterEvent = type === "input" ? this.events.addInput : this.events.addOutput;
        const ioObject = type === "input" ? this.inputs : this.outputs;
        if (beforeEvent.emit(intf)) {
            return false;
        }
        ioObject[key] = intf;
        this.initializeIntf(type, key, intf);
        afterEvent.emit(intf);
        return true;
    }

    private removeInterface(type: "input" | "output", key: string): boolean {
        const beforeEvent = type === "input" ? this.events.beforeRemoveInput : this.events.beforeRemoveOutput;
        const afterEvent = type === "input" ? this.events.removeInput : this.events.removeOutput;
        const io = type === "input" ? this.inputs[key] : this.outputs[key];
        if (!io || beforeEvent.emit(io)) {
            return false;
        }

        if (io.connectionCount > 0) {
            if (this.graphInstance) {
                const connections = this.graphInstance.connections.filter((c) => c.from === io || c.to === io);
                connections.forEach((c) => {
                    this.graphInstance!.removeConnection(c);
                });
            } else {
                throw new Error(
                    "Interface is connected, but no graph instance is specified. Unable to delete interface",
                );
            }
        }

        io.events.setValue.unsubscribe(this);

        if (type === "input") {
            delete this.inputs[key];
        } else {
            delete this.outputs[key];
        }
        afterEvent.emit(io);
        return true;
    }
}

/**
 * Abstract base class for every node
 */
export abstract class Node<I, O> extends AbstractNode {
    public abstract inputs: NodeInterfaceDefinition<I>;
    public abstract outputs: NodeInterfaceDefinition<O>;

    public load(state: INodeState<I, O>): void {
        super.load(state);
    }

    public save(): INodeState<I, O> {
        return super.save();
    }

    /**
     * The default implementation does nothing.
     * Overwrite this method to do calculation.
     * @param inputs Values of all input interfaces
     * @param globalValues Set of values passed to every node by the engine plugin
     * @return Values for output interfaces
     */
    public calculate?: CalculateFunction<I, O>;
}

export type AbstractNodeConstructor = new () => AbstractNode;
