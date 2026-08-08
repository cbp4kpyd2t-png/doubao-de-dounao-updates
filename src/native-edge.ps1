param([Parameter(Mandatory=$true)][string]$Action,[string]$PayloadBase64='e30=')
$ErrorActionPreference='Stop'
$utf8Output=New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding=$utf8Output
$OutputEncoding=$utf8Output
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NativeWindow {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder className, int maxCount);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, string lParam, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
  public static IntPtr FindOpenFileNameControl(IntPtr dialog) {
    IntPtr exact = IntPtr.Zero, fallback = IntPtr.Zero;
    EnumChildWindows(dialog, delegate(IntPtr child, IntPtr state) {
      int id = GetDlgCtrlID(child);
      var name = new System.Text.StringBuilder(128); GetClassName(child, name, name.Capacity);
      string cls = name.ToString();
      if ((id == 1148 || id == 1001) && cls.IndexOf("Edit", StringComparison.OrdinalIgnoreCase) >= 0) exact = child;
      else if ((id == 1148 || id == 1001) && fallback == IntPtr.Zero) fallback = child;
      return exact == IntPtr.Zero;
    }, IntPtr.Zero);
    IntPtr host = exact != IntPtr.Zero ? exact : fallback;
    if (host == IntPtr.Zero) return IntPtr.Zero;
    IntPtr edit = IntPtr.Zero;
    EnumChildWindows(host, delegate(IntPtr child, IntPtr state) {
      var name = new System.Text.StringBuilder(128); GetClassName(child, name, name.Capacity);
      if (name.ToString().IndexOf("Edit", StringComparison.OrdinalIgnoreCase) >= 0) { edit = child; return false; }
      return true;
    }, IntPtr.Zero);
    return edit != IntPtr.Zero ? edit : host;
  }
  public static IntPtr FindOpenButton(IntPtr dialog) {
    IntPtr button = IntPtr.Zero;
    EnumChildWindows(dialog, delegate(IntPtr child, IntPtr state) {
      if (GetDlgCtrlID(child) != 1) return true;
      var name = new System.Text.StringBuilder(128); GetClassName(child, name, name.Capacity);
      if (name.ToString().IndexOf("Button", StringComparison.OrdinalIgnoreCase) >= 0) { button = child; return false; }
      return true;
    }, IntPtr.Zero);
    return button;
  }
  public static bool SetDialogText(IntPtr control, string text) { IntPtr result; return SendMessageTimeout(control, 0x000C, IntPtr.Zero, text, 0x0002, 3000, out result) != IntPtr.Zero; }
  public static bool ClickDialogButton(IntPtr button) { IntPtr result; return SendMessageTimeout(button, 0x00F5, IntPtr.Zero, IntPtr.Zero, 0x0002, 3000, out result) != IntPtr.Zero; }
}
'@

function Result($data){ $data | ConvertTo-Json -Compress -Depth 6; exit 0 }
function Payload(){ $json=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadBase64)); return $json|ConvertFrom-Json }
function PreferredWindowHandle(){
  $preferred=0;try{$preferred=[int64]$script:payload.edgeWindowHandle}catch{}
  if($preferred -gt 0 -and [NativeWindow]::IsWindow([IntPtr]$preferred)){return $preferred}
  return 0
}
function EdgeProcess([switch]$IgnorePreferred){
  if(-not $IgnorePreferred){
    $preferred=0;try{$preferred=[int64]$script:payload.edgeWindowHandle}catch{}
    if($preferred -gt 0){
      $bound=Get-Process msedge -ErrorAction SilentlyContinue | Where-Object {[int64]$_.MainWindowHandle -eq $preferred} | Select-Object -First 1
      if($bound){return $bound}
      # Edge can replace its top-level handle while a download flyout closes.
      # Rebind only when there is exactly one visible Edge process, so we never
      # guess between multiple user windows.
      $visible=@(Get-Process msedge -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowHandle -ne 0})
      if($visible.Count -eq 1){return $visible[0]}
      return $null
    }
  }
  $items=@(Get-Process msedge -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowHandle -ne 0})
  if($items.Count -eq 1){return $items[0]}
  return $items|Where-Object {$_.MainWindowTitle -match 'Microsoft.*Edge'}|Select-Object -First 1
}
function Root(){ $preferred=PreferredWindowHandle;if($preferred -gt 0){return [Windows.Automation.AutomationElement]::FromHandle([IntPtr]$preferred)};$p=EdgeProcess;if(-not $p){return $null};return [Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle) }
function All($root){ return $root.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition) }
function MatchName($name,$pattern){ return $name -and $name -match $pattern }
function SetClipboardText($text){ for($i=0;$i -lt 10;$i++){try{[Windows.Forms.Clipboard]::SetText($text); return}catch{Start-Sleep -Milliseconds 150}}; throw 'Clipboard is busy' }
function GetClipboardText(){ for($i=0;$i -lt 10;$i++){try{if([Windows.Forms.Clipboard]::ContainsText()){return [Windows.Forms.Clipboard]::GetText()}}catch{};Start-Sleep -Milliseconds 150}; return $null }
function FocusEdge(){ $preferred=PreferredWindowHandle;if($preferred -gt 0){[NativeWindow]::ShowWindow([IntPtr]$preferred,9)|Out-Null;[NativeWindow]::SetForegroundWindow([IntPtr]$preferred)|Out-Null;Start-Sleep -Milliseconds 500;return @{MainWindowHandle=$preferred}};$p=EdgeProcess;if(-not $p){throw 'Current ChatGPT Edge window was not found'};[NativeWindow]::ShowWindow($p.MainWindowHandle,9)|Out-Null;[NativeWindow]::SetForegroundWindow($p.MainWindowHandle)|Out-Null;Start-Sleep -Milliseconds 500;return $p }
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
function FindAttachmentButtonNearComposer($pageRoot){
  $composer=FindByAutomationId $pageRoot 'prompt-textarea';if(-not $composer){return $null};$cr=$composer.Current.BoundingRectangle;$candidates=@()
  foreach($el in (All $pageRoot)){
    try{
      if($el.Current.IsOffscreen -or -not $el.Current.IsEnabled -or $el.Current.ControlType.ProgrammaticName -notmatch 'Button'){continue}
      $r=$el.Current.BoundingRectangle;if($r.Width -lt 12 -or $r.Width -gt 100 -or $r.Height -lt 12 -or $r.Height -gt 100){continue}
      $cx=$r.X+$r.Width/2;$cy=$r.Y+$r.Height/2
      if($cx -lt ($cr.X-40) -or $cx -gt ($cr.X+130) -or $cy -lt ($cr.Y-35) -or $cy -gt ($cr.Y+$cr.Height+35)){continue}
      $name=[string]$el.Current.Name;$id=[string]$el.Current.AutomationId;$priority=3
      if($name -match "Attach files|Add photos|Upload|$uploadPhoto|$fromComputerUpload|$addPhotosFiles|$uploadFile|$addFile"){$priority=0}
      elseif($id -eq 'composer-plus-btn'){$priority=1}
      $distance=[Math]::Abs($cx-($cr.X+24))+[Math]::Abs($cy-($cr.Y+$cr.Height/2))
      $candidates+=@{element=$el;priority=$priority;distance=$distance}
    }catch{}
  }
  if(-not $candidates.Count){return $null}
  return ($candidates|Sort-Object priority,distance|Select-Object -First 1).element
}
function FindVisibleUploadMenuItem($pageRoot){
  $pattern="Add photos and files|Upload from computer|Upload files?|Attach files?|Choose files?|Photos and files|^$addPhotosFiles$|^$fromComputerUpload$|^$uploadPhoto$|^$uploadFile$|^$selectFile$|^$addFile$|^$photosFiles$"
  $composer=FindByAutomationId $pageRoot 'prompt-textarea';if(-not $composer){return $null};$cr=$composer.Current.BoundingRectangle;$matches=@()
  foreach($el in (All $pageRoot)){
    try{
      if($el.Current.IsOffscreen -or -not $el.Current.IsEnabled -or -not $el.Current.Name -or $el.Current.Name -notmatch $pattern){continue}
      if($el.Current.ControlType.ProgrammaticName -notmatch 'Button|MenuItem|Text|Hyperlink'){continue}
      $r=$el.Current.BoundingRectangle;if($r.Width -le 0 -or $r.Height -le 0){continue}
      $cx=$r.X+$r.Width/2;$cy=$r.Y+$r.Height/2
      if($cx -lt ($cr.X-160) -or $cx -gt ($cr.X+$cr.Width+260) -or $cy -lt ($cr.Y-560) -or $cy -gt ($cr.Y+$cr.Height+180)){continue}
      $name=[string]$el.Current.Name
      # The current ChatGPT menu exposes two labels in one row: the action
      # ("Add photos and files") and the hint ("Upload from computer").  The
      # hint is the safest click target because it is always inside the native
      # file-picker action.  Do not let the larger generic label win merely
      # because UI Automation exposes it as a Button.
      $isComputerUpload=($name -match "Upload from computer|^$fromComputerUpload$")
      $priority=if($isComputerUpload){0}elseif($name -match "Upload files?|Choose files?|^$uploadFile$|^$selectFile$"){1}elseif($el.Current.ControlType.ProgrammaticName -match 'Button|MenuItem'){2}else{3}
      $distance=[Math]::Abs($cx-($cr.X+80))+[Math]::Abs($cy-$cr.Y)
      $matches+=@{element=$el;priority=$priority;distance=$distance;area=$r.Width*$r.Height}
    }catch{}
  }
  if(-not $matches.Count){return $null}
  return ($matches|Sort-Object priority,distance,area|Select-Object -First 1).element
}
function ClickUploadMenuItem($item){
  if(-not $item){return $false}
  # Text nodes in the Chromium accessibility tree already occupy the visible
  # clickable row.  Clicking their immediate parent is unreliable because the
  # parent may be the whole popup rather than the menu command.
  if($item.Current.ControlType.ProgrammaticName -match 'Button|MenuItem'){return (InvokeElement $item)}
  return (ClickElement $item)
}
function WaitForNewUploadFileNameField($knownHandles,$attempts=12){
  for($i=0;$i -lt $attempts;$i++){$field=FindVisibleEdgeOpenFileNameField $knownHandles;if($field){return $field};Start-Sleep -Milliseconds 250}
  return $null
}
function FindChatModeTab($pageRoot){
  $wr=$pageRoot.Current.BoundingRectangle;$matches=@()
  foreach($el in (All $pageRoot)){
    try{
      if($el.Current.IsOffscreen -or -not $el.Current.IsEnabled -or $el.Current.Name -notmatch '^(Chat|聊天)$'){continue}
      if($el.Current.ControlType.ProgrammaticName -notmatch 'Button|TabItem|RadioButton|Text'){continue}
      $r=$el.Current.BoundingRectangle;if($r.Width -le 0 -or $r.Height -le 0){continue};$cx=$r.X+$r.Width/2;$cy=$r.Y+$r.Height/2
      if($cx -lt ($wr.X+$wr.Width*0.2) -or $cx -gt ($wr.X+$wr.Width*0.8) -or $cy -lt ($wr.Y+30) -or $cy -gt ($wr.Y+320)){continue}
      $priority=if($el.Current.ControlType.ProgrammaticName -match 'Button|TabItem|RadioButton'){0}else{1};$matches+=@{element=$el;priority=$priority;y=$r.Y}
    }catch{}
  }
  if(-not $matches.Count){return $null};return ($matches|Sort-Object priority,y|Select-Object -First 1).element
}
function EnsureChatModeAndAttachment($pageRoot){
  $chatTab=FindChatModeTab $pageRoot
  if($chatTab){$target=$chatTab;if($chatTab.Current.ControlType.ProgrammaticName -match 'Text'){$parent=[Windows.Automation.TreeWalker]::RawViewWalker.GetParent($chatTab);if($parent){$target=$parent}};InvokeElement $target|Out-Null;Start-Sleep -Milliseconds 700
    for($i=0;$i -lt 16;$i++){$pageRoot=Root;$composer=FindByAutomationId $pageRoot 'prompt-textarea';$attachment=if($composer){FindAttachmentButtonNearComposer $pageRoot}else{$null};if($composer -and $attachment){return @{ok=$true;switched=$true;chatTabFound=$true}};Start-Sleep -Milliseconds 250}
  }
  $composer=FindByAutomationId $pageRoot 'prompt-textarea';$attachment=if($composer){FindAttachmentButtonNearComposer $pageRoot}else{$null}
  if($composer -and $attachment){return @{ok=$true;switched=$false;chatTabFound=$false}}
  return @{ok=$false;switched=$false;chatTabFound=[bool]$chatTab}
}
function VisibleOpenDialogHandles(){
  $desktop=[Windows.Automation.AutomationElement]::RootElement;$handles=@()
  foreach($window in $desktop.FindAll([Windows.Automation.TreeScope]::Children,[Windows.Automation.Condition]::TrueCondition)){
    try{if(-not $window.Current.IsOffscreen -and $window.Current.ControlType.ProgrammaticName -match 'Window' -and $window.Current.Name -match "^Open$|^$openWord$"){$handles+=[int64]$window.Current.NativeWindowHandle}}catch{}
  }
  return @($handles)
}
function FindOpenFileNameField($dialog){
  if(-not $dialog){return $null}
  foreach($automationId in @('1148','1001')){
    $candidate=FindByAutomationId $dialog $automationId
    if($candidate -and $candidate.Current.IsEnabled){
      if($candidate.Current.ControlType.ProgrammaticName -match 'Edit' -or $candidate.Current.ClassName -match '^Edit$'){return $candidate}
      foreach($child in (All $candidate)){
        try{if($child.Current.IsEnabled -and ($child.Current.ControlType.ProgrammaticName -match 'Edit' -or $child.Current.ClassName -match '^Edit$')){return $child}}catch{}
      }
    }
  }
  $host=FindByAutomationId $dialog 'FileNameControlHost'
  if($host){
    foreach($child in (All $host)){
      try{if($child.Current.IsEnabled -and ($child.Current.ControlType.ProgrammaticName -match 'Edit' -or $child.Current.ClassName -match '^Edit$')){return $child}}catch{}
    }
  }
  $dialogRect=$dialog.Current.BoundingRectangle;$candidates=@()
  foreach($candidate in (All $dialog)){
    try{
      $rect=$candidate.Current.BoundingRectangle
      if($candidate.Current.IsEnabled -and ($candidate.Current.ControlType.ProgrammaticName -match 'Edit' -or $candidate.Current.ClassName -match '^Edit$') -and $rect.Width -ge 120 -and $rect.Y -gt ($dialogRect.Y+$dialogRect.Height*0.5)){
        $candidates+=@{element=$candidate;rect=$rect}
      }
    }catch{}
  }
  if($candidates.Count){return ($candidates|Sort-Object {$_.rect.Y} -Descending|Select-Object -First 1).element}
  return $null
}
function FindVisibleEdgeOpenDialog($knownHandles=@()){
  $boundHandle=PreferredWindowHandle;if($boundHandle -le 0){$edge=EdgeProcess;if($edge){$boundHandle=[int64]$edge.MainWindowHandle}}
  $edgePids=@(Get-Process msedge -ErrorAction SilentlyContinue|ForEach-Object{[int]$_.Id});$desktop=[Windows.Automation.AutomationElement]::RootElement;$matches=@()
  foreach($window in $desktop.FindAll([Windows.Automation.TreeScope]::Children,[Windows.Automation.Condition]::TrueCondition)){
    try{
      if($window.Current.IsOffscreen -or $window.Current.ControlType.ProgrammaticName -notmatch 'Window' -or $window.Current.Name -notmatch "^Open$|^$openWord$"){continue}
      $handle=[int64]$window.Current.NativeWindowHandle;if($knownHandles -contains $handle){continue};$field=FindOpenFileNameField $window;if(-not $field){continue}
      $owner=[int64][NativeWindow]::GetWindow([IntPtr]$handle,4);$rootOwner=[int64][NativeWindow]::GetAncestor([IntPtr]$handle,3);$pid=[int]$window.Current.ProcessId;$priority=9
      if($boundHandle -gt 0 -and ($owner -eq $boundHandle -or $rootOwner -eq $boundHandle)){$priority=0}
      elseif($edgePids -contains $pid){$priority=1}
      elseif($window.Current.ClassName -match '#32770|Chrome_WidgetWin'){$priority=2}
      if($priority -lt 9){$matches+=@{element=$window;priority=$priority;handle=$handle}}
    }catch{}
  }
  if(-not $matches.Count){return $null};return ($matches|Sort-Object priority|Select-Object -First 1).element
}
function FindVisibleEdgeOpenFileNameField($knownHandles=@()){ $dialog=FindVisibleEdgeOpenDialog $knownHandles;if(-not $dialog){return $null};return (FindOpenFileNameField $dialog) }
function FocusContainingWindow($el){
  $current=$el;$window=$null
  for($i=0;$i -lt 24 -and $current;$i++){try{if($current.Current.ControlType.ProgrammaticName -match 'Window'){$window=$current};$current=[Windows.Automation.TreeWalker]::RawViewWalker.GetParent($current)}catch{break}}
  if($window){try{$handle=[int64]$window.Current.NativeWindowHandle;if($handle -gt 0){[NativeWindow]::ShowWindow([IntPtr]$handle,9)|Out-Null;[NativeWindow]::SetForegroundWindow([IntPtr]$handle)|Out-Null;Start-Sleep -Milliseconds 180}}catch{}}
  return $window
}
function CloseOpenDialog($knownHandles=@()){$dialog=FindVisibleEdgeOpenDialog $knownHandles;if(-not $dialog){return};FocusContainingWindow $dialog|Out-Null;[Windows.Forms.SendKeys]::SendWait('{ESC}');Start-Sleep -Milliseconds 250}
function GetUploadCompatibilitySummary($pageRoot){
  $composer=FindByAutomationId $pageRoot 'prompt-textarea';$attachment=if($composer){FindAttachmentButtonNearComposer $pageRoot}else{$null};$chat=FindChatModeTab $pageRoot;$near=@()
  if($composer){$cr=$composer.Current.BoundingRectangle;foreach($el in (All $pageRoot)){try{$r=$el.Current.BoundingRectangle;$cx=$r.X+$r.Width/2;$cy=$r.Y+$r.Height/2;if(-not $el.Current.IsOffscreen -and $el.Current.ControlType.ProgrammaticName -match 'Button|MenuItem|TabItem' -and $cx -ge ($cr.X-180) -and $cx -le ($cr.X+$cr.Width+260) -and $cy -ge ($cr.Y-560) -and $cy -le ($cr.Y+$cr.Height+180)){$label=([string]$el.Current.Name).Replace('|','/');$id=([string]$el.Current.AutomationId).Replace('|','/');$near+="${label}#${id}";if($near.Count -ge 12){break}}}catch{}}}
  return "composer=$([bool]$composer);attachment=$([bool]$attachment);chatTab=$([bool]$chat);edgeDialog=$([bool](FindVisibleEdgeOpenDialog));near=$([string]::Join('|',$near))"
}
function FindNativeControl($root,$id,$classRegex){
  $matches=$root.FindAll([Windows.Automation.TreeScope]::Descendants,(New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::AutomationIdProperty,$id)))
  foreach($el in $matches){if(-not $el.Current.IsOffscreen -and $el.Current.IsEnabled -and $el.Current.ClassName -match $classRegex){return $el}}
  return $null
}
function ReadUploadFileNameValue($fileName){
  try{return [string]$fileName.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value}catch{}
  try{return [string]$fileName.Current.Name}catch{}
  return ''
}
function UploadFileNameValueIsComplete($actual,$quoted,$files){
  if(-not $actual){return $false}
  if($actual -eq $quoted){return $true}
  foreach($file in $files){if($actual.IndexOf([IO.Path]::GetFileName([string]$file),[StringComparison]::OrdinalIgnoreCase) -lt 0){return $false}}
  return $true
}
function WriteAndVerifyUploadText($fileName,$text){
  for($attempt=1;$attempt -le 3;$attempt++){
    FocusContainingWindow $fileName|Out-Null;try{$fileName.SetFocus()}catch{ClickElement $fileName|Out-Null};Start-Sleep -Milliseconds 220
    if($attempt -eq 1){try{$value=$fileName.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern);$value.SetValue($text)}catch{}}
    else{SetClipboardText $text;[Windows.Forms.SendKeys]::SendWait('^a');[Windows.Forms.SendKeys]::SendWait('^v')}
    Start-Sleep -Milliseconds 350
    $actual=ReadUploadFileNameValue $fileName
    if($actual -eq $text){return @{ok=$true;actual=$actual;attempt=$attempt}}
  }
  return @{ok=$false;actual=(ReadUploadFileNameValue $fileName);attempt=3}
}
function UploadDialogShowsFiles($dialog,$files){
  $expected=@($files|ForEach-Object{[IO.Path]::GetFileName([string]$_)})
  $stems=@($files|ForEach-Object{[IO.Path]::GetFileNameWithoutExtension([string]$_)})
  foreach($element in (All $dialog)){
    try{if(-not $element.Current.IsOffscreen -and ([string]$element.Current.Name -in $expected -or [string]$element.Current.Name -in $stems)){return $true}}catch{}
  }
  return $false
}
function WriteAndVerifyUploadFileNames($fileName,$quoted,$files){
  for($attempt=1;$attempt -le 3;$attempt++){
    FocusContainingWindow $fileName|Out-Null;try{$fileName.SetFocus()}catch{ClickElement $fileName|Out-Null};Start-Sleep -Milliseconds 220
    if($attempt -eq 1){try{$value=$fileName.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern);$value.SetValue($quoted)}catch{}}
    else{SetClipboardText $quoted;[Windows.Forms.SendKeys]::SendWait('^a');[Windows.Forms.SendKeys]::SendWait('^v')}
    Start-Sleep -Milliseconds 350
    $actual=ReadUploadFileNameValue $fileName
    if(UploadFileNameValueIsComplete $actual $quoted $files){return @{ok=$true;actual=$actual;attempt=$attempt}}
  }
  return @{ok=$false;actual=(ReadUploadFileNameValue $fileName);attempt=3}
}
function SelectVisibleUploadFilesAndOpen($dialog,$files){
  $selected=0
  foreach($file in $files){
    $name=[IO.Path]::GetFileName([string]$file);$stem=[IO.Path]::GetFileNameWithoutExtension([string]$file);$item=$null;$selection=$null
    foreach($element in (All $dialog)){
      try{
        if($element.Current.Name -notin @($name,$stem)){continue}
        $current=$element
        for($depth=0;$depth -lt 8 -and $current;$depth++){
          try{$candidatePattern=$current.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern);if($candidatePattern -and $current.Current.IsEnabled){$item=$current;$selection=$candidatePattern;break}}catch{}
          try{$current=[Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($current)}catch{$current=$null}
        }
        if($selection){break}
      }catch{}
    }
    if(-not $item -or -not $selection){return $false}
    try{if($selected -eq 0){$selection.Select()}else{$selection.AddToSelection()};$selected++}catch{return $false}
  }
  if($selected -ne $files.Count){return $false}
  $open=FindByName $dialog "^Open$|^$openWord$" 'Button';if(-not $open){$open=FindByAutomationId $dialog '1'};if(-not $open){return $false}
  if(-not (InvokeElement $open)){return $false}
  for($i=0;$i -lt 32;$i++){Start-Sleep -Milliseconds 250;try{if($dialog.Current.IsOffscreen){return $true}}catch{return $true}}
  return $false
}
function SubmitOpenDialogByWindowMessages($dialog,$text){
  try{$handle=[IntPtr][int64]$dialog.Current.NativeWindowHandle}catch{return $false}
  if($handle -eq [IntPtr]::Zero){return $false}
  $field=[NativeWindow]::FindOpenFileNameControl($handle);if($field -eq [IntPtr]::Zero){return $false}
  if(-not [NativeWindow]::SetDialogText($field,$text)){return $false};Start-Sleep -Milliseconds 300
  $open=[NativeWindow]::FindOpenButton($handle);if($open -eq [IntPtr]::Zero){return $false}
  if(-not [NativeWindow]::ClickDialogButton($open)){return $false}
  for($i=0;$i -lt 32;$i++){Start-Sleep -Milliseconds 250;try{if($dialog.Current.IsOffscreen){return $true}}catch{return $true}}
  return $false
}
function SubmitFileNames($fileName,$quoted,$files){
  $dialog=FocusContainingWindow $fileName
  $directories=@($files|ForEach-Object{[IO.Path]::GetDirectoryName([string]$_)}|Select-Object -Unique)
  if($directories.Count -ne 1){throw '__UPLOAD_SOURCE_INVALID__:One native file picker submission must contain files from exactly one directory'}
  # Windows common dialogs on some remote/cloud computers interpret several
  # quoted absolute paths as a folder navigation only. Navigate explicitly,
  # then submit the visible files by basename so the files are actually chosen.
  $navigate=WriteAndVerifyUploadText $fileName ([string]$directories[0])
  if(-not $navigate.ok){throw "__UPLOAD_PATH_WRITE_FAILED__:The file picker did not accept the reference directory. Actual value: $($navigate.actual)"}
  [Windows.Forms.SendKeys]::SendWait('{ENTER}')
  $directoryReady=$false
  for($i=0;$i -lt 32;$i++){Start-Sleep -Milliseconds 250;if(UploadDialogShowsFiles $dialog $files){$directoryReady=$true;break}}
  if(-not $directoryReady){throw "__UPLOAD_DIRECTORY_NOT_READY__:The file picker entered the product directory but its reference images did not become selectable within 8 seconds: $($directories[0])"}
  # Prefer the file items themselves. This does not depend on the File name box
  # being visible, which is important on remote PCs with a short screen where
  # the bottom of the common dialog is outside the desktop work area.
  $baseQuoted=($files|ForEach-Object{'"'+[IO.Path]::GetFileName([string]$_)+'"'}) -join ' '
  if(SubmitOpenDialogByWindowMessages $dialog $baseQuoted){return $true}
  if(SelectVisibleUploadFilesAndOpen $dialog $files){return $true}
  $fileName=$null
  for($i=0;$i -lt 24;$i++){$fileName=FindOpenFileNameField $dialog;if($fileName){break};Start-Sleep -Milliseconds 250}
  if(-not $fileName){throw '__UPLOAD_PICKER_NOT_READY__:The product directory opened but the native File name control could not be accessed; upload was not submitted'}
  $write=WriteAndVerifyUploadFileNames $fileName $baseQuoted $files
  if(-not $write.ok){FocusContainingWindow $fileName|Out-Null;[Windows.Forms.SendKeys]::SendWait('{ESC}');Start-Sleep -Milliseconds 250;throw "__UPLOAD_PATH_WRITE_FAILED__:The file picker did not contain every absolute reference path after 3 attempts. Actual value: $($write.actual)"}
  [Windows.Forms.SendKeys]::SendWait('{ENTER}')
  for($i=0;$i -lt 32;$i++){Start-Sleep -Milliseconds 250;try{if(-not $dialog -or $dialog.Current.IsOffscreen){return $true}}catch{return $true}}
  return $false
}
function SelectFilesInOpenDialog($files){
  $dialog=FindVisibleEdgeOpenDialog; if(-not $dialog){return $false}
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
function ReadCurrentChatUrlFromAddress($pageRoot){
  try{
    $address=FindByAutomationId $pageRoot 'addressEditBox'
    if(-not $address){return $null}
    try{$value=$address.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value}catch{$value=$address.Current.Name}
    if(([string]$value) -match '^https://chatgpt\.com/(?:[^?#]*/)?c/[^/?#]+'){return [string]$value}
  }catch{}
  return $null
}
function SubmissionStarted($previousAttachments){
  $pageRoot=Root
  if(FindByName $pageRoot "Stop generating|Stop streaming|^$stopWord" 'Button'){return $true}
  if($previousAttachments -gt 0 -and (CountComposerAttachments) -eq 0){return $true}
  if(ReadCurrentChatUrlFromAddress $pageRoot){return $true}
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
function GetImageRegionFingerprint($main){
  try{
    $r=$main.rect
    # Move the pointer away so hover buttons and fading overlays are not mistaken
    # for a different generated image.
    [NativeWindow]::SetCursorPos(2,2)|Out-Null;Start-Sleep -Milliseconds 350
    $sourceWidth=[Math]::Max(16,[int]($r.Width*0.60));$sourceHeight=[Math]::Max(16,[int]($r.Height*0.60))
    $x=[Math]::Max(0,[int]($r.X+($r.Width-$sourceWidth)/2));$y=[Math]::Max(0,[int]($r.Y+($r.Height-$sourceHeight)/2))
    $source=New-Object Drawing.Bitmap $sourceWidth,$sourceHeight
    $graphics=[Drawing.Graphics]::FromImage($source)
    $graphics.CopyFromScreen($x,$y,0,0,$source.Size)
    $graphics.Dispose()
    $sample=New-Object Drawing.Bitmap 16,16
    $sampleGraphics=[Drawing.Graphics]::FromImage($sample)
    $sampleGraphics.DrawImage($source,0,0,16,16)
    $sampleGraphics.Dispose();$source.Dispose()
    $values=@()
    for($sampleY=0;$sampleY -lt 16;$sampleY++){for($sampleX=0;$sampleX -lt 16;$sampleX++){$pixel=$sample.GetPixel($sampleX,$sampleY);$values+=[int]$pixel.R;$values+=[int]$pixel.G;$values+=[int]$pixel.B}}
    $sample.Dispose()
    return ($values -join ',')
  }catch{return $null}
}
function GetImageFingerprintDistance($left,$right){
  if(-not $left -or -not $right){return 999}
  $a=@($left -split ','|ForEach-Object{[int]$_});$b=@($right -split ','|ForEach-Object{[int]$_})
  if($a.Count -ne $b.Count -or -not $a.Count){return 999}
  $sum=0.0;for($i=0;$i -lt $a.Count;$i++){$sum+=[Math]::Abs($a[$i]-$b[$i])}
  return $sum/$a.Count
}
function WaitForViewerAfterSave($minimumThumbs=0){
  # The Save As dialog normally returns focus to Edge by itself. Try the fast
  # path first and only force/focus Edge when the viewer is not immediately
  # visible; forcing focus on every image costs about half a second each time.
  $main=FindGeneratedMainImage $false
  if($main){
    $thumbs=@(FindViewerThumbnails $main)
    if($thumbs.Count -ge $minimumThumbs){return @{main=$main;thumbs=$thumbs}}
  }else{FocusEdge|Out-Null}
  $deadline=[DateTime]::UtcNow.AddSeconds(2);$best=$null
  while([DateTime]::UtcNow -lt $deadline){
    $main=FindGeneratedMainImage $false
    if(-not $main){$main=FindGeneratedMainImage $true}
    if($main){
      $thumbs=@(FindViewerThumbnails $main)
      if($thumbs.Count -ge $minimumThumbs){return @{main=$main;thumbs=$thumbs}}
      $best=@{main=$main;thumbs=$thumbs}
    }
    Start-Sleep -Milliseconds 400
  }
  return $best
}
function DownloadsFlyoutIsOpen(){
  $edgeRoot=Root;$edgeProcess=EdgeProcess;if(-not $edgeRoot -or -not $edgeProcess){return $false};$edgeRect=$edgeRoot.Current.BoundingRectangle;$edgePids=@(Get-Process msedge -ErrorAction SilentlyContinue|ForEach-Object{$_.Id})
  $desktop=[Windows.Automation.AutomationElement]::RootElement
  foreach($el in (All $desktop)){
    try{
      $r=$el.Current.BoundingRectangle;$name=$el.Current.Name
      if($edgePids -contains $el.Current.ProcessId -and -not $el.Current.IsOffscreen -and $r.Width -gt 0 -and $r.Height -gt 0 -and $r.X -gt ($edgeRect.X+$edgeRect.Width*0.45) -and $name -match '^Open file$|^Show in folder$|^See more$|^打开文件$|^在文件夹中显示$|^查看更多$'){return $true}
    }catch{}
  }
  return $false
}
function CloseDownloadsFlyoutIfOpen($maxWaitMilliseconds=700){
  # Most saves do not open the Downloads flyout. Keep this probe short; if a
  # delayed flyout later covers a thumbnail, EnsureThumbnailPointIsClear will
  # close it immediately before the click.
  $boundedWait=[Math]::Max(0,[Math]::Min(1500,[int]$maxWaitMilliseconds))
  $deadline=[DateTime]::UtcNow.AddMilliseconds($boundedWait);$seen=$false
  while([DateTime]::UtcNow -lt $deadline){
    if(DownloadsFlyoutIsOpen){$seen=$true;break}
    Start-Sleep -Milliseconds 200
  }
  if(-not $seen){return $false}
  FocusEdge|Out-Null;[Windows.Forms.SendKeys]::SendWait('{ESC}');Start-Sleep -Milliseconds 600
  if(DownloadsFlyoutIsOpen){
    $edgeRoot=Root;$edgeRect=$edgeRoot.Current.BoundingRectangle;$toggle=$null;$desktop=[Windows.Automation.AutomationElement]::RootElement;$edgePids=@(Get-Process msedge -ErrorAction SilentlyContinue|ForEach-Object{$_.Id})
    foreach($el in (All $desktop)){
      try{$r=$el.Current.BoundingRectangle;if($edgePids -contains $el.Current.ProcessId -and -not $el.Current.IsOffscreen -and $el.Current.ControlType.ProgrammaticName -match 'Button' -and $el.Current.Name -match '^Downloads$|^下载$' -and $r.Y -lt ($edgeRect.Y+140) -and $r.X -gt ($edgeRect.X+$edgeRect.Width*0.55)){$toggle=$el;break}}catch{}
    }
    if($toggle){ClickElement $toggle|Out-Null;Start-Sleep -Milliseconds 500}
  }
  return (-not (DownloadsFlyoutIsOpen))
}
function ElementRuntimeKey($el){
  try{return (($el.GetRuntimeId()|ForEach-Object{[string]$_}) -join '.')}catch{return ''}
}
function ThumbnailPointIsClear($thumb){
  try{
    $rect=$thumb.Current.BoundingRectangle
    if($rect.Width -le 0 -or $rect.Height -le 0){return $false}
    $point=New-Object Windows.Point ([double]($rect.X+$rect.Width/2)),([double]($rect.Y+$rect.Height/2))
    $hit=[Windows.Automation.AutomationElement]::FromPoint($point)
    $targetKey=ElementRuntimeKey $thumb
    if(-not $hit -or -not $targetKey){return $false}
    $walker=[Windows.Automation.TreeWalker]::ControlViewWalker
    for($current=$hit;$current;$current=$walker.GetParent($current)){
      if((ElementRuntimeKey $current) -eq $targetKey){return $true}
    }
  }catch{}
  return $false
}
function EnsureThumbnailPointIsClear($thumb){
  for($attempt=0;$attempt -lt 4;$attempt++){
    if(ThumbnailPointIsClear $thumb){return $true}
    if(FindVisibleSaveDialog){
      CloseVisibleSaveDialogs|Out-Null
      Start-Sleep -Milliseconds 250
      if(ThumbnailPointIsClear $thumb){return $true}
    }
    # A browser flyout (most commonly Downloads) is covering the thumbnail.
    # Escape is safe here because the hit test proved the click target is blocked.
    FocusEdge|Out-Null
    [Windows.Forms.SendKeys]::SendWait('{ESC}')
    Start-Sleep -Milliseconds 700
  }
  return (ThumbnailPointIsClear $thumb)
}
function SelectViewerThumbnail($thumbIndex,$previousFingerprint){
  for($attempt=1;$attempt -le 2;$attempt++){
    $viewer=WaitForViewerAfterSave 1
    if(-not $viewer -or $thumbIndex -ge $viewer.thumbs.Count){continue}
    $thumb=$viewer.thumbs[$thumbIndex]
    if($thumb.offscreen){ScrollElementIntoView $thumb.element|Out-Null;$viewer=WaitForViewerAfterSave 1;if(-not $viewer -or $thumbIndex -ge $viewer.thumbs.Count){continue};$thumb=$viewer.thumbs[$thumbIndex]}
    if(-not (EnsureThumbnailPointIsClear $thumb.element)){continue}
    if($attempt -eq 2){InvokeElement $thumb.element|Out-Null}else{ClickElement $thumb.element|Out-Null}
    $deadline=[DateTime]::UtcNow.AddSeconds(4)
    while([DateTime]::UtcNow -lt $deadline){
      Start-Sleep -Milliseconds 400
      $main=FindGeneratedMainImage $false
      if(-not $main){continue}
      $fingerprint=GetImageRegionFingerprint $main
      $distance=GetImageFingerprintDistance $previousFingerprint $fingerprint
      if(-not $previousFingerprint -or ($fingerprint -and $distance -ge 4.0)){return @{main=$main;fingerprint=$fingerprint;distance=$distance}}
    }
  }
  return $null
}
function FindSavedTargetFile($targetBase){
  $targetDir=[IO.Path]::GetDirectoryName($targetBase);$baseName=[IO.Path]::GetFileName($targetBase)
  if(-not (Test-Path -LiteralPath $targetDir -PathType Container)){return $null}
  return Get-ChildItem -LiteralPath $targetDir -File -ErrorAction SilentlyContinue|Where-Object{$_.BaseName -eq $baseName -and $_.Extension -ne '.crdownload'}|Select-Object -First 1
}
function FindVisibleSaveDialog(){
  $desktop=[Windows.Automation.AutomationElement]::RootElement
  foreach($candidate in (All $desktop)){
    try{
      if($candidate.Current.ControlType.ProgrammaticName -match 'Window' -and $candidate.Current.Name -match "^Save As$|^$saveAsWord$" -and -not $candidate.Current.IsOffscreen){
        $r=$candidate.Current.BoundingRectangle;if($r.Width -gt 0 -and $r.Height -gt 0){return $candidate}
      }
    }catch{}
  }
  return $null
}
function CloseVisibleSaveDialogs(){
  for($attempt=0;$attempt -lt 4;$attempt++){
    $dialog=FindVisibleSaveDialog
    if(-not $dialog){return $true}
    try{$dialog.SetFocus()}catch{
      try{[NativeWindow]::SetForegroundWindow([IntPtr]$dialog.Current.NativeWindowHandle)|Out-Null}catch{}
    }
    Start-Sleep -Milliseconds 180
    [Windows.Forms.SendKeys]::SendWait('{ESC}')
    Start-Sleep -Milliseconds 450
  }
  return (-not (FindVisibleSaveDialog))
}
function FindSaveFileNameField($dialog){
  foreach($automationId in @('1001','1148')){
    $candidate=FindVisibleByAutomationId $dialog $automationId
    if($candidate){
      if($candidate.Current.ControlType.ProgrammaticName -match 'Edit' -or $candidate.Current.ClassName -match '^Edit$'){return $candidate}
      foreach($child in (All $candidate)){
        try{if(-not $child.Current.IsOffscreen -and $child.Current.IsEnabled -and ($child.Current.ControlType.ProgrammaticName -match 'Edit' -or $child.Current.ClassName -match '^Edit$')){return $child}}catch{}
      }
    }
  }
  $fileNameHost=FindVisibleByAutomationId $dialog 'FileNameControlHost'
  if($fileNameHost){
    foreach($child in (All $fileNameHost)){
      try{if(-not $child.Current.IsOffscreen -and $child.Current.IsEnabled -and ($child.Current.ControlType.ProgrammaticName -match 'Edit' -or $child.Current.ClassName -match '^Edit$')){return $child}}catch{}
    }
  }
  $dialogRect=$dialog.Current.BoundingRectangle;$candidates=@()
  foreach($candidate in (All $dialog)){
    try{
      $rect=$candidate.Current.BoundingRectangle
      if(-not $candidate.Current.IsOffscreen -and $candidate.Current.IsEnabled -and ($candidate.Current.ControlType.ProgrammaticName -match 'Edit' -or $candidate.Current.ClassName -match '^Edit$') -and $rect.Width -ge 180 -and $rect.Height -ge 18 -and $rect.Y -gt ($dialogRect.Y+$dialogRect.Height*0.55)){
        $candidates+=@{element=$candidate;rect=$rect}
      }
    }catch{}
  }
  if($candidates.Count){return ($candidates|Sort-Object {$_.rect.Y}|Select-Object -First 1).element}
  return $null
}
function ReadElementValue($element){
  try{return [string]$element.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value}catch{}
  try{return [string]$element.Current.Name}catch{}
  return ''
}
function WriteAndVerifySavePath($fileName,$targetBase){
  for($attempt=1;$attempt -le 3;$attempt++){
    try{$fileName.SetFocus()}catch{ClickElement $fileName|Out-Null}
    Start-Sleep -Milliseconds 200
    if($attempt -eq 1){
      try{$value=$fileName.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern);$value.SetValue($targetBase)}catch{}
    }else{
      SetClipboardText $targetBase
      [Windows.Forms.SendKeys]::SendWait('^a')
      [Windows.Forms.SendKeys]::SendWait('^v')
    }
    Start-Sleep -Milliseconds 350
    $actual=(ReadElementValue $fileName).Trim()
    if($actual -eq $targetBase){return @{ok=$true;actual=$actual;attempt=$attempt}}
  }
  return @{ok=$false;actual=(ReadElementValue $fileName);attempt=3}
}
function SubmitSavePath($targetBase){
  $desktop=[Windows.Automation.AutomationElement]::RootElement; $dialog=$null
  for($i=0;$i -lt 20;$i++){ $dialog=FindByName $desktop "Save As|^$saveAsWord$" 'Window'; if($dialog){break}; Start-Sleep -Milliseconds 250 }
  if(-not $dialog){throw 'Save As dialog was not found'}
  $targetDir=[IO.Path]::GetDirectoryName($targetBase)
  if(-not (Test-Path -LiteralPath $targetDir -PathType Container)){throw "Save target directory does not exist: $targetDir"}
  try{$dialog.SetFocus()}catch{[NativeWindow]::SetForegroundWindow([IntPtr]$dialog.Current.NativeWindowHandle)|Out-Null}; Start-Sleep -Milliseconds 300
  $fileName=FindSaveFileNameField $dialog
  if(-not $fileName){throw 'Save As file name field was not found'}
  $pathWrite=WriteAndVerifySavePath $fileName $targetBase
  if(-not $pathWrite.ok){throw "Save As file name field did not accept the full target path. Expected: $targetBase; Actual: $($pathWrite.actual)"}
  $save=FindNativeControl $dialog '1' '^Button$'
  if(-not $save){$save=FindByName $dialog "^Save$|^$saveWord$|^Open$|^$openWord$" 'Button'}
  if(-not $save){throw "Save As submit button was not found for target: $targetBase"}
  $submitButtonName=$save.Current.Name
  $dialogClosed=$false
  for($attempt=1;$attempt -le 2 -and -not $dialogClosed;$attempt++){
    $actual=(ReadElementValue $fileName).Trim()
    if($actual -ne $targetBase){
      $pathWrite=WriteAndVerifySavePath $fileName $targetBase
      if(-not $pathWrite.ok){continue}
    }
    if($attempt -eq 1){InvokeElement $save|Out-Null}
    else{try{$fileName.SetFocus()}catch{};Start-Sleep -Milliseconds 150;[Windows.Forms.SendKeys]::SendWait('{ENTER}')}
    for($check=0;$check -lt 32;$check++){
      Start-Sleep -Milliseconds 250
      if(FindSavedTargetFile $targetBase){
        Start-Sleep -Milliseconds 500
        $remainingDialog=FindVisibleSaveDialog
        if($remainingDialog){try{$remainingDialog.SetFocus()}catch{};[Windows.Forms.SendKeys]::SendWait('{ESC}');Start-Sleep -Milliseconds 350}
        $dialogClosed=$true;break
      }
      if(-not (FindVisibleSaveDialog)){$dialogClosed=$true;break}
    }
  }
  if(-not $dialogClosed -and (FindSavedTargetFile $targetBase)){$dialogClosed=$true}
  if(-not $dialogClosed){throw "Save As dialog remained open and no saved file appeared. Target: $targetBase; Field: $(ReadElementValue $fileName); Button: $submitButtonName"}
}

$loginWord=([char]0x767b)+([char]0x5f55)
$stopWord=([char]0x505c)+([char]0x6b62)
$downloadWord=([char]0x4e0b)+([char]0x8f7d)
$uploadPhoto=([char]0x4e0a)+([char]0x4f20)+([char]0x7167)+([char]0x7247)
$fromComputerUpload=([char]0x4ece)+([char]0x7535)+([char]0x8111)+([char]0x4e0a)+([char]0x4f20)
$addPhotosFiles=([char]0x6dfb)+([char]0x52a0)+([char]0x7167)+([char]0x7247)+([char]0x548c)+([char]0x6587)+([char]0x4ef6)
$uploadFile=([char]0x4e0a)+([char]0x4f20)+([char]0x6587)+([char]0x4ef6)
$selectFile=([char]0x9009)+([char]0x62e9)+([char]0x6587)+([char]0x4ef6)
$addFile=([char]0x6dfb)+([char]0x52a0)+([char]0x6587)+([char]0x4ef6)
$photosFiles=([char]0x7167)+([char]0x7247)+([char]0x548c)+([char]0x6587)+([char]0x4ef6)
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
  Result @{found=$true;title=$root.Current.Name;windowHandle=[int64]$root.Current.NativeWindowHandle;hasComposer=$composer;hasLogin=$login;hasSecurity=$security;hasRateLimit=$rateLimit;hasStop=$stop;downloadCount=$downloads;generatedCount=$generatedCount;attachmentCount=$attachmentCount;submitEnabled=$submitEnabled;editCandidates=$editCandidates;buttonCandidates=$buttonCandidates}
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
if($Action -eq 'open-sidebar-chat'){
  $chatTitle=[string]$payload.title;if(-not $chatTitle){throw 'Sidebar chat title is required'}
  $escaped=[Regex]::Escape($chatTitle);$target=FindByName (Root) "^(置顶 )?$escaped$" 'Button|Hyperlink'
  if(-not $target){throw "Sidebar chat was not found: $chatTitle"}
  ClickElement $target|Out-Null;Start-Sleep -Milliseconds 800
  $requireImage=$payload.requireImage -eq $true
  $loaded=$false;for($i=0;$i -lt 120;$i++){
    $hasComposer=[bool](FindByAutomationId (Root) 'prompt-textarea')
    $hasImage=if($requireImage){[bool](FindGeneratedMainImage $false)}else{$true}
    if($hasComposer -and $hasImage){$loaded=$true;break}
    Start-Sleep -Milliseconds 500
  }
  if(-not $loaded){throw "Sidebar chat did not load: $chatTitle"}
  Result @{ok=$true;title=$chatTitle;hasImage=$hasImage}
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
  $mode=EnsureChatModeAndAttachment $freshRoot
  Result @{ok=[bool]$composer;attachmentCount=$attachments;attachmentReady=$mode.ok;modeSwitched=$mode.switched;chatTabFound=$mode.chatTabFound;diagnostic=(GetUploadCompatibilitySummary (Root))}
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
  $chatUrl=$null
  for($i=0;$i -lt 20;$i++){$chatUrl=ReadCurrentChatUrlFromAddress (Root);if($chatUrl){break};Start-Sleep -Milliseconds 500}
  if(-not $chatUrl){
    [Windows.Forms.SendKeys]::SendWait('^l');Start-Sleep -Milliseconds 200;[Windows.Forms.SendKeys]::SendWait('^c');Start-Sleep -Milliseconds 250;$candidate=GetClipboardText;[Windows.Forms.SendKeys]::SendWait('{ESC}')
    if(([string]$candidate) -match '^https://chatgpt\.com/(?:[^?#]*/)?c/[^/?#]+'){$chatUrl=[string]$candidate}
  }
  if(-not $chatUrl){throw 'The prompt appeared to submit, but no ChatGPT conversation URL was created'}
  Result @{ok=$true;attempts=$usedAttempt;chatUrl=$chatUrl}
}
if($Action -eq 'read-marked-response'){
  $begin=[string]$payload.beginMarker;$end=[string]$payload.endMarker
  if(-not $begin -or -not $end){throw 'Response boundary markers are required'}
  $timeoutSeconds=if($payload.timeoutSeconds){[Math]::Max(15,[Math]::Min(300,[int]$payload.timeoutSeconds))}else{180}
  $deadline=[DateTime]::UtcNow.AddSeconds($timeoutSeconds);$lastText='';$stable=0
  while([DateTime]::UtcNow -lt $deadline){
    $pageRoot=Root;if(-not $pageRoot){throw 'ChatGPT Edge window was not found while reading the text response'}
    $parts=New-Object System.Collections.Generic.List[string];$hasStop=$false;$hasRateLimit=$false;$hasSecurity=$false
    foreach($el in (All $pageRoot)){
      try{
        $name=[string]$el.Current.Name;$help=[string]$el.Current.HelpText;$candidate=("$name $help").Trim()
        if($name -match "Stop generating|Stop streaming|^$stopWord"){$hasStop=$true}
        if($candidate -match "$tooFrequentWord|$tooManyWord|$operationFrequentWord|$laterRetryWord|$temporaryLimitWord.*($accessWord|access|visit)|Too many requests|requests? too frequent|rate.?limit|request limit|try again in (a few|several) minutes"){$hasRateLimit=$true}
        if($candidate -match 'captcha|Security check|Unusual activity'){$hasSecurity=$true}
        if($name -and $el.Current.ControlType.ProgrammaticName -match 'Text|Document'){$parts.Add($name)}
      }catch{}
    }
    if($hasRateLimit){throw '__RATE_LIMITED__:ChatGPT reported a request frequency limit during AI creative analysis'}
    if($hasSecurity){throw 'ChatGPT security verification appeared during AI creative analysis'}
    $joined=[string]::Join("`n",$parts)
    $occurrences=0;$cursor=0
    while($cursor -lt $joined.Length){$found=$joined.IndexOf($begin,$cursor,[StringComparison]::Ordinal);if($found -lt 0){break};$occurrences++;$cursor=$found+$begin.Length}
    $start=$joined.LastIndexOf($begin,[StringComparison]::Ordinal)
    $finish=if($start -ge 0){$joined.IndexOf($end,$start+$begin.Length,[StringComparison]::Ordinal)}else{-1}
    if($occurrences -ge 2 -and $start -ge 0 -and $finish -gt $start){
      $text=$joined.Substring($start,$finish+$end.Length-$start)
      if($text -eq $lastText){$stable++}else{$lastText=$text;$stable=1}
      if(-not $hasStop -and $stable -ge 2){Result @{ok=$true;text=$text;occurrences=$occurrences}}
    }else{$stable=0}
    Start-Sleep -Milliseconds 750
  }
  throw "Timed out waiting for a complete marked ChatGPT text response after $timeoutSeconds seconds"
}
if($Action -eq 'upload'){
  $files=@($payload.files|ForEach-Object{[IO.Path]::GetFullPath([string]$_)})
  if(-not $files.Count){throw '__UPLOAD_SOURCE_INVALID__:No reference image path was supplied'}
  foreach($file in $files){if(-not [IO.File]::Exists($file)){throw "__UPLOAD_SOURCE_INVALID__:Reference image file does not exist on this computer: $file"}}
  $expectedTotal=[Math]::Max($files.Count,[int]$payload.expectedTotal)
  $quoted=($files|ForEach-Object{'"'+$_+'"'}) -join ' '
  $root=Root;$mode=EnsureChatModeAndAttachment $root;$root=Root
  if(-not $mode.ok){throw "__UPLOAD_ENTRY_NOT_READY__:Chat mode or attachment entry was not ready; $(GetUploadCompatibilitySummary $root)"}
  $existingFileName=FindVisibleEdgeOpenFileNameField
  if($existingFileName){if(-not (SubmitFileNames $existingFileName $quoted $files)){CloseOpenDialog;throw '__UPLOAD_PICKER_NOT_READY__:The existing file picker did not accept the selected reference paths'};$attached=WaitForAttachments $expectedTotal;Result @{ok=($attached -ge $expectedTotal);incomplete=($attached -lt $expectedTotal);reusedPicker=$true;attachmentCount=$attached}}
  [Windows.Forms.SendKeys]::SendWait('{ESC}'); Start-Sleep -Milliseconds 400
  $knownDialogHandles=@(VisibleOpenDialogHandles)
  $add=FindAttachmentButtonNearComposer $root
  if(-not $add){$add=FindByName $root 'Attach files|Add photos|Upload' 'Button'}
  if(-not $add){throw "__UPLOAD_ENTRY_NOT_READY__:Attachment button was not found; $(GetUploadCompatibilitySummary $root)"}; ClickElement $add|Out-Null; Start-Sleep -Milliseconds 800
  $upload=$null;$fileName=FindVisibleEdgeOpenFileNameField $knownDialogHandles
  if(-not $fileName){for($i=0;$i -lt 12;$i++){ $upload=FindVisibleUploadMenuItem $root; if($upload){break}; $fileName=FindVisibleEdgeOpenFileNameField $knownDialogHandles;if($fileName){break}; Start-Sleep -Milliseconds 200 }}
  if(-not $upload -and -not $fileName){ClickElement $add|Out-Null; Start-Sleep -Milliseconds 800; $root=Root;$upload=FindVisibleUploadMenuItem $root;$fileName=FindVisibleEdgeOpenFileNameField $knownDialogHandles}
  if($upload){ClickUploadMenuItem $upload|Out-Null}
  elseif(-not $fileName){throw "__UPLOAD_ENTRY_NOT_READY__:Compatible upload menu item was not found near the ChatGPT composer; $(GetUploadCompatibilitySummary $root)"}
  if(-not $fileName){$fileName=WaitForNewUploadFileNameField $knownDialogHandles 12}
  # A visible menu without a file picker means the first click missed the
  # command. Re-open it and perform one verified precise retry instead of
  # waiting until the whole upload operation times out.
  if(-not $fileName){
    $root=Root;$add=FindAttachmentButtonNearComposer $root
    $visibleUpload=FindVisibleUploadMenuItem $root
    if(-not $visibleUpload -and $add){ClickElement $add|Out-Null;Start-Sleep -Milliseconds 500;$root=Root;$visibleUpload=FindVisibleUploadMenuItem $root}
    if($visibleUpload){ClickUploadMenuItem $visibleUpload|Out-Null;$fileName=WaitForNewUploadFileNameField $knownDialogHandles 28}
  }
  if(-not $fileName){CloseOpenDialog $knownDialogHandles;throw '__UPLOAD_PICKER_NOT_READY__:A new Edge file picker appeared but its file-name field was not available within 10 seconds'}
  if(-not (SubmitFileNames $fileName $quoted $files)){CloseOpenDialog $knownDialogHandles;throw '__UPLOAD_PICKER_NOT_READY__:The file picker did not accept the selected reference paths within 8 seconds'}
  $attached=WaitForAttachments $expectedTotal
  Result @{ok=($attached -ge $expectedTotal);incomplete=($attached -lt $expectedTotal);attachmentCount=$attached}
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
  $findWaitSeconds=if($payload.findWaitSeconds){[Math]::Max(1,[Math]::Min(45,[int]$payload.findWaitSeconds))}else{8};[Windows.Forms.SendKeys]::SendWait('{ESC}');$main=WaitForGeneratedMainImage $findWaitSeconds;if(-not $main){Result @{found=$false;single=$false;thumbnailCount=0}}
  $maxWaitSeconds=if($payload.maxWaitSeconds){[Math]::Max(2,[Math]::Min(45,[int]$payload.maxWaitSeconds))}else{8};$targetTotal=if($payload.targetTotal){[Math]::Max(1,[int]$payload.targetTotal)}else{5};$deadline=[DateTime]::UtcNow.AddSeconds($maxWaitSeconds);$best=0;$last=-1;$stable=0
  while([DateTime]::UtcNow -lt $deadline){$main=FindGeneratedMainImage $false;if(-not $main){$main=FindGeneratedMainImage $true};if($main){$count=@(FindViewerThumbnails $main).Count;if($count -gt $best){$best=$count};$total=if($best -eq 0){1}elseif($best -ge 4){5}else{$best+1};if($total -eq $last){$stable++}else{$last=$total;$stable=1};if($total -ge $targetTotal -and $stable -ge 6){break}};Start-Sleep -Milliseconds 500}
  Result @{found=$true;single=($best -eq 0);five=($best -ge 4);thumbnailCount=$best;total=if($best -eq 0){1}elseif($best -ge 4){5}else{$best+1}}
}
if($Action -eq 'inspect-viewer-layout'){
  $main=WaitForGeneratedMainImage 20;if(-not $main){Result @{found=$false}}
  $thumbs=@(FindViewerThumbnails $main);$selected=GetSelectedThumbnailIndex $thumbs;$items=@()
  for($i=0;$i -lt $thumbs.Count;$i++){
    $thumb=$thumbs[$i];$el=$thumb.element;$r=$thumb.rect;$isSelected=$false
    try{$selection=$el.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern);$isSelected=$selection.Current.IsSelected}catch{}
    $items+=@{index=$i;name=$el.Current.Name;automationId=$el.Current.AutomationId;className=$el.Current.ClassName;isSelected=$isSelected;hasFocus=$el.Current.HasKeyboardFocus;offscreen=$el.Current.IsOffscreen;patterns=@($el.GetSupportedPatterns()|ForEach-Object{$_.ProgrammaticName});rect=@{x=$r.X;y=$r.Y;width=$r.Width;height=$r.Height}}
  }
  $mr=$main.rect;Result @{found=$true;main=@{name=$main.element.Current.Name;automationId=$main.element.Current.AutomationId;rect=@{x=$mr.X;y=$mr.Y;width=$mr.Width;height=$mr.Height}};selected=$selected;thumbs=$items}
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
if($Action -eq 'inspect-save-dialog-controls'){
  [Windows.Forms.SendKeys]::SendWait('{ESC}');Start-Sleep -Milliseconds 300
  $main=WaitForGeneratedMainImage 20
  if(-not $main){throw 'Image viewer main image was not found'}
  RightClickElement $main.element|Out-Null
  $desktop=[Windows.Automation.AutomationElement]::RootElement;$edgeRect=(Root).Current.BoundingRectangle
  $saveNames=@('Save image as','Save image as...','Save image as (V)',"$saveImageAs","$saveImageAs(V)","$saveImageAs(&V)","$saveAsWord","$saveAsWord(S)","$saveAsWord(&S)")
  $saveAs=$null
  for($i=0;$i -lt 20;$i++){$saveAs=FindExactNameInProcess $desktop $saveNames 'msedge';if($saveAs){break};Start-Sleep -Milliseconds 150}
  if(-not $saveAs){throw 'Save image as menu item was not found'}
  ClickElement $saveAs|Out-Null
  $dialog=$null
  for($wait=0;$wait -lt 24;$wait++){Start-Sleep -Milliseconds 250;$dialog=FindVisibleSaveDialog;if($dialog){break}}
  if(-not $dialog){throw 'Save As dialog was not found after clicking the image context-menu command'}
  $items=@()
  foreach($element in (All $dialog)){
    try{
      if($element.Current.IsOffscreen){continue}
      $rect=$element.Current.BoundingRectangle
      if($rect.Width -le 0 -or $rect.Height -le 0){continue}
      $patterns=@();foreach($pattern in $element.GetSupportedPatterns()){$patterns+=$pattern.ProgrammaticName}
      $items+=@{name=$element.Current.Name;automationId=$element.Current.AutomationId;className=$element.Current.ClassName;type=$element.Current.ControlType.ProgrammaticName;x=[int]$rect.X;y=[int]$rect.Y;width=[int]$rect.Width;height=[int]$rect.Height;patterns=$patterns;value=(ReadElementValue $element)}
    }catch{}
  }
  Result @{dialog=@{name=$dialog.Current.Name;automationId=$dialog.Current.AutomationId;className=$dialog.Current.ClassName};items=$items}
}
if($Action -eq 'save-viewer-images'){
  CloseVisibleSaveDialogs|Out-Null
  $initialMain=WaitForGeneratedMainImage 15
  if(-not $initialMain){throw 'Image viewer main image was not found after waiting 15 seconds'}
  $needed=[int]$payload.needed; $startNumber=[int]$payload.startNumber; $targetDir=[string]$payload.targetDir; $fileStem=[string]$payload.fileStem; $already=@($payload.processedIndexes|ForEach-Object{[int]$_}); $saved=@();$failed=@()
  $initialThumbs=@(FindViewerThumbnails $initialMain);$selectedInfo=GetSelectedThumbnailIndex $initialThumbs;$selectedThumbIndex=[int]$selectedInfo.index
  # ChatGPT currently has two viewer layouts. Some machines expose all five thumbnails;
  # others expose only the four alternatives beside the current large image.
  $thumbnailSequence=@(-1)
  for($i=0;$i -lt $initialThumbs.Count;$i++){if($i -ne $selectedThumbIndex){$thumbnailSequence+=$i}}
  $candidateTotal=[Math]::Min(5,$thumbnailSequence.Count);$previousFingerprint=$null
  for($slot=0;$slot -lt $candidateTotal;$slot++){
    if($saved.Count -ge $needed){break}
    $total=$candidateTotal; if($already -contains $slot){continue}
    $thumbIndex=[int]$thumbnailSequence[$slot]
    if($thumbIndex -ge 0){
      $selected=SelectViewerThumbnail $thumbIndex $previousFingerprint
      if(-not $selected){$failed+=@{index=$slot;reason="Main image did not change after selecting thumbnail $thumbIndex"};continue}
      $main=$selected.main;$previousFingerprint=$selected.fingerprint
    }else{
      $viewer=WaitForViewerAfterSave 0
      if(-not $viewer -or -not $viewer.main){$failed+=@{index=$slot;reason="Image viewer main image was not found for thumbnail $slot"};continue}
      $main=$viewer.main;$previousFingerprint=GetImageRegionFingerprint $main
    }
    $number=$startNumber
    while($true){$baseName="{0}_{1}" -f $fileStem,$number.ToString('000');$existing=@(Get-ChildItem -LiteralPath $targetDir -File -ErrorAction SilentlyContinue|Where-Object{$_.BaseName -eq $baseName});if(-not $existing.Count){break};$number++}
    $before=@(Get-ChildItem -LiteralPath $targetDir -File -ErrorAction SilentlyContinue|ForEach-Object{$_.FullName})
    $saveNames=@('Save image as','Save image as...','Save image as (V)',"$saveImageAs","$saveImageAs(V)","$saveImageAs(&V)","$saveAsWord","$saveAsWord(S)","$saveAsWord(&S)")
    $submitted=$false
    for($menuAttempt=0;$menuAttempt -lt 2 -and -not $submitted;$menuAttempt++){
      [Windows.Forms.SendKeys]::SendWait('{ESC}'); Start-Sleep -Milliseconds 350
      $main=FindGeneratedMainImage $false; if(-not $main){$main=FindGeneratedMainImage $true}; if(-not $main){continue}
      $mainRect=$main.rect; $clickX=[int]($mainRect.X+$mainRect.Width/2); $clickY=[int]($mainRect.Y+$mainRect.Height/2)
      RightClickElement $main.element|Out-Null
      $desktop=[Windows.Automation.AutomationElement]::RootElement; $edgeRect=(Root).Current.BoundingRectangle; $saveAs=$null
      for($i=0;$i -lt 10;$i++){$saveAs=FindExactNameNearPoint $desktop $saveNames $clickX $clickY $edgeRect;if(-not $saveAs){$saveAs=FindExactNameInProcess $desktop $saveNames 'msedge'};if($saveAs){break};Start-Sleep -Milliseconds 150}
      if(-not $saveAs){continue}
      ClickElement $saveAs|Out-Null; Start-Sleep -Milliseconds 700
      try{SubmitSavePath (Join-Path $targetDir $baseName);$submitted=$true}catch{
        $lastSaveError=$_.Exception.Message
        CloseVisibleSaveDialogs|Out-Null
        FocusEdge|Out-Null
        Start-Sleep -Milliseconds 500
      }
    }
    if(-not $submitted){$failed+=@{index=$slot;reason="Save image as failed for thumbnail $slot after 2 attempts. Last error: $lastSaveError"};continue}
    $savedFile=$null;for($i=0;$i -lt 40;$i++){Start-Sleep -Milliseconds 500;$new=@(Get-ChildItem -LiteralPath $targetDir -File -ErrorAction SilentlyContinue|Where-Object{$before -notcontains $_.FullName -and $_.BaseName -eq $baseName -and $_.Extension -ne '.crdownload'});if($new.Count){$savedFile=$new[0].FullName;break}};if(-not $savedFile){$failed+=@{index=$slot;reason="Saved file did not appear for thumbnail $slot"};continue}
    # Do not press Escape here: depending on Edge/Windows version it can close the
    # image viewer itself, leaving only the first image available on the next pass.
    CloseDownloadsFlyoutIfOpen 700|Out-Null
    $viewerAfterSave=WaitForViewerAfterSave 0
    Start-Sleep -Milliseconds 100;$saved+=@{index=$slot;file=$savedFile;total=$total}
    if($slot -lt ($candidateTotal-1) -and (-not $viewerAfterSave -or -not $viewerAfterSave.main)){$failed+=@{index=$slot+1;reason="Image viewer closed after saving thumbnail $slot"};break}
  }
  if($saved.Count){$totalResult=$saved[0].total}else{$totalResult=$candidateTotal}; Result @{saved=$saved;failed=$failed;total=$totalResult;selectedThumbnailIndex=$selectedThumbIndex;selectedThumbnailAssumed=[bool]$selectedInfo.assumed}
}
throw "Unknown action: $Action"
