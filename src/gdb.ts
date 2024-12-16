import * as DebugAdapter from '@vscode/debugadapter';
import {
    DebugSession,
    Handles,
    InitializedEvent,
    OutputEvent,
    Scope,
    Source,
    StackFrame,
    StoppedEvent,
    TerminatedEvent,
    Thread,
    ThreadEvent
} from '@vscode/debugadapter';
import {DebugProtocol} from '@vscode/debugprotocol';
import {Breakpoint, VariableObject} from './debugger';
import {MINode} from './parser.mi2';
import {MI2} from './mi2';
import {CoverageStatus} from './coverage';
import {DebuggerSettings} from './settings';

const STACK_HANDLES_START = 1000;
const VAR_HANDLES_START = 512 * 256 + 1000;

class ExtendedVariable {
    constructor(public _name: string, public _options: unknown) {
    }
}

export interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
    cwd: string;
    target: string;
    arguments: string;
    gdbpath: string;
    gdbargs: string[];
    env: NodeJS.ProcessEnv;
    group: string[];
    verbose: boolean;
    coverage: boolean;
    gdbtty: boolean;
}

export interface AttachRequestArguments extends DebugProtocol.LaunchRequestArguments {
    cwd: string;
    target: string;
    arguments: string;
    gdbpath: string;
    gdbargs: string[];
    env: NodeJS.ProcessEnv;
    group: string[];
    verbose: boolean;
    pid: string;
    remoteDebugger: string;
}

export class GDBDebugSession extends DebugSession {
    protected variableHandles = new Handles<string | VariableObject | ExtendedVariable>(VAR_HANDLES_START);
    protected variableHandlesReverse: { [id: string]: number } = {};
    protected useVarObjects: boolean;
    protected quit: boolean;
    protected needContinue: boolean;
    protected started: boolean;
    protected attached: boolean;
    protected crashed: boolean;
    protected debugReady: boolean;
    protected miDebugger: MI2;
    coverageStatus: CoverageStatus;
    private showVariableDetails: boolean;
    private settings = new DebuggerSettings();
    private showCoverage: boolean = true;

    protected initializeRequest(response: DebugProtocol.InitializeResponse, _args: DebugProtocol.InitializeRequestArguments): void {
        response.body.supportsSetVariable = true;
        this.sendResponse(response);
    }

    protected launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments): void {
        this.showCoverage = args.coverage;
        this.started = false;
        this.attached = false;

        this.miDebugger = new MI2(args.gdbpath, args.gdbargs, args.env, args.verbose, args.noDebug, args.gdbtty);
        this.miDebugger.on("launcherror", (err: Error) => this.launchError(err));
        this.miDebugger.on("quit", () => this.quitEvent());
        this.miDebugger.on("exited-normally", () => this.quitEvent());
        this.miDebugger.on("stopped", (info: MINode) => this.stopEvent(info));
        this.miDebugger.on("msg", (type: string, message: string) => this.handleMsg(type, message));
        this.miDebugger.on("breakpoint", (info: MINode) => this.handleBreakpoint(info));
        this.miDebugger.on("step-end", (info?: MINode) => this.handleBreak(info));
        this.miDebugger.on("step-out-end", (info?: MINode) => this.handleBreak(info));
        this.miDebugger.on("step-other", (info?: MINode) => this.handleBreak(info));
        this.miDebugger.on("signal-stop", (info: MINode) => this.handlePause(info));
        this.miDebugger.on("thread-created", (info: MINode) => this.threadCreatedEvent(info));
        this.miDebugger.on("thread-exited", (info: MINode) => this.threadExitedEvent(info));
        this.sendEvent(new InitializedEvent());
        this.quit = false;
        this.needContinue = false;
        this.crashed = false;
        this.debugReady = false;
        this.useVarObjects = false;
        this.miDebugger.load(args.cwd, args.target, args.arguments, args.group, args.gdbtty).then(
        /*onfulfilled:*/ () => {
            setTimeout(() => {
                this.miDebugger.emit("ui-break-done");
            }, 50);
            this.sendResponse(response);
            this.miDebugger.start().then(() => {
                this.started = true;
                if (this.crashed)
                    this.handlePause(undefined);
            }, (err: Error) => {
                this.sendErrorResponse(response, 100, `Failed to start MI Debugger: ${err.toString()}`);
            });
        },
        /*onrejected:*/ (err: Error) => {
            this.sendErrorResponse(response, 103, `Failed to load MI Debugger: ${err.toString()}`);
        });
    }

    protected attachRequest(response: DebugProtocol.AttachResponse, args: AttachRequestArguments): void {
        if (!args.pid && !args.remoteDebugger) {
            this.sendErrorResponse(response, 100, `Failed to start MI Debugger: PID or remote-debugger argument required`);
            return;
        }

        this.showCoverage = false;
        this.attached = true;
        this.started = false;

        this.miDebugger = new MI2(args.gdbpath, args.gdbargs, args.env, args.verbose, false, false);
        this.miDebugger.on("launcherror", (err: Error) => this.launchError(err));
        this.miDebugger.on("quit", () => this.quitEvent());
        this.miDebugger.on("exited-normally", () => this.quitEvent());
        this.miDebugger.on("stopped", (info: MINode) => this.stopEvent(info));
        this.miDebugger.on("msg", (type: string, message: string) => this.handleMsg(type, message));
        this.miDebugger.on("breakpoint", (info: MINode) => this.handleBreakpoint(info));
        this.miDebugger.on("step-end", (info?: MINode) => this.handleBreak(info));
        this.miDebugger.on("step-out-end", (info?: MINode) => this.handleBreak(info));
        this.miDebugger.on("step-other", (info?: MINode) => this.handleBreak(info));
        this.miDebugger.on("signal-stop", (info: MINode) => this.handlePause(info));
        this.miDebugger.on("thread-created", (info: MINode) => this.threadCreatedEvent(info));
        this.miDebugger.on("thread-exited", (info: MINode) => this.threadExitedEvent(info));
        this.sendEvent(new InitializedEvent());
        this.quit = false;
        this.needContinue = true;
        this.crashed = false;
        this.debugReady = false;
        this.useVarObjects = false;
        this.miDebugger.attach(args.cwd, args.target, args.arguments, args.group).then(() => {
            setTimeout(() => {
                this.miDebugger.emit("ui-break-done");
            }, 50);
            this.sendResponse(response);
            this.miDebugger.start(args.pid || args.remoteDebugger).then(() => {
                this.attached = true;
                if (this.crashed)
                    this.handlePause(undefined);
            }, (err: Error) => {
                this.sendErrorResponse(response, 100, `Failed to start MI Debugger: ${err.toString()}`);
            });
        }, (err: Error) => {
            this.sendErrorResponse(response, 103, `Failed to load MI Debugger: ${err.toString()}`);
        });
    }

    protected handleMsg(type: string, msg: string) {
        if (type == "target")
            type = "stdout";
        if (type == "log")
            type = "stderr";
        this.sendEvent(new OutputEvent(msg, type));
    }

    protected handleBreakpoint(info: MINode) {
        const event = new StoppedEvent("breakpoint", parseInt(<string>info.record("thread-id")));
        (<DebugProtocol.StoppedEvent>event).body.allThreadsStopped = info.record("stopped-threads") == "all";
        this.sendEvent(event);
    }

    protected handleBreak(info?: MINode) {
        const event = new StoppedEvent("step", info ? parseInt(<string>info.record("thread-id")) : 1);
        (<DebugProtocol.StoppedEvent>event).body.allThreadsStopped = info ? info.record("stopped-threads") == "all" : true;
        this.sendEvent(event);
    }

    protected handlePause(info: MINode) {
        const event = new StoppedEvent("user request", parseInt(<string>info.record("thread-id")));
        (<DebugProtocol.StoppedEvent>event).body.allThreadsStopped = info.record("stopped-threads") == "all";
        this.sendEvent(event);
    }

    protected stopEvent(info: MINode) {
        if (!this.started)
            this.crashed = true;
        if (!this.quit) {
            const event = new StoppedEvent("exception", parseInt(<string>info.record("thread-id")));
            (<DebugProtocol.StoppedEvent>event).body.allThreadsStopped = info.record("stopped-threads") == "all";
            this.sendEvent(event);
        }
    }

    protected threadCreatedEvent(info: MINode) {
        this.sendEvent(new ThreadEvent("started", <number>info.record("id")));
    }

    protected threadExitedEvent(info: MINode) {
        this.sendEvent(new ThreadEvent("exited", <number>info.record("id")));
    }

    protected quitEvent() {
        if (this.quit)
            return;

        if (this.showCoverage) {
            this.coverageStatus.show(this.miDebugger.getGcovFiles(), this.miDebugger.getSourceMap()).catch((err: Error) => console.log(err));
        } else {
            this.coverageStatus.hide();
        }

        this.quit = true;
        this.sendEvent(new TerminatedEvent());
    }

    protected launchError(err: Error) {
        this.handleMsg("stderr", "Could not start debugger process\n");
        this.handleMsg("stderr", err.toString() + "\n");
        this.quitEvent();
    }

    protected disconnectRequest(response: DebugProtocol.DisconnectResponse, _args: DebugProtocol.DisconnectArguments): void {
        if (this.attached)
            this.miDebugger.detach();
        else
            this.miDebugger.stop();
        this.sendResponse(response);
    }

    protected async setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): Promise<void> {
        try {
            let id: number | string | VariableObject | ExtendedVariable;
            if (args.variablesReference < VAR_HANDLES_START) {
                id = args.variablesReference - STACK_HANDLES_START;
            } else {
                id = this.variableHandles.get(args.variablesReference);
            }

            let name = args.name;
            if (typeof id == "string") {
                name = `${id}.${args.name}`;
                if (this.showVariableDetails && args.name === "value") {
                    name = id;
                }
            }
            if (!this.showVariableDetails || args.name === "value") {
                await this.miDebugger.changeVariable(name, args.value);
                response.body = {
                    value: args.value
                };
            }
            this.sendResponse(response);
        } catch (err) {
            this.sendErrorResponse(response, 11, `Could not continue: ${<string>err}`);
        }
    }

    protected setFunctionBreakPointsRequest(response: DebugProtocol.SetFunctionBreakpointsResponse, args: DebugProtocol.SetFunctionBreakpointsArguments): void {
        const cb = () => {
            this.debugReady = true;
            const all: Thenable<[boolean, Breakpoint]>[] = [];
            args.breakpoints.forEach(brk => {
                all.push(this.miDebugger.addBreakPoint({
                    raw: brk.name,
                    condition: brk.condition,
                    countCondition: brk.hitCondition
                }));
            });
            Promise.all(all).then(brkpoints => {
                const finalBrks: DebugProtocol.Breakpoint[] = [];
                brkpoints.forEach(brkp => {
                    if (brkp[0])
                        finalBrks.push({line: brkp[1].line, verified: brkp[0]});
                });
                response.body = {
                    breakpoints: finalBrks
                };
                this.sendResponse(response);
            }, (msg: Error) => {
                this.sendErrorResponse(response, 10, msg.toString());
            });
        };
        if (this.debugReady)
            cb();
        else
            this.miDebugger.once("debug-ready", cb);
    }

    protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
        const cb = () => {
            this.debugReady = true;
            this.miDebugger.clearBreakPoints().then(() => {
                const path = args.source.path;
                const all = args.breakpoints.map(brk => {
                    return this.miDebugger.addBreakPoint({
                        file: path,
                        line: brk.line,
                        condition: brk.condition,
                        countCondition: brk.hitCondition
                    });
                });
                Promise.all(all).then(brkpoints => {
                    const finalBrks: DebugAdapter.Breakpoint[] = [];
                    brkpoints.forEach(brkp => {
                        if (brkp[0])
                            finalBrks.push(new DebugAdapter.Breakpoint(true, brkp[1].line));
                    });
                    response.body = {
                        breakpoints: finalBrks
                    };
                    this.sendResponse(response);
                }, (msg: Error) => {
                    this.sendErrorResponse(response, 9, msg.toString());
                });
            }, (msg: Error) => {
                this.sendErrorResponse(response, 9, msg.toString());
            });
        };
        if (this.debugReady)
            cb();
        else
            this.miDebugger.once("debug-ready", cb);
    }

    protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
        if (!this.miDebugger) {
            this.sendResponse(response);
            return;
        }
        this.miDebugger.getThreads().then(
            threads => {
                response.body = {
                    threads: []
                };
                for (const thread of threads) {
                    let threadName = thread.name;
                    if (threadName === undefined) {
                        threadName = thread.targetId;
                    }
                    if (threadName === undefined) {
                        threadName = "<unnamed>";
                    }
                    response.body.threads.push(new Thread(thread.id, thread.id.toString() + ":" + threadName));
                }
                this.sendResponse(response);
            }, (err: Error) => {
                this.sendErrorResponse(response, 13, `Could not get threads: ${err.toString()}`)
            });
    }

    // Supports 256 threads.
    protected threadAndLevelToFrameId(threadId: number, level: number) {
        return level << 8 | threadId;
    }

    protected frameIdToThreadAndLevel(frameId: number) {
        return [frameId & 0xff, frameId >> 8];
    }

    protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
        this.miDebugger.getStack(args.levels, args.threadId).then(stack => {
            const ret: StackFrame[] = [];
            stack.forEach(element => {
                let source: Source = undefined;
                const file = element.file;
                if (file) {
                    source = new Source(element.fileName, file);
                }

                ret.push(new StackFrame(
                    this.threadAndLevelToFrameId(args.threadId, element.level),
                    element.function + "@" + element.address,
                    source,
                    element.line,
                    0));
            });
            response.body = {
                stackFrames: ret
            };
            this.sendResponse(response);
        }, (err: Error) => {
            this.sendErrorResponse(response, 12, `Failed to get Stack Trace: ${err.toString()}`);
        });
    }

    protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, _args: DebugProtocol.ConfigurationDoneArguments): void {
        if (this.needContinue) {
            this.miDebugger.continue().then(_done => {
                this.sendResponse(response);
            }, (msg: Error) => {
                this.sendErrorResponse(response, 2, `Could not continue: ${msg.toString()}`);
            });
        } else
            this.sendResponse(response);
    }

    protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
        const scopes = new Array<Scope>();
        scopes.push(new Scope("Local", STACK_HANDLES_START + (args.frameId || 0), false));

        response.body = {
            scopes: scopes
        };
        this.sendResponse(response);
    }

    protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): Promise<void> {
        this.showVariableDetails = this.settings.displayVariableAttributes;

        let id: number | string | VariableObject | ExtendedVariable;
        if (args.variablesReference < VAR_HANDLES_START) {
            id = args.variablesReference - STACK_HANDLES_START;
        } else {
            id = this.variableHandles.get(args.variablesReference);
        }

        if (typeof id == "number") {
            try {
                const variables: DebugProtocol.Variable[] = [];
                const [threadId, level] = this.frameIdToThreadAndLevel(id);
                const stackVariables = await this.miDebugger.getStackVariables(threadId, level);
                globalThis.varGlobal = [];
                for (const stackVariable of stackVariables) {
                    let reference = 0;
                    if (this.showVariableDetails || !!stackVariable.children.size) {
                        reference = this.variableHandles.create(stackVariable.cobolName);
                    }

                    let value = stackVariable.value || "null";
                    if (this.showVariableDetails) {
                        value = stackVariable.displayableType;
                    }

                    variables.push({
                        name: stackVariable.cobolName,
                        evaluateName: stackVariable.cobolName,
                        value: value,
                        type: stackVariable.displayableType,
                        variablesReference: reference
                    });
                    if(stackVariable.hasChildren){
                        const child= stackVariable.children;
                        for (var childs of stackVariable.children.entries()) {
                            var key = childs[0];
                            globalThis.varGlobal.push({
                                "children": key,
                                "father": stackVariable.cobolName
                            })
                        }
                    }
                }

                response.body = {
                    variables: variables
                };
                this.sendResponse(response);
            } catch (err) {
                this.sendErrorResponse(response, 1, `Could not expand variable: ${(<Error>err).toString()}`);
            }
        } else if (typeof id == "string") {
            try {
                // TODO: this evals on an (effectively) unknown thread for multithreaded programs.
                const stackVariable = await this.miDebugger.evalCobField(id, 0, 0);

                let variables: DebugProtocol.Variable[] = [];

                if (this.showVariableDetails) {
                    variables = stackVariable.toDebugProtocolVariable(this.showVariableDetails);
                }

                for (const child of stackVariable.children.values()) {
                    const childId = `${id}.${child.cobolName}`;
                    let reference = 0;
                    if (this.showVariableDetails || !!child.children.size) {
                        reference = this.variableHandles.create(childId);
                    }

                    let value = child.displayableType;
                    if (!this.showVariableDetails) {
                        const evaluatedChild = await this.miDebugger.evalCobField(childId, 0, 0);
                        value = evaluatedChild.value || "null";
                    }

                    variables.push({
                        name: child.cobolName,
                        evaluateName: child.cobolName,
                        value: value,
                        type: child.displayableType,
                        variablesReference: reference
                    });
                }
                response.body = {
                    variables: variables
                };
                this.sendResponse(response);
            } catch (err) {
                this.sendErrorResponse(response, 1, `Could not expand variable: ${(<Error>err).toString()}`);
            }
        } else {
            response.body = {
                variables: []
            };
            this.sendResponse(response);
        }
    }

    protected pauseRequest(response: DebugProtocol.ContinueResponse, _args: DebugProtocol.ContinueArguments): void {
        this.miDebugger.interrupt().then(_done => {
            this.sendResponse(response);
        }, (msg: Error) => {
            this.sendErrorResponse(response, 3, `Could not pause: ${msg.toString()}`);
        });
    }

    protected continueRequest(response: DebugProtocol.ContinueResponse, _args: DebugProtocol.ContinueArguments): void {
        this.miDebugger.continue().then(_done => {
            this.sendResponse(response);
        }, (msg: Error) => {
            this.sendErrorResponse(response, 2, `Could not continue: ${msg.toString()}`);
        });
    }

    protected stepInRequest(response: DebugProtocol.NextResponse, _args: DebugProtocol.NextArguments): void {
        this.miDebugger.stepInto().then(_done => {
            this.sendResponse(response);
        }, (msg: Error) => {
            this.sendErrorResponse(response, 4, `Could not step in: ${msg.toString()}`);
        });
    }

    protected stepOutRequest(response: DebugProtocol.NextResponse, _args: DebugProtocol.NextArguments): void {
        this.miDebugger.stepOut().then(_done => {
            this.sendResponse(response);
        }, (msg: Error) => {
            this.sendErrorResponse(response, 5, `Could not step out: ${msg.toString()}`);
        });
    }

    protected nextRequest(response: DebugProtocol.NextResponse, _args: DebugProtocol.NextArguments): void {
        this.miDebugger.stepOver().then(_done => {
            this.sendResponse(response);
        }, (msg: Error) => {
            this.sendErrorResponse(response, 6, `Could not step over: ${msg.toString()}`);
        });
    }

    protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {
        const [threadId, level] = this.frameIdToThreadAndLevel(args.frameId);
        if (args.context == "watch" || args.context == "variables" || args.context == "hover") {
            this.miDebugger.evalExpression(args.expression, threadId, level).then((res) => {
                response.body = {
                    variablesReference: 0,
                    result: !!res ? res : "not available"
                };
                this.sendResponse(response);
            }, (msg: Error) => {
                this.sendErrorResponse(response, 7, msg.toString());
            });
        } else {
            this.miDebugger.sendUserInput(args.expression, threadId, level).then(output => {
                if (typeof output == "undefined")
                    response.body = {
                        result: "",
                        variablesReference: 0
                    };
                else
                    response.body = {
                        result: JSON.stringify(output),
                        variablesReference: 0
                    };
                this.sendResponse(response);
            }, (msg: Error) => {
                this.sendErrorResponse(response, 8, msg.toString());
            });
        }
    }

    protected gotoTargetsRequest(response: DebugProtocol.GotoTargetsResponse, args: DebugProtocol.GotoTargetsArguments): void {
        this.miDebugger.goto(args.source.path, args.line).then(_done => {
            response.body = {
                targets: [{
                    id: 1,
                    label: args.source.name,
                    column: args.column,
                    line: args.line
                }]
            };
            this.sendResponse(response);
        }, (msg: Error) => {
            this.sendErrorResponse(response, 16, `Could not jump: ${msg.toString()}`);
        });
    }

    protected gotoRequest(response: DebugProtocol.GotoResponse, _args: DebugProtocol.GotoArguments): void {
        this.sendResponse(response);
    }
}

DebugSession.run(GDBDebugSession);
