## tshell

The tshell module provides a simple interface to a subset of
the functionality of the Nodejs child process primitives. It is intended
as an alternative to writing some shell scripts.

A _command_ is a function to run a _program_, specified by a string or
another command, with an optional list of string arguments. A global object,
returned by the _shell_ function, defines the execution context, including
environment variables, current directory, and standard I/O redirection.
A command function returns a promise for the exit status of the process,
which is either an exit code (number) or error.

#### Commands
    import { cmd, shell, exec, output, subshell } from 'tshell'

    // Run a command.
    await cmd('echo')('hi mom!')

    // Create a command and then run it.
    const echo = cmd('echo')
    await echo('hi mom!')

    // Create a command with (some) arguments and run it.
    const ls = cmd('ls', '-l')
    await ls('.')

    // Handle an exception for non-zero exit status.
    try {
        await cmd('cat')('no-such-file')
    } catch (e) {
        // e is a RangeError subclass with e.code === 1
    }

    // Return exit status of 1 without an exception.
    shell().context.throwFlag = false
    const status = await cmd('cat')('no-such-file')

    // Capture stdout for a command as a string with newlines removed,
    // returning 'hi mom!'.
    await output(cmd(echo, 'hi mom!'))

    // Capture stderr for a command as a string with newlines removed,
    // returning 'hi mom!'.
    await capture('stderr', bash, '>&2 echo "hi mom!"')

    // Capture stdout and stderr both as one string with newlines removed,
    // returning ['hi mom!', 'foo'].
    await capture('stdout+stderr', bash, 'echo hi mom!; printf "%s\\n" foo >&2')

#### Contexts
When a command function is called, the configuration of the child process
depends on the current context, which is defined as a global instead of being
passed as an argument in every call. The _exec_ function allows one to override
the context when executing a specific command. One can use this function
to redirect the input or output of the command.

    // Redirect input or output.
    await exec(cmd(echo, 'hi mom!'), {'>': 'out.txt'})
    await exec(cmd(sort, '-n'), {'<': 'data.txt', '>': 'sorted.txt'})

    // Also can redirect to stderr with '2>', combine stdout and stderr
    // with '&>', and append with '>>', '2>>', and '&>>'.

    // Run with a different working directory.
    await exec(cmd('ls'), {dir: '..'})

    // Run with a different environment.
    await exec(bash, {env: {PATH: ...})

#### Subshells
The _subshell_ function handles sequential nesting by returning
a special command that calls a user-defined async function.
This feature is useful to encapsulate calls to commands in a different context.

    // Function body as a command.
    async function body() {
        await echo('hi mom!')
        if (cond) {
            shell().exit(1)
            return
        }

        await echo('goodbye')
    }
    await exec(subshell(body), { '>': output })

Using a global works well for a single path of execution, but the use of await
means one should be careful using multiple code blocks that execute commands.
If there might be parallel command execution,
such as executing commands in a callback,
one must use the _result_ method to ensure the current context
is properly restored before continuing after a use of await.

    // Multiple parallel shell context
    await exec(
        subshell(
            async function() {
                const sh = shell()
                sh.context.throwFlag = true
                if (sh.result(await echo('hi mom!')) !== 0) {
                    sh.exit(0)
                    return
                }
                sh.result(await echo('goodbye'))
            }
        )
    )

#### ShellListener
The shell
