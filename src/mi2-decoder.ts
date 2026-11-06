import * as Debugger from './debugger';
import {MINode} from './parser.mi2';

export function decodeFileSymbols(node: MINode): Debugger.FileSymbols {
    return {
        filename: MINode.valueOf(node, "filename"),
        fullname: MINode.valueOf(node, "fullname"),
        symbols: MINode.valueOf(node, "symbols").map(decodeSymbol),
    }
}

export function decodeSymbol(node: MINode): Debugger.Symbol {
    return {
        line: parseInt(MINode.valueOf(node, "line")),
        name: MINode.valueOf(node, "name"),
        type: MINode.valueOf(node, "type"),
        description: MINode.valueOf(node, "description"),
    }
}