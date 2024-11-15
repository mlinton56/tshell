/**
 * Support for running shell commands in TypeScript.
 *
 * Copyright (c) 2017-2024 Mark A. Linton
 *
 * Use of this source code is governed by the MIT-style license that is
 * in the LICENSE file or at https://opensource.org/licenses/MIT.
 */

// Direct access to Nodejs builtin modules--no type-checking here.
const child_process = require('child_process')
const fs = require('fs')


/**
 * ExitStatus is the type for the status resulting from
 * the execution of a command.
 */
export type ExitStatus = number | Error

/**
 * ShellPromise is the type returned by running a command.
 *
 * This type is a class to allow it to work everywhere, including
 * calling the constructor. Because of how the Promise class constructor
 * works (immediately running the executor parameter) we can't really
 * provide functionality in a subclass. Otherwise, it might make sense
 * to merge in the ChildTask class here.
 */
export class ShellPromise extends Promise<ExitStatus> {}

/**
 * ExitError is thrown by a command if throwFlag is true and
 * the command exited with a non-zero code.
 */
export class ExitError extends RangeError {

    cmdline: string
    code: number

    constructor(cmdline: string, code: number) {
        super(cmdline + ': exited with ' + code.toString())
        this.code = code
    }

}

/**
 * SignalError is thrown by a command if throwFlag is true and
 * the command exited because of a signal.
 */
export class SignalError extends Error {

    cmdline: string
    signal: string

    constructor(cmdline: string, signal: string) {
        super(cmdline + ': ' + signal)
        this.cmdline = cmdline
        this.signal = signal
    }

}

/**
 * A command function takes an argument list and returns a promise.
 */
export interface CmdFunction {
    (...args: string[]): ShellPromise
}

/**
 * A command may refer to an async function.
 */
export type ShellFunc = () => Promise<void>

/**
 * A program reference may be a string, a shell function, or another command.
 */
export type Program = string | ShellFunc | Cmd

/**
 * A command is a function that runs a program with an argument list.
 *
 * If the argument list is undefined then the command's program
 * is a shell function.
 */
export interface Cmd extends CmdFunction {
    prog: Program
    args?: string[]
}

/**
 * Return a command for a given program and argument list.
 *
 * I don't know a better way to construct a function implementation
 * that exports additional properties.
 */
export function cmd(prog: Program, ...args: string[]): Cmd {
    const f = (...args2: string[]) => {
        return promise(prog, args.concat(args2))
    }

    const c = f as Cmd
    c.prog = prog
    c.args = args
    return c
}

/**
 * Return a command to create a new shell, run the given function, and
 * then restore the original shell. Note that in a multi-shell environment
 * it will also be necessary to ensure restoration of the original context
 * using the Shell#result method.
 */
export function subshell(body: ShellFunc): Cmd {
    const f = (...args: string[]) => {
        return promise(body, args)
    }

    const c = f as Cmd
    c.prog = body
    return c
}

function promise(p: Program, args: string[]): ShellPromise {
    return current.task(p, args).promise()
}

/**
 * ShellListener defines notifications for the execution of a command.
 */
export interface ShellListener {
    started?(info: JobInfo): void
    finished?(info: JobInfo, status: ExitStatus): void
    failed?(info: JobInfo, err: Error): void
}

/**
 * JobInfo provides information about a command being executed
 * to allow the use of the same listener for multiple runs.
 */
export class JobInfo {
    shell: Shell
    ident: number
    context: Context
    prog: Program
    args: string[]
    pid: number

    get cmdline() {
        const p = this.prog
        if (typeof p === 'string') {
            return line(p, this.args)
        }

        const command = p as Cmd
        const func = command.prog as ShellFunc
        return func.name + '()'
    }
}

/**
 * For redirecting command input or output. Should use a real interface
 * instead of any here, but not ready to pull that ball of yarn.
 */
export type Stream = any

/**
 * Optional context information for running a command.
 */
export class Context {

    dir?: string
    env?: object
    throwFlag?: boolean
    traceFlag?: boolean
    detachedFlag?: boolean

    stdin?: string | Stream
    stdout?: string | Stream
    stderr?: string | Stream
    stdouterr?: string | Stream
    appendout?: string | Stream
    appenderr?: string | Stream
    appendouterr?: string | Stream
    
    '<'?: string | Stream
    '>'?: string | Stream
    '2>'?: string | Stream
    '>>'?: string | Stream
    '2>>'?: string | Stream
    '&>'?: string | Stream
    '>&'?: string | Stream
    '&>>'?: string | Stream
    '>>&'?: string | Stream

    listener?: ShellListener
    listeners?: ShellListener[]

    static fromArg(c: Context): Context {

        for (const key of Object.keys(c)) {
            const attr = redirShortcutMap.get(key)
            if (attr) {
                c[attr] = c[key]
            }
        }
        return c
    }

}

const redirShortcutMap = new Map<string, string>([
    ['<', 'stdin'], ['>', 'stdout'], ['2>', 'stderr'],
    ['>>', 'apppendout'], ['2>>', 'appenderr'],
    ['&>', 'stdouterr'], ['>&', 'stdouterr'],
    ['&>>', 'appendouterr'], ['>>&', 'appendouterr']
])

/**
 * We would like to call exec and output with a variable number of strings and
 * an optional context, but TypeScript (and most languages) can't handle that.
 * So we pass a variable number of ExecArg arguments, where ExecArg is
 * a string or context, and convert ExecArg[] to [string[], Context].
 */
export type ExecArg = string | Context
type ExecArgs = [string[], Context]

function execArgs(arglist: ExecArg[]): [string[], Context] {
    if (arglist.length > 0) {
        const lastArgIndex = arglist.length - 1
        for (let i = 0; i < lastArgIndex; ++i) {
            if (typeof arglist[i] !== 'string') {
                throw new TypeError(`arglist[${i}]: string required`)
            }
        }

        const lastArg = arglist[lastArgIndex]
        if (typeof lastArg === 'string') {
            return [arglist as string[], undefined]
        }

        const args = arglist.slice(0, -1) as string[]
        return [args, Context.fromArg(lastArg as Context)]
    }

    return [[], undefined]
}

/**
 * Run a program with the given arguments in a given context.
 *
 * This function is primarily useful for redirection, e.g.,
 *
 *     exec('ls', {'>': 'filelist.txt'})
 */
export function exec(p: Program, ...arglist: ExecArg[]): ShellPromise {
    const [args, context] = execArgs(arglist)
    return current.task(p, args, context).promise()
}

/**
 * Encapsulate running a program and capturing the output.
 */
abstract class GenericCapture<T> {

    abstract init(output: CmdOutput): void
    abstract resolveCaptured(resolve: (value: T) => void, output: CmdOutput): void

    capture(p: Program, arglist: ExecArg[]): Promise<T> {
        const sh = current
        const [args, context] = execArgs(arglist)
        const task = sh.task(p, args, context)
        const output = task.cmdOutput()
        this.init(output)
        return new Promise<T>((resolve, reject) => {
            task.exec(
                (status: ExitStatus) => {
                    if (status === 0 || !sh.context.throwFlag) {
                        sh.status = status
                        this.resolveCaptured(resolve, output)
                    } else if (typeof status === 'number') {
                        const cmdline = task.cmdline()
                        sh.status = new ExitError(cmdline, status as number)
                        reject(sh.status)
                    } else {
                        sh.status = status as Error
                        reject(sh.status)
                    }
                },
                (err) => {
                    sh.status = err
                    reject(err)
                }
            )
        })
    }

}

type CaptureMode = 'stdout' | 'stderr' | 'stdout+stderr'
type ResolveType<T> = (value: T) => void

class StdoutCapture extends GenericCapture<string> {

    init(output: CmdOutput): void {
        output.stdoutChunks = []
    }

    resolveCaptured(resolve: ResolveType<string>, output: CmdOutput): void {
        resolve(output.stdout())
    }

}

const stdoutCaptureInstance = new StdoutCapture()


class StderrCapture extends GenericCapture<string> {

    init(output: CmdOutput): void {
        output.stderrChunks = []
    }

    resolveCaptured(resolve: ResolveType<string>, output: CmdOutput): void {
        resolve(output.stderr())
    }

}

const stderrCaptureInstance = new StderrCapture()


class CombinedCapture extends StdoutCapture {

    init(output: CmdOutput): void {
        super.init(output)
        output.combined = true
    }

}

const combinedCaptureInstance = new CombinedCapture()


class CapturePair extends GenericCapture<[string, string]> {

    init(output: CmdOutput): void {
        output.stdoutChunks = []
        output.stderrChunks = []
    }

    resolveCaptured(
        resolve: ResolveType<[string, string]>, output: CmdOutput
    ): void {
        resolve([output.stdout(), output.stderr()])
    }

}

const capturePairInstance = new CapturePair()


const captureTypeMap = new Map< CaptureMode, GenericCapture<string> >([
    ['stdout', stdoutCaptureInstance],
    ['stderr', stderrCaptureInstance],
    ['stdout+stderr', combinedCaptureInstance]
])

/**
 * Run a program with the given arguments and return stdout as a string.
 */
export function output(p: Program, ...arglist: ExecArg[]): Promise<string> {
    return stdoutCaptureInstance.capture(p, arglist)
}

/**
 * Run a program with arguments capturing output as a string for stdout,
 * stderr, or stdout+stderr.
 */
export function capture(
    mode: CaptureMode, p: Program, ...arglist: ExecArg[]
): Promise<string> {
    return captureTypeMap.get(mode).capture(p, arglist)
}

/**
 * Run a program with arguments capturing stdout and stderr as separate strings.
 */
export function capturePair(
    p: Program, ...arglist: ExecArg[]
): Promise<[string, string]> {
    return capturePairInstance.capture(p, arglist)
}


/**
 * Return a command-line string for a given program and argument list.
 */
export function cmdline(p: Program, ...arglist: ExecArg[]): string {
    // TODO?: The factoring here seems a bit clunky.
    const [args, context] = execArgs(arglist)
    const job = new JobInfo()
    flatten(p, args, job)
    return job.cmdline
}


/**
 * Interface to control execution context.
 */
export interface Shell {
    /**
     * Execution context.
     */
    context: Context

    /**
     * Add a listener to the shell's context.
     */
    listenerAdd(listener: ShellListener): void

    /**
     * Remove a listener from the shell's context, returning the listener
     * if found and removed or null otherwise.
     */
    listenerDel(listener: ShellListener): ShellListener

    /**
     * Remove all listeners from the shell's context.
     */
    listenerDelAll(): void

    /**
     * Passes back the result from a command and resets the shell context.
     *
     * This filter is only necessary with an await expression, e.g.,
     * sh.result(await cmd()) where multiple contexts may be running.
     */
    result(value: ExitStatus): ExitStatus

    /**
     * Set the exit status from a shell body. Note it is not sufficient
     * to call this method--one must also return from the body, e.g.,
     *
     * await exec(
     *     subshell(() => {
     *         if (cond) {
     *             shell().exit(1)
     *             return
     *         } else {
     *             // continue to do more
     *         }
     *     })
     * )
     */
    exit(code: number): void
}

/**
 * Return the current shell.
 */
export function shell(): Shell {
    return current
}


/**
 * Implementation of the Context interface for the ShellImpl class.
 */
class ShellContext extends Context {

    /**
     * Return a new context optionally customized with additional information.
     */
    static initial(additions?: Context) {
        const c = new ShellContext()
        c.env = {}
        c.listeners = []
        c.merge(additions)
        return c
    }

    /**
     * Return a copy of this context to customize command information,
     * overriding with any values given in the additions parameter.
     *
     * Have to be careful here--can't do "if (prop[key])" with
     * boolean properties.
     */
    clone(additions?: Context): ShellContext {
        const c = new ShellContext()
        c.env = {}
        c.listeners = []
        c.merge(this)
        c.merge(additions)
        return c
    }

    /**
     * Merge the given context into this context. Scalars and env entries
     * in the given context are copied to this context, overwriting
     * existing values, but listeners are always added to the list
     * in this context.
     */
    private merge(context?: Context): void {
        if (context) {
            for (const p of Object.keys(context)) {
                if (context[p] !== undefined &&
                    p !== 'env' && p !== 'listener' && p !== 'listeners'
                ) {
                    this[p] = context[p]
                }
            }

            if (context.env) {
                Object.assign(this.env, context.env)
            }

            if (context.listener) {
                this.listeners.push(context.listener)
            }

            if (context.listeners) {
                this.listeners.push(...context.listeners)
            }
        }
    }

}


/**
 * Shell implementation.
 */
class ShellImpl implements Shell {

    context: ShellContext
    stdin: Stream
    stdout: Stream | string
    stderr: Stream

    jobIdent: number
    status: ExitStatus

    /**
     * Return the top-level instance.
     */
    private static instanceVar: ShellImpl

    static get instance() {
        if (ShellImpl.instanceVar) {
            return ShellImpl.instanceVar
        }

        const sh = new ShellImpl()

        sh.context = ShellContext.initial({
            dir: process.cwd(),
            env: process.env,
            throwFlag: true,
            traceFlag: false,
            detachedFlag: false,
            stdin: null,
            stdout: null,
            stderr: null,
            stdouterr: null,
            appendout: null,
            appenderr: null,
            appendouterr: null
        })

        sh.stdin = process.stdin
        sh.stdout = process.stdout
        sh.stderr = process.stderr
        sh.jobIdent = 0
        sh.status = 0

        ShellImpl.instanceVar = sh

        return sh
    }


    /**
     * Return a copy of the shell and copy values from the given context.
     */
    clone(context?: Context): ShellImpl {
        const sh = new ShellImpl()
        sh.context = this.context.clone(context)
        sh.stdin = this.stdin
        sh.stdout = this.stdout
        sh.stderr = this.stderr
        sh.jobIdent = 0
        sh.status = 0
        return sh
    }

    /** Implements Shell#listenerAdd. */
    listenerAdd(listener: ShellListener): void {
        this.context.listeners.push(listener)
    }

    /** Implements Shell#listenerDel. */
    listenerDel(listener: ShellListener): ShellListener {
        const listeners = this.context.listeners
        for (let i = 0; i < listeners.length; ++i) {
            if (listeners[i] === listener) {
                listeners.splice(i, 1)
                return listener
            }
        }

        return null
    }

    /** Implements Shell#listenerDelAll. */
    listenerDelAll(): void {
        this.context.listeners = []
    }

    /** Implements Shell#result. */
    result(value: ExitStatus): ExitStatus {
        current = this
        return value
    }

    /** Implements Shell#exit. */
    exit(code: number): void {
        this.status = code
        if (code !== 0 && this.context.throwFlag) {
            throw new ExitError('exit ' + code.toString(), code)
        }
    }


    /**
     * Return a task that runs a given program. For a task that specifies
     * a simple program, we return a ChildTask that spawns a process.
     * Otherwise, the task must specify a function (ShellFunc), in which case
     * we return a ShellTask.
     */
    task(prog: Program, args: string[], context?: Context): CmdTask {
        const jobIdent = this.jobIdent + 1
        this.jobIdent = jobIdent

        const job = new JobInfo()
        job.ident = jobIdent
        job.shell = this
        job.context = context ? this.context.clone(context) : this.context
        flatten(prog, args, job)

        const p = job.prog
        switch (typeof p) {
        case 'string':
            // Create a ChildTask that spawns a child process.
            return ChildTask.initial(this, p as string, job)

        case 'function':
            // Create a ShellTask that runs ShellFunc body in the new shell.
            return ShellTask.initial(this, ((p as Cmd).prog) as ShellFunc, job)

        default:
            throw new Error('Unexpected type ' + (typeof p))
        }
    }

}

/**
 * Command output for capturing stdout and/or stderr.
 */
class CmdOutput {

    stdoutChunks: string[]
    stderrChunks: string[]
    combined: boolean

    stdout(): string {
        return this.output(this.stdoutChunks)
    }

    stderr(): string {
        return this.output(this.stderrChunks)
    }

    protected output(captured: string[]): string {
        return captured.join('').replace(/\n+/g, ' ').trim()
    }

}

/**
 * Abstract base class that encapsulates state transitions during
 * the execution of a command. The base class provides the logic
 * for redirecting I/O, which is serialized so that an error redirecting
 * standard input or output is reported to (the correct) standard error.
 */
abstract class CmdTask {

    protected sh: ShellImpl
    protected job: JobInfo
    protected context: Context
    protected stdio: (Stream | string)[]
    protected input: Stream
    protected output: CmdOutput
    protected resolveFunc: (result: ExitStatus) => void
    protected rejectFunc: (err: Error) => void
    protected errorFunc: (err: Error) => void = this.errorNotify.bind(this)


    /**
     * Initialize the task's context and stdio from the given shell and
     * optional context overrides.
     */
    protected init(sh: ShellImpl, job: JobInfo) {
        this.sh = sh
        this.job = job
        this.context = job.context
        this.stdio = [sh.stdin, sh.stdout, sh.stderr]
        this.output = new CmdOutput()
    }

    /**
     * Return a command line string representing the task.
     */
    abstract cmdline(): string

    /**
     * Return the command output for the task.
     */
    cmdOutput(): CmdOutput {
        return this.output
    }

    /**
     * Return a promise for task completion.
     */
    promise(): ShellPromise {
        return new ShellPromise((resolve, reject) => this.exec(resolve, reject))
    }

    /**
     * Execute the task using the given handler functions.
     */
    exec(resolve, reject): void {
        this.resolveFunc = resolve
        this.rejectFunc = reject

        this.post('started', this.job)
        this.redirectInput()
    }

    /**
     * This code is ugly because it didn't work to pass a readable stream
     * as stdio[0] to child_process.spawn--appears one must pipe the stream
     * to child.stdin in that case. Could always pipe but that seems
     * like overkill for simple redirection, so the approach is to use
     * an fd if the redirect is a filename and pipe any other object
     * to child.stdin.
     */
    private redirectInput(): void {
        const s = this.context.stdin
        if (!s) {
            this.redirectOutput()
            return
        }

        switch (typeof s) {
        case 'string':
            fs.open(s, 'r', (err, fd) => {
                if (err) {
                    this.errorNotify(err)
                } else {
                    this.stdio[0] = fd
                    this.redirectOutput()
                }
            })
            break

        case 'number':
            this.stdio[0] = s
            this.redirectOutput()
            break

        default:
            if (typeof s.pipe === 'function') {
                // Assume it is a stream.
                this.input = s
                this.stdio[0] = 'pipe'
                this.redirectOutput()
            } else {
                this.errorNotify(new Error('Unrecognized input ' + s))
            }
            break
        }
    }

    private redirectOutput(): void {
        const both = this.ostream('appendouterr', 'stdouterr')
        if (both) {
            both.on('open', (fd) => {
                this.stdio[1] = both
                this.stdio[2] = both
                this.run()
            })
        } else {
            const s = this.ostream('appendout', 'stdout')
            if (s) {
                s.on('open', (fd) => {
                    this.stdio[1] = s
                    this.redirectError()
                })
            } else {
                this.redirectError()
            }
        }
    }

    private redirectError(): void {
        const s = this.ostream('appenderr', 'stderr')
        if (s) {
            s.on('open', (fd) => {
                this.stdio[2] = s
                this.run()
            })
        } else {
            this.run()
        }
    }

    private ostream(a: string, w: string): Stream {
        const sa = this.context[a]
        if (sa) {
            if (typeof sa === 'string') {
                return this.tracked(fs.createWriteStream(sa, {flags: 'a'}))
            }

            return sa
        }

        const sw = this.context[w]
        if (typeof sw === 'string') {
            return this.tracked(fs.createWriteStream(sw))
        }

        return sw
    }

    private tracked(s: Stream): Stream {
        s.on('error', this.errorFunc)
        return s
    }


    /**
     * Run the command after redirection.
     */
    protected abstract run(): void

    /**
     * Handle stream or startup errors.
     */
    protected errorNotify(err: Error): void {
        if (this.context.throwFlag) {
            this.returnError(this.sh, err)
        } else {
            const out = this.stdio[2]
            writeln(out, err.message, () => this.returnError(this.sh, err))
        }
    }

    /**
     * Handle completion with the given status. Depending on the context,
     * we might reject if the status is non-zero.
     */
    protected returnStatus(sh: ShellImpl, s: ExitStatus): void {
        current = sh
        if (s === 0 || !sh.context.throwFlag) {
            sh.status = s
            this.resolveFunc.call(null, s)
            this.post('finished', this.job, s)
        } else {
            let err: Error
            if (typeof s === 'number') {
                err = new ExitError(this.cmdline(), s as number)
            } else {
                err = s as Error
            }

            sh.status = err
            this.rejectFunc.call(null, err)
            this.post('failed', this.job, err)
        }
    }

    /**
     * Handle completion with the given error. Depending on the context.
     * we might resolve.
     */
    protected returnError(sh: ShellImpl, err: Error): void {
        current = sh
        sh.status = err
        if (sh.context.throwFlag) {
            this.rejectFunc.call(null, err)
            this.post('failed', this.job, err)
        } else {
            this.resolveFunc.call(null, err)
            this.post('finished', this.job, err)
        }
    }

    private post(notification: string, ...args: any[]): void {
        for (const listener of this.context.listeners) {
            const reaction = listener[notification]
            if (reaction) {
                process.nextTick(() => reaction.apply(listener, args))
            }
        }
    }

}

/**
 * Execute a command by running a child process.
 */
class ChildTask extends CmdTask {

    private arg0: string
    private args: string[]


    static initial(sh: ShellImpl, arg0: string, job: JobInfo): ChildTask {
        const task = new ChildTask()
        task.init(sh, job)
        task.arg0 = arg0
        task.args = job.args
        return task
    }


    /**
     * Spawn a child process to run a command.
     */
    protected run(): void {
        const { sh, context, input, output } = this
        const { stdoutChunks, stderrChunks, combined } = output
        if (stdoutChunks) {
            this.stdio[1] = 'pipe'
        }
        if (stderrChunks || combined) {
            this.stdio[2] = 'pipe'
        }

        const child = child_process.spawn(this.arg0, this.args, {
            cwd: context.dir,
            env: context.env,
            stdio: this.stdio,
            detached: context.detachedFlag
        })
        this.job.pid = child.pid
        child.on('error', this.errorFunc)
        if (input) {
            input.pipe(child.stdin)
        }
        if (stdoutChunks) {
            const push = stdoutChunks.push.bind(stdoutChunks)
            child.stdout.on('data', push)
            if (combined) {
                child.stderr.on('data', push)
            }
        }
        if (stderrChunks) {
            child.stderr.on('data', stderrChunks.push.bind(stderrChunks))
        }

        child.on('close', (code: number, signal: string) => {
            if (signal) {
                this.returnError(sh, new SignalError(this.cmdline(), signal))
            } else {
                this.returnStatus(sh, code)
            }
        })
    }

    cmdline(): string {
        return line(this.arg0, this.args)
    }

}

/**
 * ShellTask is a CmdTask subclass that executes a code block that returns
 * a ShellPromise.
 */
class ShellTask extends CmdTask {

    private func: ShellFunc


    static initial(sh: ShellImpl, f: ShellFunc, job: JobInfo): ShellTask {
        const task = new ShellTask()
        task.init(sh, job)
        task.func = f
        return task
    }


    protected run(): void {
        current = this.sh.clone(this.context)
        this.func.call(null).then(
            (none) => this.returnStatus(this.sh, current.status),
            (err) => this.returnError(this.sh, err)
        )
    }

    cmdline(): string {
        return this.func.name + '()'
    }

}

/**
 * Flatten the program and arguments in a job, e.g., for
 *
 *     const bash = cmd('bash')
 *     const bashcmd = cmd(bash, '-c')
 *     await exec(bashcmd, 'echo "hi mom!"')
 *
 * we want {prog: 'bash', args: ['-c', 'echo "hi mom!"']}.
 */
function flatten(prog: Program, args: string[], job: JobInfo): void {
    const list: string[][] = args ? [args] : []
    const visited = new Set<Cmd>()
    
    let p = prog
    while (typeof p !== 'string' && p['args']) {
        const c = p as Cmd
        if (visited.has(c)) {
            throw new Error('Command reference cycle')
        }
        visited.add(c)
        list.push(c.args)
        p = c.prog
    }

    job.prog = p
    job.args = []
    for (let i = list.length - 1; i >= 0; --i) {
        job.args.push(...list[i])
    }
}


/**
 * Return a single string containing for program and arg list separated by
 * spaces and quoted as needed.
 */
function line(prog: string, argv: string[]): string {
    return [prog, ...argv].map(quoteIf).join(' ')
}

const dq = '"'
const sq = "'"

function quoteIf(s: string): string {
    let r = s
    if (r.indexOf(dq) >= 0) {
        if (r.indexOf(sq) >= 0) {
            r = s.replace(/'/g, "\\'")
        }
        r = sq + r + sq
    } else if (r.indexOf(sq) >= 0 || r.indexOf(' ') >= 0) {
        r = dq + s + dq
    }

    return r
}


/**
 * Write a string to the given stream and call the given function, if any,
 * after the write is finished.
 */
function write(out: Stream, s: string, f: () => void) {
    if (out.write(s)) {
        f()
    } else {
        out.on('drain', f)
    }
}

function writeln(out: Stream, s: string, f: () => void) {
    write(out, s + '\n', f)
}

/**
 * Initialize the global shell using information from the process.
 */
let current = ShellImpl.instance
