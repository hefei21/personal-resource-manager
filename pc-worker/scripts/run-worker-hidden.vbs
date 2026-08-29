Option Explicit

Dim args, workerRoot, nasBaseUrl, nodePath, entrypoint, command, shell, exitCode
Dim userEnvironment, processEnvironment, environmentEntry, separatorIndex, environmentName, userPath
Set args = WScript.Arguments

If args.Count <> 3 Then
  WScript.Quit 2
End If

workerRoot = args(0)
nasBaseUrl = args(1)
nodePath = args(2)
entrypoint = workerRoot & "\src\index.js"

Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function

command = Quote(nodePath) & " " & Quote(entrypoint) & _
  " --nas-base-url " & Quote(nasBaseUrl) & " --watch-parent"

Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = workerRoot

' Task Scheduler can retain an environment snapshot after User variables are
' updated. Refresh only Worker-owned values, plus the current User Path needed
' to discover the LM Studio CLI, before starting the Node child process.
Set userEnvironment = shell.Environment("USER")
Set processEnvironment = shell.Environment("PROCESS")
For Each environmentEntry In userEnvironment
  separatorIndex = InStr(environmentEntry, "=")
  If separatorIndex > 1 Then
    environmentName = Left(environmentEntry, separatorIndex - 1)
    If UCase(Left(environmentName, 10)) = "PC_WORKER_" Then
      processEnvironment(environmentName) = Mid(environmentEntry, separatorIndex + 1)
    End If
  End If
Next
userPath = userEnvironment("Path")
If userPath <> "" Then
  processEnvironment("Path") = userPath & ";" & processEnvironment("Path")
End If

exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
