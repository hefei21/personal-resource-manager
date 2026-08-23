Option Explicit

Dim args, workerRoot, nasBaseUrl, nodePath, entrypoint, command, shell, exitCode
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
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
