# AGENTS.md

## Windows PowerShell

Kilo's host shell on Windows may be legacy Windows PowerShell 5.1.

- For PowerShell operations, explicitly invoke PowerShell 7 with `pwsh.exe`.
- Do not invoke `powershell.exe`.
- For simple commands, use:
  `pwsh -NoLogo -NoProfile -Command '<command>'`
- For multiline or complex scripts, create a `.ps1` file and run:
  `pwsh -NoLogo -NoProfile -File <script.ps1>`
- Treat project text files as UTF-8.
