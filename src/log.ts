import * as vscode from "vscode";

export enum Level { Debug, Info };
export let level = Level.Info;
export function setLevel (l: Level): void {
    level = l;
}

const channel = vscode.window.createOutputChannel("SuperBOL Debugger");

export function emit(...msg: (string | (() => (string | string[])))[]) {
    channel.appendLine(msg.flatMap(f => {
        if (typeof (f) == "string") {
            return [f];
        } else {
            const r = f();
            return (typeof (r) == "string") ? [r] : r;
        }
    }).join(' '));
}

export const info = emit;

export function debug(...msg: (string | (() => (string | string[])))[]) {
    if (level == Level.Debug) {
        emit(...msg);
    }
}

export function error(...msg) {
    emit(...msg);
    channel.show();
}
