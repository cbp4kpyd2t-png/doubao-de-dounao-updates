const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const script = fs.readFileSync(path.join(__dirname, '..', 'src', 'native-edge.ps1'), 'utf8');

test('原生脚本使用UTF-8输出中文文件路径', () => {
  assert.match(script, /\[Console\]::OutputEncoding=\$utf8Output/);
  assert.match(script, /\$OutputEncoding=\$utf8Output/);
});

test('另存为流程使用窗口控件而非Alt+N快捷键', () => {
  assert.match(script, /function SubmitSavePath/);
  const submitSave = script.slice(script.indexOf('function SubmitSavePath'), script.indexOf('$loginWord='));
  assert.match(script, /Save As file name field was not found/);
  assert.match(script, /function FindSaveFileNameField/);
  assert.match(script, /function WriteAndVerifySavePath/);
  assert.match(submitSave, /Save As file name field did not accept the full target path/);
  assert.match(submitSave, /\^Open\$\|\^\$openWord\$/);
  assert.match(submitSave, /Save As dialog remained open for 15 seconds/);
  const saveAction = script.slice(script.indexOf("if($Action -eq 'save-viewer-images')"));
  assert.doesNotMatch(saveAction, /SendWait\('%n'\)/);
  assert.match(script, /foreach\(\$automationId in @\('1001','1148'\)\)/);
  assert.doesNotMatch(submitSave, /SendWait\('\^l'\)/);
  assert.match(script, /GetDirectoryName\(\$targetBase\)/);
  assert.match(submitSave, /Test-Path -LiteralPath \$targetDir -PathType Container/);
  assert.match(script, /SetValue\(\$targetBase\)/);
  assert.match(script, /FindNativeControl \$dialog '1' '\^Button\$'/);
  assert.match(submitSave, /InvokeElement \$save/);
  assert.match(submitSave, /SendWait\('\{ENTER\}'\)/);
  assert.match(submitSave, /ClickElement \$save/);
  assert.match(submitSave, /Save As dialog remained open for 15 seconds and no saved file appeared/);
  assert.match(script, /function FindSavedTargetFile/);
  assert.match(script, /function FindVisibleSaveDialog/);
  assert.match(submitSave, /FindSavedTargetFile \$targetBase/);
  assert.match(submitSave, /if\(-not \(FindVisibleSaveDialog\)\)/);
  assert.match(script, /function FindExactNameInProcess/);
  assert.match(saveAction, /FindExactNameInProcess \$desktop \$saveNames 'msedge'/);
  assert.match(script, /\$owner\.ProcessName -eq \$processName/);
  assert.match(saveAction, /\$saveImageAs\(&V\)/);
  assert.match(saveAction, /"\$saveAsWord"/);
  assert.match(saveAction, /"\$saveAsWord\(&S\)"/);
  assert.match(saveAction, /ClickElement \$saveAs/);
  assert.doesNotMatch(saveAction, /InvokeElement \$menuTarget/);
});

test('查看器兼容五缩略图和当前大图加四缩略图两种布局', () => {
  const saveAction = script.slice(script.indexOf("if($Action -eq 'save-viewer-images')"));
  assert.match(script, /Sort-Object \{\$_\.rect\.Y\}/);
  assert.match(script, /\$el\.Current\.Name -notmatch "generated image\|\^\$generatedImagePrefix"/);
  assert.match(script, /function ScrollElementIntoView/);
  assert.match(script, /function FindGeneratedMainImage/);
  assert.match(script, /function WaitForGeneratedMainImage/);
  assert.match(script, /function FindViewerThumbnails/);
  assert.match(saveAction, /WaitForGeneratedMainImage 45/);
  assert.match(saveAction, /FindViewerThumbnails \$initialMain/);
  assert.match(script, /generated image\|\^\$generatedImagePrefix/);
  assert.match(script, /\$mainRect\.Y\+\$mainRect\.Height\+800/);
  assert.match(script, /function GetSelectedThumbnailIndex/);
  assert.match(script, /SelectionItemPattern/);
  assert.match(script, /HasKeyboardFocus/);
  assert.match(script, /if\(\$thumbs\.Count -gt 0\)\{return @\{index=0;assumed=\$true\}\}/);
  assert.match(saveAction, /\$thumbnailSequence=@\(\)/);
  assert.match(saveAction, /if\(\$initialThumbs\.Count -ge 5\)/);
  assert.match(saveAction, /else\{\$thumbnailSequence\+=-1/);
  assert.match(saveAction, /\$candidateTotal=\[Math\]::Min\(5,\$thumbnailSequence\.Count\)/);
  assert.match(saveAction, /\$thumbIndex=\[int\]\$thumbnailSequence\[\$slot\]/);
  assert.match(script, /function SelectViewerThumbnail/);
  assert.match(script, /ScrollElementIntoView \$thumb\.element/);
  assert.match(saveAction, /Main image did not change after selecting thumbnail/);
  assert.match(script, /function GetImageRegionFingerprint/);
  assert.match(script, /CopyFromScreen/);
  assert.match(script, /function GetImageFingerprintDistance/);
  assert.match(script, /\$r\.Width\*0\.60/);
  assert.match(script, /\$distance -ge 4\.0/);
  assert.match(saveAction, /\$menuAttempt=0;\$menuAttempt -lt 3/);
  assert.match(saveAction, /FindExactNameNearPoint/);
  assert.match(saveAction, /after 3 attempts/);
  assert.doesNotMatch(saveAction, /if\(-not \$savedFile\).*SendWait\('\{ESC\}'\)/);
  assert.match(saveAction, /WaitForViewerAfterSave 0/);
  assert.match(saveAction, /Image viewer closed after saving thumbnail/);
  assert.match(script, /function DownloadsFlyoutIsOpen/);
  assert.match(script, /function CloseDownloadsFlyoutIfOpen/);
  assert.match(script, /function ThumbnailPointIsClear/);
  assert.match(script, /AutomationElement\]::FromPoint/);
  assert.match(script, /function EnsureThumbnailPointIsClear/);
  assert.match(script, /if\(-not \(EnsureThumbnailPointIsClear \$thumb\.element\)\)\{continue\}/);
  assert.match(script, /\^Open file\$\|\^Show in folder\$/);
  assert.match(script, /AddSeconds\(4\)/);
  assert.match(script, /\$edgePids -contains \$el\.Current\.ProcessId/);
  assert.match(saveAction, /CloseDownloadsFlyoutIfOpen/);
  assert.match(saveAction, /\$lastSaveError=\$_\.Exception\.Message/);
  assert.match(saveAction, /FindVisibleSaveDialog/);
  assert.match(saveAction, /Save image as failed for thumbnail \$slot after 3 attempts\. Last error/);
  assert.match(script, /index=\$slot;file=\$savedFile/);
  assert.match(saveAction, /while\(\$true\).*if\(-not \$existing\.Count\)\{break\};\$number\+\+/s);
  assert.doesNotMatch(saveAction, /if\(\$existing\.Count\)\{\$saved\+=/);
});

test('每次上传前验证新对话没有旧附件', () => {
  const newChat = script.slice(script.indexOf("if($Action -eq 'new-chat')"), script.indexOf("if($Action -eq 'send')"));
  assert.match(newChat, /SendWait\('\{ESC\}'\).*SendWait\('\{ESC\}'\)/s);
  assert.match(newChat, /New chat\|\^\$newChatWord/);
  assert.match(newChat, /ClickElement \$newChat/);
  assert.match(newChat, /attachmentCount/);
  assert.match(newChat, /prompt-textarea/);
  assert.match(newChat, /ClickElement \$removeButtons\[0\]/);
});

test('页面检查提供卡死监控需要的关键计数', () => {
  const inspect = script.slice(script.indexOf("if($Action -eq 'inspect')"), script.indexOf("if($Action -eq 'get-current-chat-url')"));
  assert.match(inspect, /generatedCount/); assert.match(inspect, /attachmentCount/); assert.match(inspect, /submitEnabled/);
  assert.match(inspect, /ControlType\.ProgrammaticName -match 'Button\|Image'/);
});

test('被无视的对话可按记录网址重新打开检查', () => {
  assert.match(script, /Action -eq 'get-current-chat-url'/);
  assert.match(script, /addressEditBox/);
  assert.match(script, /function GetClipboardText/);
  assert.match(script, /SendWait\('\^l'\).*SendWait\('\^c'\)/s);
  assert.match(script, /source=\$source/);
  assert.match(script, /\(\?:\[\^\?#\]\*\/\)\?c\//);
  assert.match(script, /Action -eq 'open-chat-url'/);
  assert.match(script, /Only recorded ChatGPT conversation URLs can be opened/);
  assert.match(script, /Action -eq 'open-sidebar-chat'/);
  assert.match(script, /Sidebar chat did not load/);
});

test('无图片生成时可刷新页面并等待输入框恢复', () => {
  assert.match(script, /Action -eq 'refresh-page'/);
  assert.match(script, /SendWait\('\^r'\)/);
  assert.match(script, /ChatGPT did not recover after refreshing the page/);
});

test('保存失败恢复动作会关闭弹窗返回原对话并再次刷新', () => {
  const fs = require('node:fs'); const script = fs.readFileSync(require.resolve('../src/native-edge.ps1'), 'utf8');
  const action = script.slice(script.indexOf("if($Action -eq 'recover-save-ui')"), script.indexOf("if($Action -eq 'save-viewer-images')"));
  assert.match(action, /SendWait\('\{ESC\}'\)/); assert.match(action, /FocusEdge/);
  assert.match(action, /payload\.chatUrl/); assert.match(action, /SendWait\('\^r'\)/);
  assert.match(action, /prompt-textarea/); assert.match(action, /Result @\{ok=\$true/);
});

test('最终保护会关闭全部Edge进程并用系统Edge重新打开ChatGPT', () => {
  const fs = require('node:fs'); const script = fs.readFileSync(require.resolve('../src/native-edge.ps1'), 'utf8');
  const action = script.slice(script.indexOf("if($Action -eq 'restart-edge-chatgpt')"), script.indexOf("if($Action -eq 'inspect')"));
  assert.match(action, /Get-Process msedge/);
  assert.match(action, /Stop-Process -Force/);
  assert.match(action, /Microsoft\\Edge\\Application\\msedge\.exe/);
  assert.match(action, /Start-Process -FilePath \$edge/);
  assert.match(action, /--new-window/);
  assert.match(action, /https:\/\/chatgpt\.com\//);
  assert.match(action, /hasComposer/);
});

test('保存前持续观察缩略图并识别只有一张图片', () => {
  const action = script.slice(script.indexOf("if($Action -eq 'viewer-image-count')"), script.indexOf("if($Action -eq 'dismiss-alert')"));
  assert.match(action, /maxWaitSeconds/);
  assert.match(action, /targetTotal/);
  assert.match(action, /findWaitSeconds/);
  assert.match(action, /\$stable -ge 6/);
  assert.match(action, /FindViewerThumbnails \$main/);
  assert.match(action, /single=\(\$best -eq 0\)/);
  assert.match(action, /five=\(\$best -ge 4\)/);
});

test('参考图一次提交全部路径并核对附件数量', () => {
  const upload = script.slice(script.indexOf("if($Action -eq 'upload')"), script.indexOf("if($Action -eq 'inspect-attach-menu')"));
  assert.match(upload, /SubmitFileNames \$fileName \$quoted/);
  assert.match(upload, /WaitForAttachments \$payload\.files\.Count/);
  assert.match(upload, /Reference upload incomplete/);
  assert.doesNotMatch(upload, /if\(SelectFilesInOpenDialog \$payload\.files\)\{Result/);
});

test('附件不完整时支持删除全部附件后重传', () => {
  const clear = script.slice(script.indexOf("if($Action -eq 'clear-attachments')"), script.indexOf("if($Action -eq 'send')"));
  assert.match(clear, /CountComposerAttachments/); assert.match(clear, /ClickElement \$remove/); assert.match(clear, /remaining=\$remaining/);
});

test('发送前等待全部附件稳定且上传状态结束', () => {
  assert.match(script, /function ComposerUploadBusy/);
  assert.match(script, /\$count -eq \$expected -and \$stable -ge 4/);
  assert.match(script, /Action -eq 'verify-attachments'/);
  assert.match(script, /uploadBusy=\$busy/);
});

test('发送按钮点击后必须确认页面已提交并支持三次重试', () => {
  const send = script.slice(script.indexOf("if($Action -eq 'send')"), script.indexOf("if($Action -eq 'upload')"));
  assert.match(script, /function SubmissionStarted/);
  assert.match(send, /\$attempt=1;\$attempt -le 3/);
  assert.match(send, /ClickElement \$submit/);
  assert.match(send, /InvokeElement \$submit/);
  assert.match(send, /SendWait\('\{ENTER\}'\)/);
  assert.match(send, /page did not accept the click after 3 attempts/);
});

test('页面检查可识别中英文请求频繁提示并返回限流状态', () => {
  assert.match(script, /\$tooFrequentWord/);
  assert.match(script, /Too many requests/);
  assert.match(script, /try again in \(a few\|several\) minutes/);
  assert.match(script, /hasRateLimit=\$rateLimit/);
});

test('整个任务固定使用首次绑定的Edge窗口句柄', () => {
  assert.match(script, /edgeWindowHandle/);
  assert.match(script, /\[int64\]\$_.MainWindowHandle -eq \$preferred/);
  assert.match(script, /\$visible\.Count -eq 1/);
  assert.match(script, /windowHandle=\[int64\]\$root\.Current\.NativeWindowHandle/);
  assert.match(script, /EdgeProcess -IgnorePreferred/);
});

test('限流识别同时检查控件名称和帮助文本并覆盖更多提示', () => {
  assert.match(script, /\$candidateText=\("\$n \$help"\)\.Trim\(\)/);
  assert.match(script, /\$tooManyWord/);
  assert.match(script, /\$operationFrequentWord/);
  assert.match(script, /\$laterRetryWord/);
  assert.match(script, /rate\.\?limit/);
  assert.match(script, /request limit/);
});
