import * as vscode from "vscode";
import {GDBDebugSession} from "./gdb";
import {CoverageStatus} from './coverage';
import {DebuggerSettings} from "./settings";
import { EvaluatableExpressionProvider, TextDocument, Position, EvaluatableExpression, ProviderResult, window, Range } from "vscode";

/** Max column index to retrieve line content */
const MAX_COLUMN_INDEX = 300;
/** Array of COBOL Reserved words */
const COBOL_RESERVED_WORDS = ["perform", "move", "to", "set", "add", "subtract", "call", "inquire", "modify", "invoke", "if", "not", "end-if", "until", "varying", "evaluate", "true", "when", "false", "go", "thru", "zeros", "spaces", "zero", "space", "inspect", "tallying", "exit", "paragraph", "method", "cycle", "from", "by", "and", "or", "of", "length", "function", "program", "synchronized", "end-synchronized", "string", "end-string", "on", "reference", "value", "returning", "giving", "replacing", "goback", "all", "open", "i-o", "input", "output", "close", "compute", "unstring", "using", "delete", "start", "read", "write", "rewrite", "with", "lock", "else", "upper-case", "lower-case", "display", "accept", "at", "clear-screen", "initialize", "line", "col", "key", "is", "self", "null", "stop", "run", "upon", "environment-name", "environment-value"]

export function activate(context: vscode.ExtensionContext) {
    const provider = new GdbConfigurationProvider();
    const factory = new GdbAdapterDescriptorFactory(new CoverageStatus(), new GDBDebugSession());
    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider('superbol-gdb', provider),
        vscode.debug.registerDebugAdapterDescriptorFactory('superbol-gdb', factory, vscode.DebugConfigurationProviderTriggerKind.Dynamic),
        vscode.languages.registerEvaluatableExpressionProvider('GnuCOBOL', new GnuCOBOLEvalExpressionFactory()),
        vscode.languages.registerEvaluatableExpressionProvider('GnuCOBOL31', new GnuCOBOLEvalExpressionFactory()),
        vscode.languages.registerEvaluatableExpressionProvider('GnuCOBOL3.1', new GnuCOBOLEvalExpressionFactory()),
        vscode.languages.registerEvaluatableExpressionProvider('GnuCOBOL32', new GnuCOBOLEvalExpressionFactory()),
        vscode.languages.registerEvaluatableExpressionProvider('GnuCOBOL3.2', new GnuCOBOLEvalExpressionFactory()),
        vscode.languages.registerEvaluatableExpressionProvider('COBOL', new GnuCOBOLEvalExpressionFactory()),
        factory,
    );
}

export function deactivate() {
}

class GdbConfigurationProvider implements vscode.DebugConfigurationProvider {
    public resolveDebugConfiguration(_folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, _token?: vscode.CancellationToken): vscode.ProviderResult<vscode.DebugConfiguration> {
        config.gdbargs = ["-q", "--interpreter=mi2"];
        const settings = new DebuggerSettings();
        if (config.name === undefined) {
            config.name = "SuperBOL: default debug";
        }
        if (config.type === undefined) {
            config.type = "superbol-gdb";
        }
        if (config.request === undefined) {
            config.request = "launch";
        }
        if (config.preLaunchTask === undefined) {
            config.preLaunchTask = "SuperBOL: build (debug)";
        } else if (config.preLaunchTask === "none" ||
                   config.preLaunchTask === "") {
            delete config.preLaunchTask;
        }
        if (config.target === undefined) {
            config.target = "${file}";
        }
        if (config.arguments === undefined) {
            config.arguments = "";
        }
        if (config.cwd === undefined) {
            config.cwd = "${workspaceFolder}";
        }
        if (config.group === undefined) {
            config.group = [];
        }
        if (config.gdbpath === undefined) {
            config.gdbpath = settings.gdbpath;
        }
        if (config.libcobpath === undefined) {
            config.libcobpath = settings.libcobpath;
        }
        if (config.env === undefined) {
            config.env = { ["LD_LIBRARY_PATH"] : config.libcobpath };
        } else {
            config.env.LD_LIBRARY_PATH = config.libcobpath + ";" + config.env.LD_LIBRARY_PATH;
        }
        if (config.coverage === undefined) {
            config.coverage = false;
        }
        if (config.gdbtty === undefined) {
            config.gdbtty = true;
        }
        return config;
    }

    public provideDebugConfigurations(
      _folder: vscode.WorkspaceFolder,
      _token?: vscode.CancellationToken):
        vscode.ProviderResult<vscode.DebugConfiguration[]> {
        const launchConfigDefault: vscode.DebugConfiguration = {
          name: "SuperBOL: debug (launch)",
          type: "superbol-gdb",
          request: "launch",
          preLaunchTask: "SuperBOL: build (debug)",
          target: "${file}",
          arguments: "",
          cwd: "${workspaceFolder}",
          group: [],
          coverage: false,
          verbose: false,
          gdbtty: true
        };

        const attachLocalConfiguration: vscode.DebugConfiguration = {
          name: "SuperBOL: debug (attach local)",
          type: "superbol-gdb",
          request: "attach",
          pid: "${input:pid}",
          target: "${file}",
          arguments: "",
          cwd: "${workspaceFolder}",
          group: [],
          verbose: false
        };

        const attachRemoteConfiguration: vscode.DebugConfiguration = {
          name: "SuperBOL: debug (attach remote)",
          type: "superbol-gdb",
          request: "attach",
          "remote-debugger": "${input:remote-debugger}",
          target: "${file}",
          arguments: "",
          cwd: "${workspaceFolder}",
          group: [],
          verbose: false
        }

        return [
          launchConfigDefault,
          attachLocalConfiguration,
          attachRemoteConfiguration
        ];
    }
}

class GdbAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
    constructor(public coverageBar: CoverageStatus, public debugSession: GDBDebugSession) {
    }

    createDebugAdapterDescriptor(_session: vscode.DebugSession): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        this.debugSession.coverageStatus = this.coverageBar;
        return new vscode.DebugAdapterInlineImplementation(this.debugSession);
    }
}

class GnuCOBOLEvalExpressionFactory implements EvaluatableExpressionProvider {

	provideEvaluatableExpression(document: TextDocument, position: Position): ProviderResult<EvaluatableExpression> {
		let txtLine = this.getDocumentLine(document, position);
        if(txtLine.startsWith("      *")) return undefined;
		const selectionRange = this.getSelectionRangeInEditor();
		if (selectionRange) {
			return new EvaluatableExpression(selectionRange);
		}
		const wordRange = document.getWordRangeAtPosition(position)
        const txtToEval = document.getText(wordRange);
        if (COBOL_RESERVED_WORDS.indexOf(txtToEval.toLowerCase()) >= 0) {
			return undefined;
		}
        let txtRegex = new RegExp(".*\\*>.*"+txtToEval+".*$", "i");
        let match = txtRegex.exec(txtLine);
        if(match){
            const posToCompare = new Position(position.line, txtLine.indexOf("*>"));
            if(wordRange.end.isAfter(posToCompare))
                return undefined;            
        }
        // TODO: Do not use a global variable
        const variableName =  globalThis.varGlobal.filter(it => it.children.toLowerCase() === txtToEval.toLowerCase());    
        if(variableName && variableName.length>0){
            return new EvaluatableExpression(wordRange, variableName[0].father);
        }
        return wordRange ? new EvaluatableExpression(wordRange) : undefined;
	}

	/**
	 * Return line text
	 *
	 * @param document document which is being evaluated
	 * @param position position of the current line
	 */
	private getDocumentLine(document: TextDocument, position: Position): string {
		const start = new Position(position.line, 0);
		const end = new Position(position.line, MAX_COLUMN_INDEX);
		const range = new Range(start, end);
		return document.getText(range);
	}

	/**
	 * Returns the range selected by the user on editor, or undefined when there is
	 * no selection
	 */
	private getSelectionRangeInEditor(): Range | undefined {
		const textEditor = window.activeTextEditor;
		if (textEditor) {
			const startRange = textEditor.selection.start;
			const endRange = textEditor.selection.end;
			if (startRange.compareTo(endRange) !== 0) {
				return new Range(startRange, endRange);
			}
		}
		return undefined;
	}

}
