param(
  [Parameter(Mandatory=$true)][int]$CurrentPid,
  [Parameter(Mandatory=$true)][string]$ExecutableNameBase64
)
$ErrorActionPreference='Stop'
$name=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ExecutableNameBase64))
$escaped=$name.Replace("'","''")
$killed=@();$visible=@();$items=@(Get-CimInstance Win32_Process -Filter "Name='$escaped'" -ErrorAction SilentlyContinue);$byPid=@{};$visibleIds=@{}
foreach($item in $items){$byPid[[int]$item.ProcessId]=$item;$process=Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue;if($process -and $process.MainWindowHandle -ne 0){$visibleIds[[int]$item.ProcessId]=$true;$visible+=@{pid=[int]$process.Id;windowHandle=[int64]$process.MainWindowHandle;title=$process.MainWindowTitle}}}
foreach($item in $items){
  if([int]$item.ProcessId -eq $CurrentPid){continue}
  $process=Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
  if(-not $process){continue}
  if($process.MainWindowHandle -eq 0){
    $protected=$false;$parent=[int]$item.ParentProcessId
    while($byPid.ContainsKey($parent)){
      if($visibleIds.ContainsKey($parent)){$protected=$true;break}
      $parent=[int]$byPid[$parent].ParentProcessId
    }
    if($protected){continue}
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    $killed+=[int]$process.Id
  }
}
@{killed=$killed;visible=$visible}|ConvertTo-Json -Compress -Depth 4
