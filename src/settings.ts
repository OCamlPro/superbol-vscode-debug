import * as vscode from 'vscode';

export class DebuggerSettings {
    private readonly debugSettings: vscode.WorkspaceConfiguration;

    constructor() {
        this.debugSettings = vscode.workspace.getConfiguration("superbol.debugger");
        if (!this.debugSettings.has("gdbPath")) {
            this.debugSettings = vscode.workspace.getConfiguration("superbol-vscode-debug");    
        }
    }

    public get displayVariableAttributes(): boolean {
        return this.debugSettings.get<boolean>("displayVariableAttributes");
    }

    public get gdbPath(): string {
        return this.debugSettings.get<string>("gdbPath");
    }

    public get libcobPath(): string {
        return this.debugSettings.get<string>("libcobPath");
    }

    public get cobcrunPath(): string {
        return this.debugSettings.get<string>("cobcrunPath");
    }

}

export const accessors = new DebuggerSettings();