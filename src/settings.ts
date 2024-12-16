import * as vscode from 'vscode';

export class DebuggerSettings {
    private readonly debugSettings: vscode.WorkspaceConfiguration;

    constructor() {
	this.debugSettings = vscode.workspace.getConfiguration("superbol.debugger");
	//this.globalSettings = vscode.workspace.getConfiguration("superbol");
    }

    public get displayVariableAttributes(): boolean {
        return this.debugSettings.get<boolean>("display-variable-attributes");
    }

    public get gdbpath(): string {
        return this.debugSettings.get<string>("gdb-path");
    }

    public get libcobpath(): string {
        return this.debugSettings.get<string>("libcob-path");
    }

    public get gdbtty(): string {
        return this.debugSettings.get<string>("gdbtty");
    }

}
