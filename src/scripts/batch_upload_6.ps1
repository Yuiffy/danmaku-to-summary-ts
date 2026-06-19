# Batch upload 6 remaining clips
$ErrorActionPreference = "Continue"
$python = "python"
$script = "D:\workspace\myrepo\danmaku-to-summary-ts\src\scripts\bilibili_upload.py"
$suiDir = "D:\files\videos\DDTV录播\25788785_岁己SUI\2026_06_17\own_stream_fun_clips"
$shioriDir = "D:\files\videos\DDTV录播\26966466_栞栞Shiori\2026_06_17\topic_clips"

$results = @()

function Invoke-Upload {
    param($video, $title, $desc, $tags, $cover, $sourceDesc)
    
    $maxRetries = 3
    for ($i = 1; $i -le $maxRetries; $i++) {
        Write-Host "`n========== UPLOAD ATTEMPT $i/$maxRetries ==========" -ForegroundColor Cyan
        Write-Host "Video: $video"
        Write-Host "Title: $title"
        Write-Host "Cover: $cover"
        
        & $python $script $video --title $title --desc $desc --tags $tags --cover $cover --source-desc $sourceDesc 2>&1 | ForEach-Object {
            Write-Host $_
            $_
        }
        $exitCode = $LASTEXITCODE
        
        if ($exitCode -eq 0) {
            Write-Host "✅ Upload SUCCESS" -ForegroundColor Green
            return @{ success = $true; title = $title }
        }
        
        # Check for 406 or rate limit
        $outputText = ($output | Out-String)
        if ($outputText -match "406|rate.?limit|频繁|风控") {
            Write-Host "⚠️ Got 406/rate limit, waiting 10 minutes before retry..." -ForegroundColor Yellow
            if ($i -lt $maxRetries) { Start-Sleep -Seconds 600 }
        } else {
            Write-Host "❌ Upload failed (exit=$exitCode), retrying..." -ForegroundColor Yellow
            if ($i -lt $maxRetries) { Start-Sleep -Seconds 30 }
        }
    }
    return @{ success = $false; title = $title }
}

# ---- 1. 栞栞 clip ----
$video1 = Join-Path $shioriDir "录制-26966466-20260617-210654-819-小栞来！_merged_topic_1-1_003805.mp4"
$cover1 = Join-Path $shioriDir "cover_shiori.jpg"
$title1 = "【小栞】你每次repo都说我在看岁己？明明别的切片也看了啊！"
$desc1 = "主播吐槽别人汇报时老只提岁己，自己明明也看了别的。"
$source1 = "栞栞Shiori 直播《小栞来！》2026-06-17，切片时间(北京时间) 21:44-21:45，直播开始后第38分钟"
$r1 = Invoke-Upload -video $video1 -title $title1 -desc $desc1 -tags "小栞,栞栞Shiori,虚拟主播,直播切片" -cover $cover1 -sourceDesc $source1
$results += $r1

# ---- 2. 岁己 fun_12 ----
$video2 = Join-Path $suiDir "录制-25788785-20260617-223556-486-温柔煮死你_fun_12_015346.mp4"
$cover2 = Join-Path $suiDir "cover_12_sui.jpg"
$title2 = "【小岁】手抓饼全家福也是减肥餐？只吃三分之二就不算过分是吧"
$desc2 = "典型的岁式减脂逻辑，一边点全家福一边试图通过"只吃三分之二"来自我安慰，弹幕纷纷开启吐槽模式。"
$source2 = "岁己SUI 直播《温柔煮死你》2026-06-17，切片时间(北京时间) 00:29-00:31，直播开始后第114分钟"
$r2 = Invoke-Upload -video $video2 -title $title2 -desc $desc2 -tags "小岁,虚拟主播,直播切片,岁AI切片" -cover $cover2 -sourceDesc $source2
$results += $r2

# ---- 3. 岁己 fun_13 ----
$video3 = Join-Path $suiDir "录制-25788785-20260617-223556-486-温柔煮死你_fun_13_015733.mp4"
$cover3 = Join-Path $suiDir "cover_13_sui.jpg"
$title3 = "【小岁】顶级富婆发言：高中最阔绰的时候是早上敢坐下来吃一碗粉"
$desc3 = "岁己回忆高中生活，把"坐着吃粉"而不是"带走包子"作为有钱的象征，这种反差萌和质朴的炫耀感非常有趣。"
$source3 = "岁己SUI 直播《温柔煮死你》2026-06-17，切片时间(北京时间) 00:33-00:34，直播开始后第118分钟"
$r3 = Invoke-Upload -video $video3 -title $title3 -desc $desc3 -tags "小岁,虚拟主播,直播切片,岁AI切片" -cover $cover3 -sourceDesc $source3
$results += $r3

# ---- 4. 岁己 fun_14 ----
$video4 = Join-Path $suiDir "录制-25788785-20260617-223556-486-温柔煮死你_fun_14_020123.mp4"
$cover4 = Join-Path $suiDir "cover_14_sui.jpg"
$title4 = "【小岁】吃鹅肉会变聪明因为鹅有智力？为了证明没吃错鸭子开始疯狂自证"
$desc4 = "从"吃啥补啥"聊到鹅肉皮厚，岁己为了证明自己吃的是正宗烧鹅，强行解释鹅有智力，逻辑逐渐离谱。"
$source4 = "岁己SUI 直播《温柔煮死你》2026-06-17，切片时间(北京时间) 00:37-00:40，直播开始后第121分钟"
$r4 = Invoke-Upload -video $video4 -title $title4 -desc $desc4 -tags "小岁,虚拟主播,直播切片,岁AI切片" -cover $cover4 -sourceDesc $source4
$results += $r4

# ---- 5. 岁己 fun_15 ----
$video5 = Join-Path $suiDir "录制-25788785-20260617-223556-486-温柔煮死你_fun_15_020658.mp4"
$cover5 = Join-Path $suiDir "cover_15_sui.jpg"
$title5 = "【小岁】生场病连吃辣能力都被重塑了？挑战地狱辣薯片直接辣到眼冒金星"
$desc5 = "岁己一本正经地解释"人体很容易被重塑"，抱怨感冒后吃辣能力退化，吃薯片吃到吐舌头的样子很可爱。"
$source5 = "岁己SUI 直播《温柔煮死你》2026-06-17，切片时间(北京时间) 00:42-00:44，直播开始后第127分钟"
$r5 = Invoke-Upload -video $video5 -title $title5 -desc $desc5 -tags "小岁,虚拟主播,直播切片,岁AI切片" -cover $cover5 -sourceDesc $source5
$results += $r5

# ---- 6. 岁己 fun_16 ----
$video6 = Join-Path $suiDir "录制-25788785-20260617-223556-486-温柔煮死你_fun_16_021451.mp4"
$cover6 = Join-Path $suiDir "cover_16_sui.jpg"
$title6 = "【小岁】还说自己是小孩子不能考虑？弹幕直接刷到500岁再说"
$desc6 = "这里先抛出"还是小孩子不能考虑"的前提，弹幕立刻炸出哈哈、妈呀和500岁再说，岁己后面又顺着讲了一段很温柔的鼓励，反差和弹幕反应都很强。"
$source6 = "岁己SUI 直播《温柔煮死你》2026-06-17，切片时间(北京时间) 00:50-00:51，直播开始后第135分钟"
$r6 = Invoke-Upload -video $video6 -title $title6 -desc $desc6 -tags "小岁,虚拟主播,直播切片,岁AI切片" -cover $cover6 -sourceDesc $source6
$results += $r6

# ---- Summary ----
Write-Host "`n========== FINAL SUMMARY ==========" -ForegroundColor Cyan
$successCount = ($results | Where-Object { $_.success }).Count
$failCount = ($results | Where-Object { -not $_.success }).Count
Write-Host "Success: $successCount / 6"
Write-Host "Failed: $failCount / 6"
foreach ($r in $results) {
    $status = if ($r.success) { "✅" } else { "❌" }
    Write-Host "$status $($r.title)"
}

# Output summary as JSON for parsing
$summary = @{ total = 6; success = $successCount; failed = $failCount; results = $results }
$summary | ConvertTo-Json -Depth 3 | Out-File "D:\workspace\myrepo\danmaku-to-summary-ts\src\scripts\upload_results.json" -Encoding UTF8
Write-Host "`nResults saved to upload_results.json"
