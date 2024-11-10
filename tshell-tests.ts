import * as tshell from './tshell'

require('source-map-support').install()
process.on('unhandledRejection', (err: any, p) => console.log(err.stack))

class TestListener implements tshell.ShellListener {

    name: string

    constructor(name: string) {
        this.name = name
    }

    failed(job: tshell.JobInfo, err) {
        this.log(`${this.name}: failed`, job, err.code)
    }

    protected log(message: string, job: tshell.JobInfo, s?: tshell.ExitStatus) {
        const status = s ? `: ${s.toString()}` : ''
        const q = job.cmdline.indexOf('"') < 0 ? '"' : "'"
        console.log(`${message}[${job.ident}] ${q}${job.cmdline}${q}${status}`)
    }

}

class TestListenerOne extends TestListener {

    constructor() {
        super('TestListenerOne')
    }

    //
    // N.B.: The "started" notification inherently is in a race with
    // the job output, so although we compare test output we really should
    // ignore the position of started relative to the job output.
    //
    started(job: tshell.JobInfo) {
        this.log('started', job)
    }

}

class TestListenerTwo extends TestListener {

    constructor() {
        super('TestListenerTwo')
    }

    finished(job: tshell.JobInfo, status: tshell.ExitStatus) {
        this.log('finished', job, status)
    }

}


const bash = tshell.cmd("bash", "-c")
const echo = tshell.cmd("echo")

class Tests {

    async echoTest(): Promise<void> {
        await tshell.exec("echo", "echoTest")
        await echo("hi mom!")
    }

    async composeTest(): Promise<void> {
        const echo1 = tshell.cmd(echo, "composeTest 1")
        const echo2 = tshell.cmd(echo1, "2")
        await echo2("3")
    }

    async redirectInputTest(): Promise<void> {
        await tshell.exec("head", "-1", {'<': "tshell-tests.ts"})
    }

    async redirectOutputTest(): Promise<void> {
        const mkdir = tshell.cmd("mkdir", "-p")
        const filelist = "tmp/files.txt"
        await tshell.exec(mkdir, "tmp")
        await tshell.exec("ls", "-1", "-a", "tmp", {'>': filelist})
        await tshell.exec("cat", filelist)
        await tshell.exec("rm", filelist)
        await tshell.exec("rmdir", "tmp")
    }

    async captureTest(): Promise<void> {
        function logCaptured(str: string): void {
            console.log('captured', str)
        }

        logCaptured(await tshell.output(echo, "hi mom!"))
        logCaptured(await tshell.output(bash, 'echo "hi mom!"; echo "foo"'))
        logCaptured(await tshell.capture('stderr', bash, '>&2 echo "hi mom!"'))
        const bashBoth = 'echo hi mom!; printf "%s\\n" foo >&2'
        logCaptured(await tshell.capture('stdout+stderr', bash, bashBoth))
        console.log(await tshell.capturePair(bash, bashBoth))
    }

    async exitErrorTest(): Promise<void> {
        try {
            await bash("exit 1")
            console.log('should not reach here')
        } catch (e) {
            if (e instanceof tshell.ExitError) {
                console.log('ExitError ' + e.code)
            } else {
                console.log(e.stack)
            }
        }

        tshell.shell().context.throwFlag = false
        console.log('status', await bash("exit 1"))
    }

    async subshellTest(): Promise<void> {
        const status = await tshell.exec(
            tshell.subshell(
                async function() {
                    console.log('nested status:', await bash("exit 2"))
                    tshell.shell().exit(3)
                }
            )
        )
        console.log('status:', status)
    }

}

const testsClass = Tests.prototype
const allTestPropertyNames = Object.getOwnPropertyNames(testsClass)
const allTestNames = allTestPropertyNames.filter((name) => name !== 'constructor')

async function main() {
    tshell.shell().listenerAdd(new TestListenerOne())
    tshell.shell().listenerAdd(new TestListenerTwo())
    const args = process.argv.slice(2)
    if (args.length) {
        const unknown = args.filter((arg) => !testsClass[arg])
        if (unknown.length) {
            console.log('unknown', unknown.join(','))
        } else {
            await runTests(args)
        }
    } else {
        await runTests(allTestNames)
    }
}

async function runTests(names: string[]): Promise<void> {
    await runTest(names[0])
    for (const name of names.slice(1)) {
        console.log()
        await runTest(name)
    }
}

function runTest(name: string): Promise<void> {
    console.log('Running', name)
    return testsClass[name]()
}

main()
