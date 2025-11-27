import { Breakpoint, IDebugger, MIError, Stack, Thread, DebuggerVariable, FileSymbols, Symbol } from "./debugger";
import * as ChildProcess from "child_process";
import { EventEmitter } from "events";
import { MINode, parseMI } from './parser.mi2';
import * as MI2Decoder from './mi2-decoder';
import * as path from "path";
import * as fs from "fs";
import { SourceMap } from "./parser.c";
import { parseExpression, cleanRawValue } from "./functions";
import * as vscode from 'vscode';
import {DebugProtocol} from '@vscode/debugprotocol';
import * as log from './log';

const nonOutput = /(^(?:\d*|undefined)[*+\-=~@&^])([^*+\-=~@&]+[a-zA-Z]+)/;
const gdbRegex = /(?:\d*|undefined)\(gdb\)/;
const numRegex = /\d+/;
const gcovRegex = /"([0-9a-z_\-/\s\\:]+\.o)"/gi;
let NEXT_TERM_ID = 1;
// 002 - stepOver in routines with "perform"
let subroutine = -1;
// 002

export function escape(str: string) {
    return str.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

export function couldBeOutput(line: string) {
    return !nonOutput.exec(line);
}

enum failure_handling { Report_n_reject, Suppress, Silence }

export class MI2 extends EventEmitter implements IDebugger {
    private map: SourceMap;
    private gcovFiles: Set<string> = new Set<string>();
    public procEnv: NodeJS.ProcessEnv;
    private currentToken = 1;
    private handlers: { [index: number]: (_: MINode) => unknown } = {};
    private breakpoints: Map<Breakpoint, number> = new Map();
    private ignoredBreakpoints: Set<Breakpoint> = new Set();
    private buffer: string;
    private errbuf: string;
    private process: ChildProcess.ChildProcess;
    private lastStepCommand: () => Thenable<boolean>;
    private hasCobGetFieldStringFunction = true;
    private hasCobPutFieldStringFunction = true;

    constructor(public gdbpath: string, public gdbArgs: string[], procEnv: NodeJS.ProcessEnv, public noDebug: boolean, public gdbtty: boolean, public cobcrunPath: string, public useCobcrun: boolean, public sourceDirs: string[]) {
        super();
        if (procEnv) {
            this.procEnv = {...process.env, ...procEnv};
        }
    }

    load(cwd: string, target: string, targetargs: string, group: string[], gdbtty: boolean): Thenable<unknown> {
        return new Promise(async (resolve, reject) => {
            if (!fs.existsSync(cwd)) {
                reject(new Error("cwd does not exist."));
            }

                let target_no_ext = target.split('.').slice(0, -1).join('.');
                this.gcovFiles.add(target_no_ext);
                try {
                    this.map = new SourceMap(cwd, [target].concat(group), this.sourceDirs);
                } catch (e) {
                    log.error((<Error>e).toString());
                }

                log.debug(() => this.map.toString("created"));

                if (!this.useCobcrun) {
                    target = path.resolve(cwd, path.basename(target));
                    target = target.split('.').slice(0, -1).join('.');
                    // FIXME: the following should prefix "cobcrun.exe" if in "module mode", see #13
                    // FIXME: if we need this code twice then add a comment why, otherwise move to a new function
                    if (process.platform === "win32") {
                        target = target + '.exe';
                    }
                }

                // 001-gdbtty - Extension for debugging on a separate tty using xterm - start
                let gdbttyParameters = [];
                if (gdbtty) {
                    await this.gbdTtyTerminal(gdbtty, target, gdbttyParameters);
                }
                // 001-gdbtty-End

                this.process = ChildProcess.spawn(this.gdbpath, this.gdbArgs, { cwd: cwd, env: this.procEnv });
                this.process.stdout.on("data", (data: string) => this.stdout(data));
                this.process.stderr.on("data", (data: string) => this.stderr(data));
                this.process.on("exit", (() => { this.emit("quit"); }));
                this.process.on("error", (err) => { this.emit("launcherror", err); });
                const promises = this.initCommands(target, targetargs, cwd, this.useCobcrun);
                // 001-gdbtty - additional parameters for gdb
                for (let item of gdbttyParameters)
                    promises.push(this.sendCommand("gdb-set " + item));
                //001
                Promise.all(promises).then(() => {
                    this.emit("debug-ready");
                    resolve(true);
                }, reject);

        });
    }

    attach(cwd: string, target: string, targetargs: string, group: string[]): Thenable<unknown> {
        if (!path.isAbsolute(target)) {
            target = path.join(cwd, target);
        }

        return new Promise((resolve, reject) => {
            if (!fs.existsSync(cwd)) {
                reject(new Error("cwd does not exist."));
            }

                try {
                    this.map = new SourceMap(cwd, [target].concat(group), this.sourceDirs);
                } catch (e) {
                    log.error((<Error>e).toString());
                }

                log.debug(() => this.map.toString("created"));

                target = path.resolve(cwd, path.basename(target));
                target = target.split('.').slice(0, -1).join('.');
                // FIXME: the following should prefix "cobcrun.exe" if in "module mode", see #13
                if (process.platform === "win32") {
                    target = target + '.exe';
                }

                this.process = ChildProcess.spawn(this.gdbpath, this.gdbArgs, { cwd: cwd, env: this.procEnv });
                this.process.stdout.on("data", (data: string) => this.stdout(data));
                this.process.stderr.on("data", (data: string) => this.stderr(data));
                this.process.on("exit", () => { this.emit("quit"); });
                this.process.on("error", (err) => { this.emit("launcherror", err); });
                const promises = this.initCommands(target, targetargs, cwd, false);
                Promise.all(promises).then(() => {
                    this.emit("debug-ready");
                    resolve(true);
                }, reject);

        });
    }

    protected initCommands(target: string, targetargs: string, cwd: string, useCobcrun: boolean) {
        if (!path.isAbsolute(target)) {
            target = path.join(cwd, target);
        }
        if (process.platform === "win32") {
            cwd = path.dirname(target);
        }

        let targetExec = escape(target);
        if (useCobcrun) {
            targetargs = `-m ${targetExec} ${targetargs}`
            targetExec = this.cobcrunPath;
        }

        const cmds = [
            this.sendCommand("gdb-set mi-async on"),
            this.sendCommand("gdb-set print repeats 1000"),
            this.sendCommand("gdb-set args " + targetargs),
            this.sendCommand("gdb-set charset UTF-8"),
            this.sendCommand("environment-directory \"" + escape(cwd) + "\""),
            this.sendCommand("file-exec-and-symbols \"" + targetExec + "\""),
            this.sendCommand("gdb-set stop-on-solib-events 1"),
            this.sendCommand("gdb-set directories \"" + this.map.sourceDirs.join('" "') + "\"")
        ];

        return cmds;
    }

    stdout(data: string) {
        log.debug("stdout: " + data);
        this.buffer += data;
        const end = this.buffer.lastIndexOf('\n');
        if (end != -1) {
            this.onOutput(this.buffer.substring(0, end));
            this.buffer = this.buffer.substring(end + 1);
        }
        if (this.buffer.length) {
            if (this.onOutputPartial(this.buffer)) {
                this.buffer = "";
            }
        }
    }

    stderr(data: string) {
        log.debug("stderr: " + data);
        this.errbuf += data;
        const end = this.errbuf.lastIndexOf('\n');
        if (end != -1) {
            this.onOutputStderr(this.errbuf.substring(0, end));
            this.errbuf = this.errbuf.substring(end + 1);
        }
        if (this.errbuf.length) {
            this.logNoNewLine("stderr", this.errbuf);
            this.errbuf = "";
        }
    }

    stdin(data: string, cb?: (_err: Error) => void) {
        if (this.isReady()) {
            log.debug("stdin: " + data);
            this.process.stdin.write(data + "\n", cb);
        }
    }

    onOutputStderr(lines: string) {
        const linesArr = lines.split('\n');
        linesArr.forEach(line => {
            this.log("stderr", line);
        });
    }

    onOutputPartial(line: string) {
        if (couldBeOutput(line)) {
            this.logNoNewLine("stdout", line);
            return true;
        }
        return false;
    }

    private onOutput(linesStr: string) {
        const lines = linesStr.split('\n');
        lines.forEach(line => {
            if (couldBeOutput(line)) {
                if (!gdbRegex.exec(line)) {
                    this.log("stdout", line);
                }
            } else {
                this.onMINode(parseMI(line));
            }
        });
    }

    private onMINode(parsed: MINode) {
        let handled = false;
        if (parsed && parsed.token !== undefined) {
            if (this.handlers[parsed.token]) {
                this.handlers[parsed.token](parsed);
                delete this.handlers[parsed.token];
                handled = true;
            }
        }
        if (!handled && parsed.resultRecords && parsed.resultRecords.resultClass == "error") {
            this.log("stderr", <string>parsed.result("msg"));
        }
        if (parsed.outOfBandRecord) {
            parsed.outOfBandRecord.forEach(async record => {
                if (record.isStream) {
                    this.log(record.type, record.content);
                } else {
                    if (record.type == "exec") {
                        this.emit("exec-async-output", parsed);
                        // 002 - stepOver in routines with "perform"
                        subroutine = this.map.hasLineSubroutine(parsed.record('frame.fullname'), parseInt(parsed.record('frame.line')));
                        // 002
                        if (record.asyncClass == "running") {
                            this.emit("running", parsed);
                        } else if (record.asyncClass == "stopped") {
                            const reason = <string>parsed.record("reason");
                            log.debug("stop:", reason);
                            if (reason == "breakpoint-hit") {
                                if (!this.map.hasLineCobol(parsed.record('frame.fullname'), parseInt(parsed.record('frame.line')))) {
                                    if (this.lastStepCommand == this.continue && parsed.record("disp") == "del")
                                        void this.lastStepCommand();
                                    else
                                        this.stepOver(); // 002 - stepInto/stepOut in routines with "perform" 
                                } else {
                                    this.emit("step-end", parsed);
                                }
                            } else if (reason == "location-reached") { // 002 - stepOver in routines with "perform" 
                                if (!this.map.hasLineCobol(parsed.record('frame.fullname'), parseInt(parsed.record('frame.line')))) {
                                    this.stepOver();
                                } else {
                                    this.emit("step-end", parsed);
                                }
                            } else if (reason == "end-stepping-range") {
                                if (!this.map.hasLineCobol(<string>parsed.record('frame.fullname'), parseInt(<string>parsed.record('frame.line')))) {
                                    void this.lastStepCommand().then();
                                } else {
                                    this.emit("step-end", parsed);
                                }
                            } else if (reason == "function-finished") {
                                if (!this.map.hasLineCobol(<string>parsed.record('frame.fullname'), parseInt(<string>parsed.record('frame.line')))) {
                                    void this.lastStepCommand();
                                } else {
                                    this.emit("step-out-end", parsed);
                                }
                            } else if (reason == "signal-received") {
                                this.emit("signal-stop", parsed);
                            } else if (reason == "exited-normally") {
                                this.emit("exited-normally", parsed);
                            } else if (reason == "exited") { // exit with error code != 0
                                log.info("Program exited with code " + <string>parsed.record("exit-code"));
                                this.emit("quit", parsed);
                            } else if (reason == "solib-event") {
                                this.onSolibEvent(parsed);
                                this.resume();
                            } else {
                                if (!this.map.hasLineCobol(<string>parsed.record('frame.fullname'), parseInt(<string>parsed.record('frame.line')))) {
                                    void this.continue();
                                } else {
                                    log.error("Not implemented stop reason (assuming exception):", reason);
                                    this.emit("stopped", parsed);
                                }
                            }
                        } else {
                            log.debug(() => JSON.stringify(parsed));
                        }
                    } else if (record.type == "notify") {
                        if (record.asyncClass == "thread-created") {
                            this.emit("thread-created", parsed);
                        } else if (record.asyncClass == "thread-exited") {
                            this.emit("thread-exited", parsed);
                        } else if (record.asyncClass == "library-loaded") {
                            // Possibly unreachable if `stop-on-solib-events` is on; still handle in case.
                            let libname = record.output.find((e) => e[0] == "target-name")?.[1];
                            if (this.map.addLib(libname)) {
                                log.debug(() => `Added library to map: ${libname}`);
                                log.debug(() => this.map.toString("updated"));
                                this.reloadBreakPoints();
                            }
                        } else if (record.asyncClass == "library-unloaded") {
                            // Ditto: possibly unreachable if `stop-on-solib-events` is on; still handle in case.
                            let libname = record.output.find((e) => e[0] == "target-name")?.[1];
                            if (this.map.remLib(libname)) {
                                log.debug(() => this.map.toString("updated"));
                                this.reloadBreakPoints();
                            }
                        } else {
                            log.debug(() => JSON.stringify(parsed));
                        }
                    }
                }
            });
            handled = true;
        }
        if (parsed.token == undefined && parsed.resultRecords == undefined && parsed.outOfBandRecord.length == 0) {
            handled = true;
        }
        if (!handled) {
            log.error("Unhandled: " + JSON.stringify(parsed));
        }
    }

    private onSolibEvent(node: MINode): void {
        const added: [string, any][] = node.record("added") ?? [];
        const removed: [string, any][] = node.record("removed") ?? [];
        const isLib = (lib: [string, any]) => lib[0] == "library";
        let libsChanged = false;
        libsChanged = added.filter(isLib).reduce((libsChanged, lib) => {
            log.debug("loaded library:", lib[1]);
            return this.map.addLib(lib[1]) || libsChanged;
        }, libsChanged);
        libsChanged = removed.filter(isLib).reduce((libsChanged, lib) => {
            log.debug("unloaded library:", lib[1]);
            return this.map.remLib(lib[1]) || libsChanged;
        }, libsChanged);
        if (libsChanged) {
            log.debug (() => this.map.toString ("updated"));
            this.reloadBreakPoints ();
        }
    }

    start(attachTarget?: string): Thenable<boolean> {
        let command = "exec-run";
        let expectingResultClass = "running";
        return new Promise((resolve, reject) => {
            if (!!this.noDebug) { // running with external gdbtty
                this.sendCommand(command).then((info) => {
                    if (info.resultRecords.resultClass == expectingResultClass) {
                        resolve(false);
                    } else {
                        reject();
                    }
                }, reject);
                return;
            }
            this.once("ui-break-done", () => {
                if (!!attachTarget) {
                    if (/^\d+$/.test(attachTarget)) {
                        command = `target-attach ${attachTarget}`;
                        expectingResultClass = "done";
                    } else {
                        command = `target-select remote ${attachTarget}`;
                        expectingResultClass = "connected";
                    }
                }

                this.sendCommand(command).then((info) => {
                    if (info.resultRecords.resultClass == expectingResultClass) {
                        resolve(false);
                    } else {
                        reject();
                    }
                }, reject);
            });
        });
    }

    stop() {
        const proc = this.process;
        if (proc) {
            const to = setTimeout(() => {
                process.kill(-proc.pid);
            }, 1000);
            this.process.on("exit", function (_code) {
                clearTimeout(to);
            });
        }
        void this.sendCommand("gdb-exit");
    }

    detach() {
        const proc = this.process;
        if (proc) {
            const to = setTimeout(() => {
                process.kill(-proc.pid);
            }, 1000);
            this.process.on("exit", function (_code) {
                clearTimeout(to);
            });
        }
        void this.sendCommand("target-detach");
    }

    interrupt(): Thenable<boolean> {
        log.debug("interrupt");
        return new Promise((resolve, reject) => {
            this.sendCommand("exec-interrupt").then((info) => {
                resolve(info.resultRecords.resultClass == "done");
            }, reject);
        });
    }

    continue(): Thenable<boolean> {
        this.lastStepCommand = () => this.continue();
        log.debug("continue");
        return new Promise((resolve, reject) => {
            this.sendCommand("exec-continue").then((info) => {
                resolve(info.resultRecords.resultClass == "running");
            }, reject);
        });
    }

    private resume () {
        if (this.lastStepCommand != undefined) {
            void this.lastStepCommand ();
        } else {
            void this.continue ();
        }
    }

    /**
     * The command executes the line, then pauses at the next line.
     * The underlying function executes entirely.
     * FIXME: Implement execution graph instead of exec-next fallback
     */
    // 002 - stepOver in routines with "perform"
    stepOver(): Thenable<boolean> {
        this.lastStepCommand = () => this.stepOver();
        log.debug("stepOver");
        if (subroutine >= 0) {
            return new Promise((resolve, reject) => {
                this.sendCommand("exec-until " + subroutine).then((info) => {
                    resolve(info.resultRecords.resultClass == "running");
                }, reject);
            });
        } else {
            return new Promise((resolve, reject) => {
                this.sendCommand("exec-next").then((info) => {
                    resolve(info.resultRecords.resultClass == "running");
                }, reject);
            });
        }
    }
    // 002

    /**
     * The command executes the line, then pauses at the next line.
     * The command goes into the underlying function, then pauses at the first line.
     */
    stepInto(): Thenable<boolean> {
        this.lastStepCommand = () => this.stepInto() ;
        log.debug("stepInto");
        // 002 - stepInto/setpOut in routines with "perform"
        if (subroutine >= 0) {
            return new Promise((resolve, reject) => {
                this.sendCommand("break-insert -t " + subroutine).then(() => {
                    this.sendCommand("exec-step").then((info) => {
                        resolve(info.resultRecords.resultClass == "running");
                    }, reject);
                }, reject);
            });
        } else {
            return new Promise((resolve, reject) => {
                this.sendCommand("exec-step").then((info) => {
                    resolve(info.resultRecords.resultClass == "running");
                }, reject);
            });
        }
        // 002
    }

    /**
     * The comand executes the function, then pauses at the next line outside.
     */
    stepOut(): Thenable<boolean> {
        this.lastStepCommand = () => this.stepOut() ;
        log.debug("stepOut");
        return new Promise((resolve, reject) => {
            this.sendCommand("exec-finish").then((info) => {
                resolve(info.resultRecords.resultClass == "running");
            }, reject);
        });
    }

    goto(filename: string, line: number): Thenable<boolean> {
        log.debug("goto");
        return new Promise((resolve, reject) => {
            const target: string = '"' + (filename ? escape(filename) + ":" : "") + line.toString() + '"';
            this.sendCommand("break-insert -t " + target).then(() => {
                this.sendCommand("exec-jump " + target).then((info) => {
                    resolve(info.resultRecords.resultClass == "running");
                }, reject);
            }, reject);
        });
    }

    async changeVariable(name: string, rawValue: string): Promise<Array<DebugProtocol.InvalidatedAreas>> {
        log.debug("changeVariable");
        const functionName = await this.getCurrentFunctionName();
        try {
            const v = this.map.getVariableByCobol(`${functionName}.${name.toUpperCase()}`);
            return this.setDebuggerVariable(v, rawValue);
        } catch (e) {
            this.log("stderr", `Failed to set cob field value on ${functionName}.${name}`);
            this.log("stderr", (<Error>e).message);
            throw e;
        }
    }

    async changeGlobalVariable(name: string, rawValue: string): Promise<Array<DebugProtocol.InvalidatedAreas>> {
        log.debug("changeGobalVariable");
        const cobolName = name.toUpperCase();
        try {
            const v = this.map.getGlobalByCobol(cobolName);
            return this.setDebuggerVariable(v, rawValue);
        } catch (e) {
            this.log("stderr", `Failed to set cob field value on ${cobolName} (global)`);
            this.log("stderr", (<Error>e).message);
            throw e;
        }
    }

    private async setDebuggerVariable(v: DebuggerVariable, rawValue: string) : Promise<Array<DebugProtocol.InvalidatedAreas>> {
        const cleanedRawValue = cleanRawValue(rawValue);
        try {
            if (v.attribute.type === "integer") {
                await this.sendCommand(`gdb-set var ${v.cName}=${cleanedRawValue}`);
            } else if (this.hasCobPutFieldStringFunction && v.cName.startsWith("f_")) {
                await this.sendCommand(`data-evaluate-expression "(int)cob_put_field_str(&${v.cName}, \\"${cleanedRawValue}\\")"`);
            } else {
                const finalValue = v.formatValue(cleanedRawValue);
                let cName = v.cName;
                if (v.cName.startsWith("f_")) {
                    cName += ".data";
                }
                await this.sendCommand(`data-evaluate-expression "(void)strncpy(${cName}, \\"${finalValue}\\", ${v.size})"`);
            }
        } catch (e) {
            if ((<Error>e).message.includes("No symbol \"cob_put_field_str\"")) {
                this.hasCobPutFieldStringFunction = false;
                return this.setDebuggerVariable(v, rawValue);
            }
            this.log("stderr", `Failed to set cob field value on ${v.cName}`);
            throw e;
        }
        return v.parent != null || v.hasChildren() ? ['variables'] : [];
    }

    loadBreakPoints(breakpoints: Breakpoint[]): Thenable<[boolean, Breakpoint][]> {
        log.debug("loadBreakPoints");
        const promisses = [];
        breakpoints.forEach(breakpoint => {
            promisses.push(this.addBreakPoint(breakpoint));
        });
        return Promise.all(promisses);
    }

    private reloadBreakPoints(): Thenable<[boolean, Breakpoint][]> {
        // TODO: ignore previously set breakpoints after library unloading?
        // Library unloading should mostly happen at the end of executions,
        // so we can probaly let gdb deal with those (and live with the warnings).
        let breakpoints = Array.from (this.ignoredBreakpoints);
        this.ignoredBreakpoints.clear ();
        return this.loadBreakPoints (breakpoints);
    }

    setBreakPointCondition(bkptNum: number, condition: string): Thenable<any> {
        log.debug("setBreakPointCondition");
        return this.sendCommand("break-condition " + bkptNum.toString() + " " + condition);
    }

    addBreakPoint(breakpoint: Breakpoint): Thenable<[boolean, Breakpoint]> {
        log.debug("addBreakPoint");

        return new Promise((resolve, reject) => {
            if (this.breakpoints.has(breakpoint)) {
                return resolve([false, undefined]);
            }
            let location = "";
            if (breakpoint.countCondition) {
                if (breakpoint.countCondition[0] == ">") {
                    location += "-i " + numRegex.exec(breakpoint.countCondition.substring(1))[0] + " ";
                } else {
                    const match = numRegex.exec(breakpoint.countCondition)[0];
                    if (match.length != breakpoint.countCondition.length) {
                        this.log("stderr", "Unsupported break count expression: '" + breakpoint.countCondition + "'. Only supports 'X' for breaking once after X times or '>X' for ignoring the first X breaks");
                        location += "-t ";
                    } else if (parseInt(match) != 0) {
                        location += "-t -i " + parseInt(match).toString() + " ";
                    }
                }
            }

            const map = this.map.getLineC(breakpoint.file, breakpoint.line);
            if (map.fileC === '' && map.lineC === 0) {
                log.debug (() => [
                    "addBreakPoint: ignoring breakpoint for unknown source file:",
                    JSON.stringify(breakpoint)
                ]);
                this.ignoredBreakpoints.add(breakpoint);
                return;
            }

            if (breakpoint.raw) {
                location += '"' + escape(breakpoint.raw) + '"';
            } else {
                location += '"' + escape(map.fileC) + ":" + map.lineC.toString() + '"';
            }

            this.sendCommand("break-insert -f " + location).then((result) => {
                if (result.resultRecords.resultClass == "done") {
                    const bkptNum = parseInt(<string>result.result("bkpt.number"));
                    const bkptlocation = (<string>result.result("bkpt.original-location")).split(':');
                    const map = this.map.getLineCobol(bkptlocation[0], parseInt(bkptlocation[1]));
                    const newBrk = {
                        file: map.fileCobol,
                        line: map.lineCobol,
                        condition: breakpoint.condition
                    };
                    if (breakpoint.condition) {
                        this.setBreakPointCondition(bkptNum, breakpoint.condition).then((result: MINode) => {
                            if (result.resultRecords.resultClass == "done") {
                                this.breakpoints.set(newBrk, bkptNum);
                                resolve([true, newBrk]);
                            } else {
                                resolve([false, undefined]);
                            }
                        }, reject);
                    } else {
                        this.breakpoints.set(newBrk, bkptNum);
                        resolve([true, newBrk]);
                    }
                } else {
                    reject(result);
                }
            }, reject);
        });
    }

    removeBreakPoint(breakpoint: Breakpoint): Thenable<boolean> {
        log.debug("removeBreakPoint");
        return new Promise((resolve, _reject) => {
            if (!this.breakpoints.has(breakpoint)) {
                if (this.ignoredBreakpoints.has(breakpoint)) {
                    this.ignoredBreakpoints.delete(breakpoint);
                    return resolve(true);
                } else {
                    return resolve(false);
                }
            }
            this.sendCommand("break-delete " + this.breakpoints.get(breakpoint).toString()).then((result: MINode) => {
                if (result.resultRecords.resultClass == "done") {
                    this.breakpoints.delete(breakpoint);
                    resolve(true);
                } else resolve(false);
            }, (err: Error) => console.log(err));
        });
    }

    clearBreakPoints(): Thenable<unknown> {
        log.debug("clearBreakPoints");
        return new Promise((resolve, _reject) => {
            this.sendCommand("break-delete").then((result) => {
                if (result.resultRecords.resultClass == "done") {
                    this.ignoredBreakpoints.clear ();
                    this.breakpoints.clear();
                    resolve(true);
                } else {
                    resolve(false);
                }
            }, () => {
                resolve(false);
            });
        });
    }

    async getThreads(): Promise<Thread[]> {
        log.debug("getThreads");
        return new Promise((resolve, reject) => {
            if (!!this.noDebug) {
                return;
            }
            this.sendCommand("thread-info").then((result) => {
                resolve((<Thread[]>result.result("threads")).map(element => {
                    const ret: Thread = {
                        id: parseInt(<string>MINode.valueOf(element, "id")),
                        targetId: <string>MINode.valueOf(element, "target-id")
                    };
                    const name = <string>MINode.valueOf(element, "name");
                    if (name) {
                        ret.name = name;
                    }
                    return ret;
                }));
            }, reject);
        });
    }

    async getStack(maxLevels: number, thread: number): Promise<Stack[]> {
        log.debug("getStack");
        let command = "stack-list-frames";
        if (thread != 0) {
            command += ` --thread ${thread}`;
        }
        if (maxLevels) {
            command += " 0 " + maxLevels.toString();
        }
        const result = await this.sendCommand(command, failure_handling.Silence);
        if (result === undefined)
            return;
        const stack = <Stack[]>result.result("stack");
        return stack.map(element => {
            const level = MINode.valueOf(element, "@frame.level");
            const func = MINode.valueOf(element, "@frame.func");
            let file: string = MINode.valueOf(element, "@frame.fullname");
            if (file) {
                file = path.normalize(file);
            }
            const from = parseInt(MINode.valueOf(element, "@frame.from"));

            let line = 0;
            const lnstr = MINode.valueOf(element, "@frame.line");
            if (lnstr) {
                line = parseInt(lnstr);
            }

            return {
                function: func || from,
                level: level,
                line: this.map.getLineCobol(file, line)
            };
        });
    }

    async globalFileSymbols(nameFilterRegexp: string = null): Promise<FileSymbols[]> {
        const nameFilterArg = nameFilterRegexp !== null
                            ? `--name "${nameFilterRegexp}"`
                            : "";
        const resp = await this.sendCommand(`symbol-info-variables ${nameFilterArg}`,
                                            failure_handling.Silence);
        if (resp?.resultRecords.resultClass !== "done")
            return [];
        return (<any[]>resp.result("symbols.debug")).map(MI2Decoder.decodeFileSymbols);
    }

    async evalSymbol(s: Symbol): Promise<DebuggerVariable> {
        const v = this.map.getGlobalByC(s.name);
        await this.updateVariable(v);
        return v;
    }

    async getCurrentFunctionName(): Promise<string> {
        log.debug("getCurrentFunctionName");
        const response = await this.sendCommand("stack-info-frame", failure_handling.Silence);
        if (response === undefined)
            return;
        return response.result("frame.func")?.toLowerCase();
    }

    async getStackVariables(thread: number, frame: number): Promise<DebuggerVariable[]> {
        log.debug("getStackVariables");

        const functionName = await this.getCurrentFunctionName();
        if (functionName === undefined)
            return;

        const variablesResponse = await this.sendCommand(`stack-list-variables --thread ${thread} --frame ${frame} --all-values`, failure_handling.Silence);
        if (variablesResponse === undefined)
            return;

        const variables = variablesResponse.result("variables");

        const currentFrameVariables = new Set<DebuggerVariable>();
        for (const element of variables) {
            const key = MINode.valueOf(element, "name");
            const value = MINode.valueOf(element, "value");

            if (key.startsWith("b_")) {
                const cobolVariable = this.map.getVariableByC(`${functionName}.${key}`);

                if (cobolVariable) {
                    try {
                        cobolVariable.setValue(value);
                    } catch (e) {
                        this.log("stderr", `Failed to set value on ${functionName}.${key}`);
                        this.log("stderr", e.message);
                        throw e;
                    }
                    currentFrameVariables.add(cobolVariable);
                }
            }
        }
        return Array.from(currentFrameVariables);
    }

    examineMemory(from: number, length: number): Thenable<any> {
        log.debug("examineMemory");
        return new Promise((resolve, reject) => {
            this.sendCommand("data-read-memory-bytes 0x" + from.toString(16) + " " + length).then((result) => {
                resolve(result.result("memory[0].contents"));
            }, reject);
        });
    }

    async evalExpression(expression: string, thread: number, frame: number): Promise<string> {
        log.debug("evalExpression", expression);

        const functionName = await this.getCurrentFunctionName();
        if (functionName === undefined)
            return;

        let [finalExpression, variableNames] = parseExpression(expression, functionName, this.map);
        finalExpression = `return ${finalExpression};`;

        for (const variableName of variableNames) {
            const variable = this.map.getVariableByC(`${functionName}.${variableName}`);
            if (variable) {
                await this.updateVariable(variable, thread, frame);
                const value = variable.value;
                finalExpression = `const ${variableName}=${value};` + finalExpression;
            }
        }

        try {
            const result = Function(`"use strict"; ${finalExpression}`)();
            return JSON.stringify(result); // deals with escapes.
        } catch (e) {
            log.debug(e.message);
            return `Failed to evaluate ${expression}`;
        }
    }

    async evalCobField(name: string, thread: number = 0, frame: number = 0): Promise<DebuggerVariable> {
        log.debug("evalCobField", name);

        const functionName = await this.getCurrentFunctionName();
        if (functionName === undefined)
            return;

        try {
            const variable = this.map.getVariableByCobol(`${functionName}.${name.toUpperCase()}`);
            await this.updateVariable(variable, thread, frame);
            return variable;
        } catch (e) {
            this.log("stderr", `Failed to eval cob field value on ${functionName}.${name}`);
            this.log("stderr", e.message);
            throw e;
        }
    }

    async evalGlobalCobField(name: string): Promise<DebuggerVariable> {
        log.debug("evalGlobalCobField", name);

        try {
            const variable = this.map.getGlobalByCobol(name);
            await this.updateVariable(variable);
            return variable;
        } catch (e) {
            this.log("stderr", `Failed to eval cob field value on ${name}`);
            this.log("stderr", e.message);
            throw e;
        }
    }

    private async updateVariable(variable: DebuggerVariable, thread: number = 0, frame: number = 0): Promise<void> {
        log.debug("updateVariable", (() => `${variable.cName} (${variable.cobolName})`));

        let command = "data-evaluate-expression ";
        if (thread != 0) {
            command += `--thread ${thread} --frame ${frame} `;
        }

        if (this.hasCobGetFieldStringFunction && variable.cName.startsWith("f_")) {
            command += `"(char *)cob_get_field_str_buffered(&${variable.cName})"`;
        } else if (variable.cName.startsWith("f_")) {
            command += `${variable.cName}.data`;
        } else {
            command += variable.cName;
        }

        let value = null;
        try {
            let dataResponse = await this.sendCommand(command, failure_handling.Silence);
            if (dataResponse !== undefined) {
                value = dataResponse.result("value");
                if (value === "0x0") {
                    value = null;
                }
            }
        } catch (error) {
            if (error.message.includes("No symbol \"cob_get_field_str_buffered\"")) {
                this.hasCobGetFieldStringFunction = false;
                this.updateVariable(variable, thread, frame);
                return;
            }
            this.log("stderr", error.message);
        }

        if (this.hasCobGetFieldStringFunction) {
            variable.setValueUsage(value);
        } else {
            variable.setValue(value);
        }
    }

    private logNoNewLine(type: string, msg: string): void {
        this.emit("msg", type, msg);
    }

    private log(type: string, msg: string): void {
        this.emit("msg", type, msg[msg.length - 1] == '\n' ? msg : (msg + "\n"));
    }

    sendUserInput(command: string, threadId: number = 0, frameLevel: number = 0): Thenable<any> {
        return new Promise((resolve, reject) => {
            this.stdin(command, resolve);
        });
    }

    private sendCommand(command: string, on_failure: failure_handling = undefined): Thenable<MINode | undefined> {
        return new Promise((resolve, reject) => {
            const sel = this.currentToken++;
            this.handlers[sel] = (node: MINode) => {
                if (node && node.resultRecords && node.resultRecords.resultClass === "error") {
                    switch (on_failure) {
                        case failure_handling.Suppress:
                            this.log("stderr", `WARNING: Error executing command '${command}'`);
                            resolve(node);
                            break;
                        case failure_handling.Silence:
                            resolve(undefined);
                            break;
                        default:
                        case failure_handling.Report_n_reject:
                            reject(new MIError(node.result("msg") || "Internal error", command));
                            break;
                    }
                } else
                    resolve(node);
            };
            this.stdin(sel + "-" + command);
        });
    }

    isReady(): boolean {
        return !!this.process;
    }

    getGcovFiles(): string[] {
        return Array.from(this.gcovFiles);
    }

    sourceMap(): SourceMap {
        return this.map;
    }

    // 001- gdbtty - Extension for debugging on a separate tty using xterm - start
    // Create or find an external terminal -> Xterm, Vs Code Terminal or Windows Console
    async gbdTtyTerminal(gdbtty, target, gdbttyParameters) {
        if (process.platform !== "win32") {
            let xterm_device = this.findTtyName(target, gdbtty);
            const isWslSsh = vscode.env.remoteName === "wsl" || vscode.env.remoteName === "ssh-remote";
            if (xterm_device === "") {
                let sleepVal = this.hashCode(target);
                this.log('stdio', 'TTY: sleep ' + sleepVal + ';');
                // wls - const wsl_process = ChildProcess.exec("cmd.exe /c start bash -c 'sleep "+sleepVal+"'");
                if (isWslSsh) {
                    this.createTerminal("vscode", sleepVal, target);
                } else
                    this.createTerminal(gdbtty, sleepVal, target);
                const sleep = async (milliseconds) => {
                    await new Promise(resolve => setTimeout(resolve, milliseconds));
                }
                let try_find=0;
                while(try_find<4){
                    await sleep(500);
                    xterm_device = this.findTtyName(target, gdbtty);
                    try_find++;
                    if (xterm_device != "") break;
                }
                if (xterm_device === "") this.log("stderr", "tty: Install a terminal to use gdb's tty option\n");
            }
            if (xterm_device.includes("pts")) {
                this.gdbArgs.push("--tty=" + xterm_device);
                gdbttyParameters.push("env TERM=xterm");
            }
        } else {
            if ((gdbtty + "") === "vscode") this.log("stderr", "Attention! The gdbtty property with value 'vscode' is only supported on Linux. Assuming 'external'.\n");
            gdbttyParameters.push("new-console on");
        }
    }

    // Finds the TTY name in the format /dev/pts/n - gdbtty
    findTtyName(target, gdbtty): string {
        let sleepVal = this.hashCode(target);
        let fxterm_device = "";
        var result = ChildProcess.execSync("ps -u");
        let lines = result.toString().split("\n");
        for (let key1 in lines) {
            if (lines[key1].includes("sleep " + sleepVal)) {
                let pts = lines[key1].split(/\s+/);
                for (let key2 in pts) {
                    if (pts[key2].includes("pts")) {
                        fxterm_device = "/dev/" + pts[key2];
                        //Checks if the terminal is active
                        if (process.platform != "win32" && (gdbtty + "") === "vscode") {
                            if (!this.selectTerminal())
                                fxterm_device = "";
                        }
                    }
                }
            }
        }
        return fxterm_device;
    }

    // Hashcode to identify the application on sleep command - gdbtty
    hashCode(target: string): string {
        let strCode = "";
        for (var code = 0, i = 0, len = target.length; i < len; i++) {
            code = (31 * code + target.charCodeAt(i)) << 0;
        }
        if (code < 0) code *= -1;
        if (code < 900000) code + 900000;
        strCode = "" + code;
        return strCode;
    }

    isTerminalInstalled(terminalCommand: string): boolean {
        try {
            ChildProcess.execSync(`command -v ${terminalCommand}`);
            return true;
        } catch (error) {
            return false;
        }
    }

    createXFCETerminal(sleepVal, target) {
        let dispTarget = (target.length > 50) ? "..." + target.substr(target.length - 50, target.length) : target;
        let param = "bash -c 'echo \"GnuCOBOL DEBUG\"; sleep " + sleepVal + ";'";
        const xfce4_terminal_args = [
            "--title", "GnuCOBOL Debug - " + dispTarget,
            "--font=DejaVu Sans Mono 14",
            "--command", param
        ]
        const xfce_process = ChildProcess.spawn("xfce4-terminal", xfce4_terminal_args, {
            detached: true,
            stdio: 'ignore'
        });
        xfce_process.unref();
    }

    createKDETerminal(sleepVal, target) {
        let dispTarget = (target.length > 50) ? "..." + target.substr(target.length - 50, target.length) : target;
        let param = "bash -c 'echo \"GnuCOBOL DEBUG\"; sleep " + sleepVal + ";'";
        const konsole_args = [
            "--title", "GnuCOBOL Debug - " + dispTarget,
            "--separate",
            "--nofork",
            "--hold",
            "-e",
            param
        ]
        const kde_process = ChildProcess.spawn("konsole", konsole_args, {
            detached: true,
            stdio: 'ignore'
        });
        kde_process.unref();
    }

    createGNOMETerminal(sleepVal, target) {
        let dispTarget = (target.length > 50) ? "..." + target.substr(target.length - 50, target.length) : target;
        const gnome_terminal_args = [
            "--title", "GnuCOBOL Debug - " + dispTarget,
            "--",
            "bash", "-c","echo 'GnuCOBOL DEBUG';" + "sleep " + sleepVal + ";"
        ]
        const gnome_process = ChildProcess.spawn("gnome-terminal", gnome_terminal_args, {
            detached: true,
            stdio: 'ignore',
        });
        gnome_process.unref();
    }

    createXtermTerminal(sleepVal, target) {
        let dispTarget = (target.length > 50) ? "..." + target.substr(target.length - 50, target.length) : target;
        const xterm_args = [
            "-title", "GnuCOBOL Debug - " + dispTarget,
            "-fa", "DejaVu Sans Mono",
            "-fs", "14",
            "-e", "/usr/bin/tty;" +
            "echo 'GnuCOBOL DEBUG';" +
            "sleep " + sleepVal + ";"
        ]
        const xterm_process = ChildProcess.spawn("xterm", xterm_args, {
            detached: true,
            stdio: 'ignore',
        });
        xterm_process.unref();
    }

    // Opens a terminal to show the application screen - gdbtty
    createTerminal(gdbtty, sleepVal, target) {
        let findTerminal = true;
        if (gdbtty != "vscode") {
            if (typeof gdbtty === 'string' && gdbtty!="external") {  
                if(this.isTerminalInstalled(gdbtty)){
                    findTerminal = false;
                    switch (gdbtty) {
                        case "xterm":
                            this.createXtermTerminal(sleepVal, target);
                            break;
                        case "gnome-terminal":
                            this.createGNOMETerminal(sleepVal, target);
                            break;
                        case "konsole":
                            this.createKDETerminal(sleepVal, target);
                            break;
                        case "xfce4-terminal":
                            this.createXFCETerminal(sleepVal, target);
                            break;
                    }
                }
            }
            if(findTerminal){
                if(this.isTerminalInstalled("xterm")){
                    this.createXtermTerminal(sleepVal, target);
                }else if(this.isTerminalInstalled("gnome-terminal")){
                    this.createGNOMETerminal(sleepVal, target);
                }else if(this.isTerminalInstalled("xfce4-terminal")){
                    this.createXFCETerminal(sleepVal, target);
                }else if(this.isTerminalInstalled("konsole")){
                    this.createKDETerminal(sleepVal, target);
                }
            }
        } else {
            let terminal = this.selectTerminal();
            if (!terminal) {
                terminal = vscode.window.createTerminal({
                    name: `GnuCOBOL Debug Display #${NEXT_TERM_ID++}`,
                    location: vscode.window.activeTextEditor
                } as any
                );
            }
            terminal.sendText("trap '' 2;")
            terminal.sendText("clear;sleep " + sleepVal + ";");
            vscode.window.onDidCloseTerminal((terminal) => {
                vscode.window.showInformationMessage(`Terminal '${terminal.name}' was closed.`);
            });
            terminal.show();
        }
    }

    // Find the terminal used in debug in vscode - gdbtty
    selectTerminal(): vscode.Terminal | undefined {
        const terminals = <vscode.Terminal[]>(<any>vscode.window).terminals;
        let itemTerm: vscode.Terminal = undefined;
        terminals.map(t => {
            if (t.name.includes("GnuCOBOL Debug Display")) {
                itemTerm = t;
            }
        });
        return itemTerm;
    }
    // 001- gdbtty - Extension for debugging on a separate tty using xterm - start
}
