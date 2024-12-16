import {
    Range,
    workspace,
    window,
    StatusBarItem,
    TextEditorDecorationType,
    DecorationRangeBehavior,
    OverviewRulerLane,
    ThemeColor,
    StatusBarAlignment,
    Disposable,
    commands
} from "vscode";
import * as os from "os";
import * as nativePath from "path";
import * as ChildProcess from "child_process";
import {SourceMap} from "./parser.c";
import {GcovData, loadGcovData} from "./gcov";

export class CoverageStatus implements Disposable {
    private coverages: GcovData[] = [];
    private sourceMap: SourceMap;
    private statusBar: StatusBarItem = window.createStatusBarItem(StatusBarAlignment.Right, 100);
    readonly RED: TextEditorDecorationType = window.createTextEditorDecorationType({
        isWholeLine: true,
        rangeBehavior: DecorationRangeBehavior.ClosedClosed,
        outline: 'none',
        backgroundColor: 'rgba(255, 20, 20, 0.2)',
        overviewRulerColor: new ThemeColor('editorOverviewRuler.errorForeground'),
        overviewRulerLane: OverviewRulerLane.Center
    });
    readonly GREEN: TextEditorDecorationType = window.createTextEditorDecorationType({
        isWholeLine: true,
        rangeBehavior: DecorationRangeBehavior.ClosedClosed,
        outline: 'none',
        backgroundColor: 'rgba(20, 250, 20, 0.2)'
    });
    readonly COMMAND = 'gdb.coverage-toggle';
    private highlight: boolean = true;

    constructor() {
        workspace.onDidOpenTextDocument(() => {
            this.updateStatus();
        });
        workspace.onDidCloseTextDocument(() => {
            this.updateStatus();
        });
        window.onDidChangeActiveTextEditor(() => {
            this.updateStatus();
        });
        commands.registerCommand(this.COMMAND, () => {
            this.highlight = !this.highlight;
            this.updateStatus();
        });
        this.statusBar.command = this.COMMAND;
    }

    public async show(cFiles: string[], sourceMap: SourceMap) {
        this.highlight = true;
        this.coverages = await loadGcovData(cFiles);
        this.sourceMap = sourceMap;
        this.updateStatus();
    }

    public dispose() {
        this.statusBar.dispose();
    }

    public setHighlight(highlighted: boolean) {
        this.highlight = highlighted;
    }

    public hide() {
        this.highlight = false;
        this.updateStatus();
    }

    private updateStatus() {
        const editor = window.activeTextEditor;
        if (editor === undefined) {
            this.statusBar.hide();
            return;
        }
        const red: Range[] = [];
        const green: Range[] = [];
        for (const coverage of this.coverages) {
            for (const file of coverage.files) {
                for (const line of file.lines) {
                    if (this.sourceMap.hasLineCobol(file.file, line.line_number)) {
                        const map = this.sourceMap.getLineCobol(file.file, line.line_number);
                        if (editor.document.uri.fsPath !== map.fileCobol) {
                            continue;
                        }
                        const range = new Range(map.lineCobol - 1, 0, map.lineCobol - 1, Number.MAX_VALUE);
                        if (line.count > 0) {
                            green.push(range);
                        } else {
                            red.push(range);
                        }
                    }
                }
            }
        }
        if (red.length === 0 || !this.highlight) {
            editor.setDecorations(this.RED, []);
        } else {
            editor.setDecorations(this.RED, red);
        }
        if (green.length === 0 || !this.highlight) {
            editor.setDecorations(this.GREEN, []);
        } else {
            editor.setDecorations(this.GREEN, green);
        }
        this.statusBar.text = (this.highlight ? `$(eye) ` : `$(eye-closed) `) + Math.ceil(green.length * 100 / Math.max(1, red.length + green.length)) + '%';
        this.statusBar.tooltip = `Covered ${green.length} of ${red.length} lines`;
        this.statusBar.show();
    }
}
