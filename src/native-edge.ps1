param([Parameter(Mandatory=$true)][string]$Action,[string]$PayloadBase64='e30=')
$ErrorActionPreference='Stop'
$utf8Output=New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding=$utf8Output
$OutputEncoding=$utf8Output
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NativeWindow {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
}
'@

function Result($data){ $data | ConvertTo-Json -Compress -Depth 6; exit 0 }
function Payload(){ $json=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadBase64)); return $json|ConvertFrom-Json }
function EdgeProcess([switch]$IgnorePreferred){
  if(-not $IgnorePreferred){
    $preferred=0;try{$preferred=[int64]$script:payload.edgeWindowHandle}catch{}
    if($preferred -gt 0){
      $bound=Get-Process msedge -ErrorAction SilentlyContinue | Where-Object {[int64]$_.MainWindowHandle -eq $preferred -and $_.MainWindowTitle -match 'Microsoft.*Edge'} | Select-Object -First 1
      if($bound){return $bound}
      return $null
    }
  }
  $items=Get-Process msedge -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -match 'Microsoft.*Edge'}
  return $items|Select-Object -First 1
}
function Root(){ $p=EdgeProcess; if(-not $p){return $null}; return [Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle) }
function All($root){ return $root.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition) }
function MatchName($name,$pattern){ return $name -and $name -match $pattern }
function SetClipboardText($text){ for($i=0;$i -lt 10;$i++){try{[Windows.Forms.Clipboard]::SetText($text); return}catch{Start-Sleep -Milliseconds 150}}; throw 'Clipboard is busy' }
function GetClipboardText(){ for($i=0;$i -lt 10;$i++){try{if([Windows.Forms.Clipboard]::ContainsText()){return [Windows.Forms.Clipboard]::GetText()}}catch{};Start-Sleep -Milliseconds 150}; return $null }
function FocusEdge(){ $p=EdgeProcess; if(-not $p){throw 'Current ChatGPT Edge window was not found'}; [NativeWindow]::ShowWindow($p.MainWindowHandle,9)|Out-Null; [NativeWindow]::SetForegroundWindow($p.MainWindowHandle)|Out-Null; Start-Sleep -Milliseconds 500; return $p }
function InvokeElement($el){
  try{$pattern=$el.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern); $pattern.Invoke(); return $true}catch{}
  try{$rect=$el.Current.BoundingRectangle; $x=[int]($rect.X+$rect.Width/2); $y=[int]($rect.Y+$rect.Height/2); [NativeWindow]::SetCursorPos($x,$y)|Out-Null; [NativeWindow]::mouse_event(0x0002,0,0,0,[UIntPtr]::Zero); [NativeWindow]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero); return $true}catch{}
  return $false
}
function ClickElement($el){$rect=$el.Current.BoundingRectangle; if($rect.Width -le 0 -or $rect.Height -le 0){return $false}; $x=[int]($rect.X+$rect.Width/2); $y=[int]($rect.Y+$rect.Height/2); [NativeWindow]::SetCursorPos($x,$y)|Out-Null; Start-Sleep -Milliseconds 120; [NativeWindow]::mouse_event(0x0002,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 100; [NativeWindow]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 180; return $true}
function RightClickElement($el){$rect=$el.Current.BoundingRectangle; if($rect.Width -le 0 -or $rect.Height -le 0){return $false}; $x=[int]($rect.X+$rect.Width/2); $y=[int]($rect.Y+$rect.Height/2); [NativeWindow]::SetCursorPos($x,$y)|Out-Null; Start-Sleep -Milliseconds 120; [NativeWindow]::mouse_event(0x0008,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 100; [NativeWindow]::mouse_event(0x0010,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 400; return $true}
function RightClickPoint($x,$y){[NativeWindow]::SetCursorPos([int]$x,[int]$y)|Out-Null; Start-Sleep -Milliseconds 120; [NativeWindow]::mouse_event(0x0008,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 100; [NativeWindow]::mouse_event(0x0010,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 400}
function ActivateElement($el){try{$el.SetFocus(); Start-Sleep -Milliseconds 150; [Windows.Forms.SendKeys]::SendWait('{ENTER}'); return $true}catch{return (ClickElement $el)}}
function ScrollElementIntoView($el){
  try{$pattern=$el.GetCurrentPattern([Windows.Automation.ScrollItemPattern]::Pattern);$pattern.ScrollIntoView();Start-Sleep -Milliseconds 700;return $true}catch{}
  try{$el.SetFocus();Start-Sleep -Milliseconds 700;return $true}catch{}
  return $false
}
function FindByName($root,$regex,$controlType=$null){
  foreach($el in (All $root)){
    if((MatchName $el.Current.Name $regex) -and (-not $controlType -or $el.Current.ControlType.ProgrammaticName -match $controlType)){return $el}
  }
  return $null
}
function FindByAutomationId($root,$id){ return $root.FindFirst([Windows.Automation.TreeScope]::Descendants,(New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::AutomationIdProperty,$id))) }
function FindVisibleByAutomationId($root,$id){$matches=$root.FindAll([Windows.Automation.TreeScope]::Descendants,(New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::AutomationIdProperty,$id))); foreach($el in $matches){if(-not $el.Current.IsOffscreen -and $el.Current.IsEnabled){return $el}}; return $null}
function FindNativeControl($root,$id,$classRegex){
  $matches=$root.FindAll([Windows.Automation.TreeScope]::Descendants,(New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::AutomationIdProperty,$id)))
  foreach($el in $matches){if(-not $el.Current.IsOffscreen -and $el.Current.IsEnabled -and $el.Current.ClassName -match $classRegex){return $el}}
  return $null
}
function SubmitFileNames($fileName,$quoted){try{$fileName.SetFocus()}catch{ClickElement $fileName|Out-Null}; Start-Sleep -Milliseconds 250; try{$value=$fileName.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern); $value.SetValue($quoted)}catch{SetClipboardText $quoted; [Windows.Forms.SendKeys]::SendWait('^a'); [Windows.Forms.SendKeys]::SendWait('^v')}; Start-Sleep -Milliseconds 250; [Windows.Forms.SendKeys]::SendWait('{ENTER}'); Start-Sleep -Milliseconds 300}
function SelectFilesInOpenDialog($files){
  $desktop=[Windows.Automation.AutomationElement]::RootElement; $dialog=FindByName $desktop "^Open$|^$openWord$" 'Window'; if(-not $dialog){return $false}
  $selected=0
  foreach($file in $files){$name=[IO.Path]::GetFileName($file); $stem=[IO.Path]::GetFileNameWithoutExtension($file); $item=$null; foreach($el in (All $dialog)){if(-not $el.Current.IsOffscreen -and $el.Current.Name -in @($name,$stem) -and $el.Current.ControlType.ProgrammaticName -match 'ListItem|DataItem'){$item=$el;break}}; if(-not $item){continue}; try{$pattern=$item.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern); if($selected -eq 0){$pattern.Select()}else{$pattern.AddToSelection()}; $selected++}catch{ClickElement $item|Out-Null}}
  if($selected -lt $files.Count){return $false}; $open=FindByName $dialog "^Open|^$openWord" 'Button'; if(-not $open){$open=FindVisibleByAutomationId $dialog '1'}; if(-not $open){return $false}; InvokeElement $open|Out-Null; Start-Sleep -Milliseconds 300; return $true
}
function CountComposerAttachments(){
  $pageRoot=Root; $composer=FindByAutomationId $pageRoot 'prompt-textarea'; if(-not $composer){return 0}; $composerRect=$composer.Current.BoundingRectangle; $count=0
  foreach($el in (All $pageRoot)){$r=$el.Current.BoundingRectangle;if(-not $el.Current.IsOffscreen -and $r.Width -gt 0 -and $r.Height -gt 0 -and $r.Y -ge ($composerRect.Y-240) -and $r.Y -le ($composerRect.Y+$composerRect.Height+60) -and $el.Current.Name -match "Remove file|^$removeFile" -and $el.Current.ControlType.ProgrammaticName -match 'Button'){$count++}}
  return $count
}
function ComposerUploadBusy(){
  $pageRoot=Root; $composer=FindByAutomationId $pageRoot 'prompt-textarea'; if(-not $composer){return $true}; $composerRect=$composer.Current.BoundingRectangle
  foreach($el in (All $pageRoot)){$r=$el.Current.BoundingRectangle;if(-not $el.Current.IsOffscreen -and $r.Y -ge ($composerRect.Y-260) -and $r.Y -le ($composerRect.Y+$composerRect.Height+80) -and $el.Current.Name -match "Uploading|Cancel upload|$uploadingWord|$uploadInProgressWord"){return $true}}
  return $false
}
function WaitForAttachments($expected){
  $last=-1; $stable=0
  for($i=0;$i -lt 120;$i++){Start-Sleep -Milliseconds 500;$count=CountComposerAttachments;$busy=ComposerUploadBusy;if($count -eq $last -and -not $busy){$stable++}else{$last=$count;$stable=0};if($count -eq $expected -and $stable -ge 4){return $count}}
  return [Math]::Max(0,$last)
}
function SubmissionStarted($previousAttachments){
  $pageRoot=Root
  if(FindByName $pageRoot "Stop generating|Stop streaming|^$stopWord" 'Button'){return $true}
  if($previousAttachments -gt 0 -and (CountComposerAttachments) -eq 0){return $true}
  $submit=FindByAutomationId $pageRoot 'composer-submit-button'
  if(-not $submit -or -not $submit.Current.IsEnabled){return $true}
  return $false
}
function FindExactNameInProcess($root,$names,$processName){
  foreach($name in $names){
    try{
      $condition=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty,[string]$name)
      $matches=$root.FindAll([Windows.Automation.TreeScope]::Descendants,$condition)
      foreach($element in $matches){
        try{$owner=Get-Process -Id $element.Current.ProcessId -ErrorAction Stop;if($owner.ProcessName -eq $processName -and -not $element.Current.IsOffscreen){return $element}}catch{}
      }
    }catch{Start-Sleep -Milliseconds 100}
  }
  return $null
}
function FindExactNameNearPoint($root,$names,$x,$y,$windowRect){
  $candidates=@()
  foreach($name in $names){
    try{
      $condition=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty,[string]$name)
      $matches=$root.FindAll([Windows.Automation.TreeScope]::Descendants,$condition)
      foreach($element in $matches){
        try{
          $r=$element.Current.BoundingRectangle
          if($element.Current.IsOffscreen -or -not $element.Current.IsEnabled -or $r.Width -le 0 -or $r.Height -le 0){continue}
          if($r.X -lt ($windowRect.X-20) -or $r.Y -lt ($windowRect.Y-20) -or $r.X -gt ($windowRect.X+$windowRect.Width+20) -or $r.Y -gt ($windowRect.Y+$windowRect.Height+20)){continue}
          $cx=$r.X+$r.Width/2; $cy=$r.Y+$r.Height/2
          if([Math]::Abs($cx-$x) -gt 900 -or [Math]::Abs($cy-$y) -gt 650){continue}
          $distance=[Math]::Pow($cx-$x,2)+[Math]::Pow($cy-$y,2)
          $candidates+=@{element=$element;distance=$distance}
        }catch{}
      }
    }catch{Start-Sleep -Milliseconds 100}
  }
  if(-not $candidates.Count){return $null}
  return ($candidates|Sort-Object distance|Select-Object -First 1).element
}
function FindGeneratedMainImage($scroll=$false){
  for($attempt=0;$attempt -lt 3;$attempt++){
    $pageRoot=Root
    $named=@()
    foreach($el in (All $pageRoot)){
      try{
        if($el.Current.Name -match "generated image|^$generatedImagePrefix" -and $el.Current.ControlType.ProgrammaticName -match 'Image|Button'){
          $r=$el.Current.BoundingRectangle
          if($r.Width -ge 280 -and $r.Height -ge 240){$named+=@{element=$el;rect=$r;area=$r.Width*$r.Height;y=$r.Y;offscreen=$el.Current.IsOffscreen}}
        }
      }catch{}
    }
    if($scroll -and $named.Count){
      $latest=($named|Sort-Object y -Descending|Select-Object -First 1)
      ScrollElementIntoView $latest.element|Out-Null
      Start-Sleep -Milliseconds 700
      $scroll=$false
      continue
    }
    $visibleNamed=@($named|Where-Object{-not $_.offscreen})
    if($visibleNamed.Count){return ($visibleNamed|Sort-Object area -Descending|Select-Object -First 1)}
    $generic=@()
    foreach($el in (All $pageRoot)){
      try{
        if(-not $el.Current.IsOffscreen -and $el.Current.ControlType.ProgrammaticName -match 'Image|Button'){
          $r=$el.Current.BoundingRectangle
          if($r.Width -ge 280 -and $r.Height -ge 240){$generic+=@{element=$el;rect=$r;area=$r.Width*$r.Height;y=$r.Y;offscreen=$false}}
        }
      }catch{}
    }
    if($generic.Count){return ($generic|Sort-Object area -Descending|Select-Object -First 1)}
    Start-Sleep -Milliseconds 600
  }
  return $null
}
function WaitForGeneratedMainImage($maxSeconds=45){
  $deadline=[DateTime]::UtcNow.AddSeconds($maxSeconds); $first=$true
  while([DateTime]::UtcNow -lt $deadline){
    $main=FindGeneratedMainImage $first
    if($main){return $main}
    $first=$false
    Start-Sleep -Seconds 2
  }
  return $null
}
function FindViewerThumbnails($main){
  $pageRoot=Root; $thumbs=@(); $mainRect=$main.rect
  foreach($el in (All $pageRoot)){
    try{
      $r=$el.Current.BoundingRectangle
      if($el.Current.ControlType.ProgrammaticName -notmatch 'Button'){continue}
      if($el.Current.Name -notmatch "generated image|^$generatedImagePrefix"){continue}
      if($r.Width -lt 24 -or $r.Width -gt 180 -or $r.Height -lt 24 -or $r.Height -gt 180){continue}
      if($r.X -lt ($mainRect.X+$mainRect.Width-40) -or $r.X -gt ($mainRect.X+$mainRect.Width+300)){continue}
      if($r.Y -lt ($mainRect.Y-80) -or $r.Y -gt ($mainRect.Y+$mainRect.Height+800)){continue}
      $key="{0}:{1}" -f [int]$r.X,[int]$r.Y
      if(-not ($thumbs|Where-Object{$_.key -eq $key})){$thumbs+=@{element=$el;rect=$r;key=$key;offscreen=$el.Current.IsOffscreen}}
    }catch{}
  }
  return @($thumbs|Sort-Object {$_.rect.Y})
}
function GetSelectedThumbnailIndex($thumbs){
  for($i=0;$i -lt $thumbs.Count;$i++){
    $el=$thumbs[$i].element
    try{$selection=$el.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern);if($selection.Current.IsSelected){return @{index=$i;assumed=$false}}}catch{}
    try{if($el.Current.HasKeyboardFocus){return @{index=$i;assumed=$false}}}catch{}
    try{if($el.Current.ItemStatus -match 'selected|active|current'){return @{index=$i;assumed=$false}}}catch{}
  }
  if($thumbs.Count -gt 0){return @{index=0;assumed=$true}}
  return @{index=-1;assumed=$false}
}
function SubmitSavePath($targetBase){
  $desktop=[Windows.Automation.AutomationElement]::RootElement; $dialog=$null
  for($i=0;$i -lt 20;$i++){ $dialog=FindByName $desktop "Save As|^$saveAsWord$" 'Window'; if($dialog){break}; Start-Sleep -Milliseconds 250 }
  if(-not $dialog){throw 'Save As dialog was not found'}
  $targetDir=[IO.Path]::GetDirectoryName($targetBase); $targetName=[IO.Path]::GetFileName($targetBase)
  try{$dialog.SetFocus()}catch{[NativeWindow]::SetForegroundWindow([IntPtr]$dialog.Current.NativeWindowHandle)|Out-Null}; Start-Sleep -Milliseconds 200; [Windows.Forms.SendKeys]::SendWait('^l'); Start-Sleep -Milliseconds 200; SetClipboardText $targetDir; [Windows.Forms.SendKeys]::SendWait('^a'); [Windows.Forms.SendKeys]::SendWait('^v'); [Windows.Forms.SendKeys]::SendWait('{ENTER}'); Start-Sleep -Seconds 1
  $fileName=FindNativeControl $dialog '1001' '^Edit$'
  if(-not $fileName){$fileName=FindVisibleByAutomationId $dialog '1148'}
  if(-not $fileName){throw 'Save As file name field was not found'}
  try{$fileName.SetFocus()}catch{ClickElement $fileName|Out-Null};Start-Sleep -Milliseconds 200
  try{$value=$fileName.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern);$value.SetValue($targetName)}catch{SetClipboardText $targetName;[Windows.Forms.SendKeys]::SendWait('^a');[Windows.Forms.SendKeys]::SendWait('^v')};Start-Sleep -Milliseconds 250
  $save=FindNativeControl $dialog '1' '^Button$'
  if(-not $save){throw 'Save As save button was not found'}
  ClickElement $save|Out-Null;Start-Sleep -Milliseconds 500
}

$loginWord=([char]0x767b)+([char]0x5f55)
$stopWord=([char]0x505c)+([char]0x6b62)
$downloadWord=([char]0x4e0b)+([char]0x8f7d)
$uploadPhoto=([char]0x4e0a)+([char]0x4f20)+([char]0x7167)+([char]0x7247)
$fromComputerUpload=([char]0x4ece)+([char]0x7535)+([char]0x8111)+([char]0x4e0a)+([char]0x4f20)
$addPhotosFiles=([char]0x6dfb)+([char]0x52a0)+([char]0x7167)+([char]0x7247)+([char]0x548c)+([char]0x6587)+([char]0x4ef6)
$openWord=([char]0x6253)+([char]0x5f00)
$confirmWord=([char]0x786e)+([char]0x5b9a)
$likeImage=([char]0x559c)+([char]0x6b22)+([char]0x6b64)+([char]0x56fe)+([char]0x7247)
$moreActions=([char]0x66f4)+([char]0x591a)+([char]0x64cd)+([char]0x4f5c)
$generatedImagePrefix=([char]0x5df2)+([char]0x751f)+([char]0x6210)+([char]0x56fe)+([char]0x7247)
$copyImage=([char]0x590d)+([char]0x5236)+([char]0x56fe)+([char]0x50cf)
$saveImageAs=([char]0x5c06)+([char]0x56fe)+([char]0x50cf)+([char]0x53e6)+([char]0x5b58)+([char]0x4e3a)
$saveAsWord=([char]0x53e6)+([char]0x5b58)+([char]0x4e3a)
$saveWord=([char]0x4fdd)+([char]0x5b58)
$cancelWord=([char]0x53d6)+([char]0x6d88)
$removeFile=([char]0x79fb)+([char]0x9664)+([char]0x6587)+([char]0x4ef6)
$newChatWord=([char]0x65b0)+([char]0x804a)+([char]0x5929)
$uploadingWord=([char]0x6b63)+([char]0x5728)+([char]0x4e0a)+([char]0x4f20)
$uploadInProgressWord=([char]0x4e0a)+([char]0x4f20)+([char]0x4e2d)
$tooFrequentWord=([char]0x8bf7)+([char]0x6c42)+([char]0x8fc7)+([char]0x4e8e)+([char]0x9891)+([char]0x7e41)
$tooManyWord=([char]0x8bf7)+([char]0x6c42)+([char]0x592a)+([char]0x591a)
$operationFrequentWord=([char]0x64cd)+([char]0x4f5c)+([char]0x8fc7)+([char]0x4e8e)+([char]0x9891)+([char]0x7e41)
$laterRetryWord=([char]0x7a0d)+([char]0x540e)+([char]0x518d)+([char]0x8bd5)
$temporaryLimitWord=([char]0x6682)+([char]0x65f6)+([char]0x9650)+([char]0x5236)
$accessWord=([char]0x8bbf)+([char]0x95ee)

$payload=Payload
if($Action -eq 'restart-edge-chatgpt'){
  try{$payload.edgeWindowHandle=$null}catch{}
  Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  for($i=0;$i -lt 20;$i++){if(-not (Get-Process msedge -ErrorAction SilentlyContinue)){break};Start-Sleep -Milliseconds 250}
  $candidates=@(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
  )
  $edge=$candidates|Where-Object{$_ -and (Test-Path -LiteralPath $_)}|Select-Object -First 1
  if(-not $edge){throw 'Microsoft Edge executable was not found'}
  Start-Process -FilePath $edge -ArgumentList @('--new-window','https://chatgpt.com/') -WindowStyle Normal
  $window=$null;for($i=0;$i -lt 60;$i++){$window=EdgeProcess -IgnorePreferred;if($window){break};Start-Sleep -Milliseconds 500}
  if(-not $window){throw 'Microsoft Edge did not open a visible window after restart'}
  Start-Sleep -Seconds 3
  $newRoot=[Windows.Automation.AutomationElement]::FromHandle($window.MainWindowHandle)
  $composer=$null;for($i=0;$i -lt 30;$i++){$composer=FindByAutomationId $newRoot 'prompt-textarea';if($composer){break};Start-Sleep -Milliseconds 500}
  Result @{ok=$true;edgePath=$edge;hasComposer=[bool]$composer;windowHandle=[int64]$window.MainWindowHandle}
}
if($Action -eq 'inspect'){
  $p=EdgeProcess; if(-not $p){Result @{found=$false}}
  $root=Root; $names=@(); $composer=$false; $login=$false; $security=$false; $rateLimit=$false; $stop=$false; $downloads=0; $generatedCount=0; $attachmentCount=0; $submitEnabled=$false; $editCandidates=@(); $buttonCandidates=@()
  foreach($el in (All $root)){
    $n=$el.Current.Name;$help=$el.Current.HelpText;$candidateText=("$n $help").Trim(); if(-not $candidateText){continue};
    if($el.Current.ControlType.ProgrammaticName -match 'Edit|Document'){$editCandidates+=@{name=$n;type=$el.Current.ControlType.ProgrammaticName;automationId=$el.Current.AutomationId}}
    if($el.Current.ControlType.ProgrammaticName -match 'Button|MenuItem'){$buttonCandidates+=@{name=$n;type=$el.Current.ControlType.ProgrammaticName;automationId=$el.Current.AutomationId}}
    if($n -match 'Message ChatGPT|ChatGPT|Prompt' -and $el.Current.ControlType.ProgrammaticName -match 'Edit|Document'){$composer=$true}
    if($n -match "^Log in$|^Login$|^$loginWord$"){$login=$true}
    if($n -match 'captcha|Security check|Unusual activity'){$security=$true}
    if($candidateText -match "$tooFrequentWord|$tooManyWord|$operationFrequentWord|$laterRetryWord|$temporaryLimitWord.*($accessWord|access|visit)|Too many requests|requests? too frequent|rate.?limit|request limit|try again in (a few|several) minutes|temporarily.*limit"){$rateLimit=$true}
    if($n -match "Stop generating|Stop streaming|^$stopWord"){$stop=$true}
    if($n -match "^Download|^$downloadWord"){$downloads++}
    if($n -match "generated image|^$generatedImagePrefix" -and $el.Current.ControlType.ProgrammaticName -match 'Button|Image'){$generatedCount++}
    if($n -match "Remove file|^$removeFile" -and $el.Current.ControlType.ProgrammaticName -match 'Button'){$attachmentCount++}
    if($el.Current.AutomationId -eq 'composer-submit-button'){$submitEnabled=$el.Current.IsEnabled}
  }
  Result @{found=$true;title=$p.MainWindowTitle;windowHandle=[int64]$p.MainWindowHandle;hasComposer=$composer;hasLogin=$login;hasSecurity=$security;hasRateLimit=$rateLimit;hasStop=$stop;downloadCount=$downloads;generatedCount=$generatedCount;attachmentCount=$attachmentCount;submitEnabled=$submitEnabled;editCandidates=$editCandidates;buttonCandidates=$buttonCandidates}
}
FocusEdge|Out-Null; $root=Root
if($Action -eq 'get-current-chat-url'){
  $value=$null;$source='accessibility';$address=FindByAutomationId $root 'addressEditBox'
  if($address){try{$value=$address.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value}catch{$value=$address.Current.Name}}
  if(-not $value -or $value -notmatch '^https?://'){$source='keyboard';[Windows.Forms.SendKeys]::SendWait('^l');Start-Sleep -Milliseconds 200;[Windows.Forms.SendKeys]::SendWait('^c');Start-Sleep -Milliseconds 250;$value=GetClipboardText;[Windows.Forms.SendKeys]::SendWait('{ESC}');Start-Sleep -Milliseconds 150}
  if(-not $value -or $value -notmatch '^https?://'){throw 'Edge current URL could not be read from accessibility or keyboard clipboard fallback'}
  $chatPattern='^https://chatgpt\.com/(?:[^?#]*/)?c/[^/?#]+'
  Result @{url=[string]$value;isChat=[bool]($value -match $chatPattern);source=$source}
}
if($Action -eq 'open-chat-url'){
  $url=[string]$payload.url; $chatPattern='^https://chatgpt\.com/(?:[^?#]*/)?c/[^/?#]+'; if($url -notmatch $chatPattern){throw 'Only recorded ChatGPT conversation URLs can be opened'}
  [Windows.Forms.SendKeys]::SendWait('^l');Start-Sleep -Milliseconds 200;SetClipboardText $url;[Windows.Forms.SendKeys]::SendWait('^v{ENTER}');Start-Sleep -Milliseconds 400
  $loaded=$false;for($i=0;$i -lt 30;$i++){if(FindByAutomationId (Root) 'prompt-textarea'){$loaded=$true;break};Start-Sleep -Milliseconds 500}
  if(-not $loaded){throw 'Recorded ChatGPT conversation did not load'};Result @{ok=$true}
}
if($Action -eq 'refresh-page'){
  [Windows.Forms.SendKeys]::SendWait('^r');Start-Sleep -Milliseconds 400
  $loaded=$false;for($i=0;$i -lt 40;$i++){if(FindByAutomationId (Root) 'prompt-textarea'){$loaded=$true;break};Start-Sleep -Milliseconds 500}
  if(-not $loaded){throw 'ChatGPT did not recover after refreshing the page'};Result @{ok=$true}
}
if($Action -eq 'enable-accessibility'){
  [Windows.Forms.SendKeys]::SendWait('^l'); Start-Sleep -Milliseconds 200; SetClipboardText 'edge://accessibility/'; [Windows.Forms.SendKeys]::SendWait('^v{ENTER}'); Start-Sleep -Seconds 2
  $root=Root; $toggle=FindByName $root 'Native accessibility API support|Web accessibility|Accessibility mode' 'CheckBox|Button'
  if($toggle){InvokeElement $toggle|Out-Null}else{[Windows.Forms.SendKeys]::SendWait('{TAB} ')}
  Start-Sleep -Seconds 1; [Windows.Forms.SendKeys]::SendWait('^l'); SetClipboardText 'https://chatgpt.com/'; [Windows.Forms.SendKeys]::SendWait('^v{ENTER}'); Start-Sleep -Seconds 3
  Result @{ok=$true}
}
if($Action -eq 'new-chat'){
  [Windows.Forms.SendKeys]::SendWait('{ESC}'); Start-Sleep -Milliseconds 300; [Windows.Forms.SendKeys]::SendWait('{ESC}'); Start-Sleep -Milliseconds 500
  $newChat=FindByName (Root) "New chat|^$newChatWord" 'Button|Hyperlink'; if($newChat){ClickElement $newChat|Out-Null}else{[Windows.Forms.SendKeys]::SendWait('^l'); Start-Sleep -Milliseconds 200; SetClipboardText 'https://chatgpt.com/'; [Windows.Forms.SendKeys]::SendWait('^v{ENTER}')}
  $composer=$null;for($i=0;$i -lt 40;$i++){$composer=FindByAutomationId (Root) 'prompt-textarea';if($composer){break};Start-Sleep -Milliseconds 250};$freshRoot=Root
  $composerRect=if($composer){$composer.Current.BoundingRectangle}else{$null}
  for($attempt=0;$attempt -lt 10;$attempt++){ $removeButtons=@(); foreach($el in (All (Root))){$r=$el.Current.BoundingRectangle;if(-not $el.Current.IsOffscreen -and $r.Width -gt 0 -and $r.Height -gt 0 -and $composerRect -and $r.Y -ge ($composerRect.Y-200) -and $r.Y -le ($composerRect.Y+$composerRect.Height+50) -and $el.Current.Name -match "Remove file|^$removeFile" -and $el.Current.ControlType.ProgrammaticName -match 'Button'){$removeButtons+=$el}}; if(-not $removeButtons.Count){break}; ClickElement $removeButtons[0]|Out-Null; Start-Sleep -Milliseconds 350 }
  if($composer){try{$composer.SetFocus();[Windows.Forms.SendKeys]::SendWait('^a');[Windows.Forms.SendKeys]::SendWait('{BACKSPACE}')}catch{}}
  Start-Sleep -Milliseconds 500; $freshRoot=Root; $attachments=0; foreach($el in (All $freshRoot)){$r=$el.Current.BoundingRectangle;if(-not $el.Current.IsOffscreen -and $r.Width -gt 0 -and $r.Height -gt 0 -and $composerRect -and $r.Y -ge ($composerRect.Y-200) -and $r.Y -le ($composerRect.Y+$composerRect.Height+50) -and $el.Current.Name -match "Remove file|^$removeFile" -and $el.Current.ControlType.ProgrammaticName -match 'Button'){$attachments++}}
  Result @{ok=[bool]$composer;attachmentCount=$attachments}
}
if($Action -eq 'clear-attachments'){
  for($attempt=0;$attempt -lt 30;$attempt++){
    $pageRoot=Root; $composer=FindByAutomationId $pageRoot 'prompt-textarea'; if(-not $composer){throw 'ChatGPT composer was not found while clearing attachments'}; $composerRect=$composer.Current.BoundingRectangle; $remove=$null
    foreach($el in (All $pageRoot)){$r=$el.Current.BoundingRectangle;if(-not $el.Current.IsOffscreen -and $r.Width -gt 0 -and $r.Height -gt 0 -and $r.Y -ge ($composerRect.Y-240) -and $r.Y -le ($composerRect.Y+$composerRect.Height+60) -and $el.Current.Name -match "Remove file|^$removeFile" -and $el.Current.ControlType.ProgrammaticName -match 'Button'){$remove=$el;break}}
    if(-not $remove){break}; ClickElement $remove|Out-Null; Start-Sleep -Milliseconds 450
  }
  $remaining=CountComposerAttachments; Result @{ok=($remaining -eq 0);remaining=$remaining}
}
if($Action -eq 'verify-attachments'){
  $expected=[int]$payload.expected; $attached=WaitForAttachments $expected; $busy=ComposerUploadBusy
  Result @{ok=($attached -eq $expected -and -not $busy);attachmentCount=$attached;uploadBusy=$busy}
}
if($Action -eq 'send'){
  $editor=FindByAutomationId $root 'prompt-textarea'
  if(-not $editor){throw 'ChatGPT composer was not found'}; $editor.SetFocus(); Start-Sleep -Milliseconds 200; [Windows.Forms.SendKeys]::SendWait('^a'); [Windows.Forms.SendKeys]::SendWait('^v'); Start-Sleep -Milliseconds 600
  $beforeAttachments=CountComposerAttachments; $sent=$false; $usedAttempt=0
  for($attempt=1;$attempt -le 3 -and -not $sent;$attempt++){
    $usedAttempt=$attempt; $submit=FindByAutomationId (Root) 'composer-submit-button'
    if(-not $submit){if(SubmissionStarted $beforeAttachments){$sent=$true;break};Start-Sleep -Milliseconds 500;continue}
    if(-not $submit.Current.IsEnabled){Start-Sleep -Milliseconds 800;continue}
    if($attempt -eq 1){ClickElement $submit|Out-Null}
    elseif($attempt -eq 2){InvokeElement $submit|Out-Null}
    else{try{$submit.SetFocus();Start-Sleep -Milliseconds 200;[Windows.Forms.SendKeys]::SendWait('{ENTER}')}catch{ClickElement $submit|Out-Null}}
    for($check=0;$check -lt 8;$check++){Start-Sleep -Milliseconds 500;if(SubmissionStarted $beforeAttachments){$sent=$true;break}}
  }
  if(-not $sent){throw 'Submit button was located but the page did not accept the click after 3 attempts'}
  Result @{ok=$true;attempts=$usedAttempt}
}
if($Action -eq 'upload'){
  $quoted=($payload.files|ForEach-Object{'"'+$_+'"'}) -join ' '
  $existingFileName=FindVisibleByAutomationId ([Windows.Automation.AutomationElement]::RootElement) '1148'
  if($existingFileName){SubmitFileNames $existingFileName $quoted; $attached=WaitForAttachments $payload.files.Count; if($attached -lt $payload.files.Count){throw "Reference upload incomplete: expected $($payload.files.Count), found $attached"}; Result @{ok=$true;reusedPicker=$true;attachmentCount=$attached}}
  [Windows.Forms.SendKeys]::SendWait('{ESC}'); Start-Sleep -Milliseconds 400
  $add=FindByName $root 'Attach files|Add photos|Upload' 'Button'
  if(-not $add){$add=FindByAutomationId $root 'composer-plus-btn'}
  if(-not $add){throw 'Attachment button was not found'}; ClickElement $add|Out-Null; Start-Sleep -Milliseconds 800
  $desktopRoot=[Windows.Automation.AutomationElement]::RootElement; $upload=$null
  for($i=0;$i -lt 10;$i++){ $upload=FindByName $desktopRoot "Add photos and files|^$addPhotosFiles"; if($upload){break}; Start-Sleep -Milliseconds 200 }
  if(-not $upload){ClickElement $add|Out-Null; Start-Sleep -Milliseconds 800; $upload=FindByName $desktopRoot "Add photos and files|^$addPhotosFiles"}
  if($upload){$uploadTarget=[Windows.Automation.TreeWalker]::RawViewWalker.GetParent($upload); if(-not $uploadTarget){$uploadTarget=$upload}; ClickElement $uploadTarget|Out-Null}else{throw 'Add photos and files menu item was not found'}
  $fileName=$null
  for($i=0;$i -lt 20;$i++){ $fileName=FindVisibleByAutomationId ([Windows.Automation.AutomationElement]::RootElement) '1148'; if($fileName){break}; Start-Sleep -Milliseconds 250 }
  if($fileName){SubmitFileNames $fileName $quoted}
  elseif(-not (SelectFilesInOpenDialog $payload.files)){SetClipboardText $quoted; [Windows.Forms.SendKeys]::SendWait('%n'); Start-Sleep -Milliseconds 250; [Windows.Forms.SendKeys]::SendWait('^a'); [Windows.Forms.SendKeys]::SendWait('^v'); [Windows.Forms.SendKeys]::SendWait('{ENTER}')}
  $attached=WaitForAttachments $payload.files.Count
  if($attached -lt $payload.files.Count){throw "Reference upload incomplete: expected $($payload.files.Count), found $attached"}
  Result @{ok=$true;attachmentCount=$attached}
}
if($Action -eq 'inspect-attach-menu'){
  [Windows.Forms.SendKeys]::SendWait('{ESC}'); Start-Sleep -Milliseconds 150
  $add=FindByAutomationId $root 'composer-plus-btn'; if(-not $add){throw 'Attachment button was not found'}; $patternNames=@($add.GetSupportedPatterns()|ForEach-Object{$_.ProgrammaticName}); ActivateElement $add|Out-Null; Start-Sleep -Milliseconds 800
  $root=[Windows.Automation.AutomationElement]::RootElement; $items=@(); foreach($el in (All $root)){if(-not $el.Current.IsOffscreen -and $el.Current.Name){$r=$el.Current.BoundingRectangle; $items+=@{name=$el.Current.Name;type=$el.Current.ControlType.ProgrammaticName;automationId=$el.Current.AutomationId;className=$el.Current.ClassName;rect=@{x=$r.X;y=$r.Y;width=$r.Width;height=$r.Height}}}}
  $focused=[Windows.Automation.AutomationElement]::FocusedElement
  $menuText=FindByName $root "^$addPhotosFiles$"; $parentInfo=$null; if($menuText){$par=[Windows.Automation.TreeWalker]::RawViewWalker.GetParent($menuText); if($par){$pr=$par.Current.BoundingRectangle; $parentInfo=@{name=$par.Current.Name;type=$par.Current.ControlType.ProgrammaticName;automationId=$par.Current.AutomationId;className=$par.Current.ClassName;patterns=@($par.GetSupportedPatterns()|ForEach-Object{$_.ProgrammaticName});rect=@{x=$pr.X;y=$pr.Y;width=$pr.Width;height=$pr.Height}}}}
  Result @{items=$items;menuParent=$parentInfo;focused=@{name=$focused.Current.Name;type=$focused.Current.ControlType.ProgrammaticName;automationId=$focused.Current.AutomationId};patterns=$patternNames;rect=@{x=$add.Current.BoundingRectangle.X;y=$add.Current.BoundingRectangle.Y;width=$add.Current.BoundingRectangle.Width;height=$add.Current.BoundingRectangle.Height}}
}
if($Action -eq 'inspect-page-tail'){
  $root=Root; $items=@(); foreach($el in (All $root)){if($el.Current.Name -and $el.Current.ControlType.ProgrammaticName -match 'Text|Image|Button|Edit|Document'){$items+=@{name=$el.Current.Name;type=$el.Current.ControlType.ProgrammaticName;automationId=$el.Current.AutomationId}}}
  $skip=[Math]::Max(0,$items.Count-80); Result @{items=@($items|Select-Object -Skip $skip)}
}
if($Action -eq 'viewer-image-count'){
  $findWaitSeconds=if($payload.findWaitSeconds){[Math]::Max(1,[Math]::Min(45,[int]$payload.findWaitSeconds))}else{45};[Windows.Forms.SendKeys]::SendWait('{ESC}');$main=WaitForGeneratedMainImage $findWaitSeconds;if(-not $main){Result @{found=$false;single=$false;thumbnailCount=0}}
  $maxWaitSeconds=if($payload.maxWaitSeconds){[Math]::Max(2,[Math]::Min(45,[int]$payload.maxWaitSeconds))}else{8};$targetTotal=if($payload.targetTotal){[Math]::Max(1,[int]$payload.targetTotal)}else{5};$deadline=[DateTime]::UtcNow.AddSeconds($maxWaitSeconds);$best=0;$last=-1;$stable=0
  while([DateTime]::UtcNow -lt $deadline){$main=FindGeneratedMainImage $false;if(-not $main){$main=FindGeneratedMainImage $true};if($main){$count=@(FindViewerThumbnails $main).Count;if($count -gt $best){$best=$count};$total=if($best -eq 0){1}elseif($best -ge 4){5}else{$best+1};if($total -eq $last){$stable++}else{$last=$total;$stable=1};if($total -ge $targetTotal -and $stable -ge 6){break}};Start-Sleep -Milliseconds 500}
  Result @{found=$true;single=($best -eq 0);five=($best -ge 4);thumbnailCount=$best;total=if($best -eq 0){1}elseif($best -ge 4){5}else{$best+1}}
}
if($Action -eq 'dismiss-alert'){
  $button=FindByName ([Windows.Automation.AutomationElement]::RootElement) "^OK$|^$confirmWord$" 'Button'; if(-not $button){throw 'Confirmation button was not found'}; InvokeElement $button|Out-Null; Result @{ok=$true}
}
if($Action -eq 'inspect-file-picker'){
  [Windows.Forms.SendKeys]::SendWait('{ESC}'); $add=FindByAutomationId (Root) 'composer-plus-btn'; ActivateElement $add|Out-Null; Start-Sleep -Milliseconds 700
  $desktopRoot=[Windows.Automation.AutomationElement]::RootElement; $label=FindByName $desktopRoot "^$addPhotosFiles$"; $target=[Windows.Automation.TreeWalker]::RawViewWalker.GetParent($label); InvokeElement $target|Out-Null; Start-Sleep -Seconds 2
  $items=@(); foreach($el in (All $desktopRoot)){if(-not $el.Current.IsOffscreen -and $el.Current.ControlType.ProgrammaticName -match 'Window|Edit|Button'){$items+=@{name=$el.Current.Name;type=$el.Current.ControlType.ProgrammaticName;automationId=$el.Current.AutomationId;className=$el.Current.ClassName}}}
  Result @{items=$items}
}
if($Action -eq 'recover-save-ui'){
  for($i=0;$i -lt 4;$i++){try{[Windows.Forms.SendKeys]::SendWait('{ESC}')}catch{};Start-Sleep -Milliseconds 300}
  FocusEdge|Out-Null
  $chatPattern='^https://chatgpt\.com/(?:[^?#]*/)?c/[^/?#]+';$target=if(([string]$payload.chatUrl) -match $chatPattern){[string]$payload.chatUrl}else{'https://chatgpt.com/'}
  [Windows.Forms.SendKeys]::SendWait('^l');Start-Sleep -Milliseconds 250;SetClipboardText $target;[Windows.Forms.SendKeys]::SendWait('^v{ENTER}');Start-Sleep -Milliseconds 500
  $loaded=$false;for($i=0;$i -lt 30;$i++){if(FindByAutomationId (Root) 'prompt-textarea'){$loaded=$true;break};Start-Sleep -Milliseconds 500}
  [Windows.Forms.SendKeys]::SendWait('^r');Start-Sleep -Milliseconds 500;$loaded=$false
  for($i=0;$i -lt 40;$i++){if(FindByAutomationId (Root) 'prompt-textarea'){$loaded=$true;break};Start-Sleep -Milliseconds 500}
  if(-not $loaded){throw 'ChatGPT page did not recover after closing the save interface and refreshing'}
  Result @{ok=$true;url=$target}
}
if($Action -eq 'save-viewer-images'){
  [Windows.Forms.SendKeys]::SendWait('{ESC}')
  $initialMain=WaitForGeneratedMainImage 45
  if(-not $initialMain){throw 'Image viewer main image was not found after waiting 45 seconds'}
  $needed=[int]$payload.needed; $startNumber=[int]$payload.startNumber; $targetDir=[string]$payload.targetDir; $fileStem=[string]$payload.fileStem; $already=@($payload.processedIndexes|ForEach-Object{[int]$_}); $saved=@()
  $initialThumbs=FindViewerThumbnails $initialMain;$selectedInfo=GetSelectedThumbnailIndex $initialThumbs;$selectedThumbIndex=[int]$selectedInfo.index;$thumbnailSequence=@();for($i=0;$i -lt $initialThumbs.Count;$i++){if($i -ne $selectedThumbIndex){$thumbnailSequence+=$i}};$candidateTotal=[Math]::Min(5,1+$thumbnailSequence.Count)
  for($slot=0;$slot -lt $candidateTotal;$slot++){
    $main=FindGeneratedMainImage $false
    if(-not $main){$main=FindGeneratedMainImage $true}
    if(-not $main){throw "Image viewer main image was not found for thumbnail $slot after 3 attempts"}
    $thumbs=FindViewerThumbnails $main
    $total=$candidateTotal; if($already -contains $slot){continue}
    if($slot -gt 0){
      $thumbIndex=[int]$thumbnailSequence[$slot-1]
      if($thumbIndex -ge $thumbs.Count){break}
      if($thumbs[$thumbIndex].offscreen){ScrollElementIntoView $thumbs[$thumbIndex].element|Out-Null;Start-Sleep -Milliseconds 800;$main=FindGeneratedMainImage $false;if($main){$thumbs=FindViewerThumbnails $main}}
      if($thumbIndex -ge $thumbs.Count){throw "Thumbnail $thumbIndex disappeared while scrolling into view"}
      ClickElement $thumbs[$thumbIndex].element|Out-Null; Start-Sleep -Milliseconds 1500
    }
    if($slot -gt 0){$main=FindGeneratedMainImage $false;if(-not $main){$main=FindGeneratedMainImage $true};if(-not $main){throw "Main image did not stabilize after selecting thumbnail $thumbIndex"}}
    $number=$startNumber
    while($true){$baseName="{0}_{1}" -f $fileStem,$number.ToString('000');$existing=@(Get-ChildItem -LiteralPath $targetDir -File -ErrorAction SilentlyContinue|Where-Object{$_.BaseName -eq $baseName});if(-not $existing.Count){break};$number++}
    $before=@(Get-ChildItem -LiteralPath $targetDir -File -ErrorAction SilentlyContinue|ForEach-Object{$_.FullName})
    $saveNames=@('Save image as','Save image as...','Save image as (V)',"$saveImageAs","$saveImageAs(V)","$saveImageAs(&V)","$saveAsWord","$saveAsWord(S)","$saveAsWord(&S)")
    $submitted=$false
    for($menuAttempt=0;$menuAttempt -lt 3 -and -not $submitted;$menuAttempt++){
      [Windows.Forms.SendKeys]::SendWait('{ESC}'); Start-Sleep -Milliseconds 350
      $main=FindGeneratedMainImage $false; if(-not $main){$main=FindGeneratedMainImage $true}; if(-not $main){continue}
      $mainRect=$main.rect; $clickX=[int]($mainRect.X+$mainRect.Width/2); $clickY=[int]($mainRect.Y+$mainRect.Height/2)
      RightClickElement $main.element|Out-Null
      $desktop=[Windows.Automation.AutomationElement]::RootElement; $edgeRect=(Root).Current.BoundingRectangle; $saveAs=$null
      for($i=0;$i -lt 20;$i++){$saveAs=FindExactNameNearPoint $desktop $saveNames $clickX $clickY $edgeRect;if(-not $saveAs){$saveAs=FindExactNameInProcess $desktop $saveNames 'msedge'};if($saveAs){break};Start-Sleep -Milliseconds 150}
      if(-not $saveAs){continue}
      ClickElement $saveAs|Out-Null; Start-Sleep -Milliseconds 700
      try{SubmitSavePath (Join-Path $targetDir $baseName);$submitted=$true}catch{if($_.Exception.Message -notmatch 'Save As dialog was not found'){throw};[Windows.Forms.SendKeys]::SendWait('{ESC}');Start-Sleep -Milliseconds 400}
    }
    if(-not $submitted){throw "Save image as failed for thumbnail $slot after 3 attempts"}
    $savedFile=$null;for($i=0;$i -lt 60;$i++){Start-Sleep -Milliseconds 500;$new=@(Get-ChildItem -LiteralPath $targetDir -File -ErrorAction SilentlyContinue|Where-Object{$before -notcontains $_.FullName -and $_.BaseName -eq $baseName -and $_.Extension -ne '.crdownload'});if($new.Count){$savedFile=$new[0].FullName;break}};if(-not $savedFile){throw "Saved file did not appear for thumbnail $slot"};[Windows.Forms.SendKeys]::SendWait('{ESC}');Start-Sleep -Milliseconds 600;$saved+=@{index=$slot;file=$savedFile;total=$total}
  }
  if($saved.Count){$totalResult=$saved[0].total}else{$totalResult=$candidateTotal}; Result @{saved=$saved;total=$totalResult;selectedThumbnailIndex=$selectedThumbIndex;selectedThumbnailAssumed=[bool]$selectedInfo.assumed}
}
throw "Unknown action: $Action"
