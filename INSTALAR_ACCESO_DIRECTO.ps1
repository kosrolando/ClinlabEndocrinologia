$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$shortcutPath = Join-Path ([Environment]::GetFolderPath("Desktop")) "ClinLab Suite - Endocrinologia.lnk"
$target = Join-Path $root "INICIAR_CLINLAB.bat"
$icon = Join-Path $root "assets\icon.svg"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $target
$shortcut.WorkingDirectory = $root
$shortcut.Description = "ClinLab Suite - Endocrinología y Marcadores Tumorales"
if (Test-Path $icon) {
  $shortcut.IconLocation = "$env:SystemRoot\System32\SHELL32.dll,44"
}
$shortcut.Save()

Write-Host "Acceso directo creado en el escritorio: $shortcutPath"
Write-Host "Use INICIAR_CLINLAB.bat para abrir el sistema en esta terminal."
Read-Host "Presione Enter para finalizar"
