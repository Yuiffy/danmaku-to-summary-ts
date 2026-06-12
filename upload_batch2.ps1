$ErrorActionPreference = "Continue"
Set-Location "D:\workspace\myrepo\danmaku-to-summary-ts"

$tags = "岁己SUI,虚拟主播,直播切片,岁己"
$sourceDesc = "岁己SUI 直播 2026-06-07 悠哉悠哉夜晚！"
$tid = 21

$videos = @(
    @{ idx=11; file='D:\files\videos\DDTV录播\25788785_岁己SUI\2026_06_07\own_stream_fun_clips\录制-25788785-20260607-194144-335-悠哉悠哉夜晚！_fun_11_031049.mp4'; title='【岁己】黑绫波丽一出，全场破防'; desc='岁己看到黑绫波丽，反应炸裂。' }
    @{ idx=12; file='D:\files\videos\DDTV录播\25788785_岁己SUI\2026_06_07\own_stream_fun_clips\录制-25788785-20260607-194144-335-悠哉悠哉夜晚！_fun_12_031557.mp4'; title='【岁己】吐槽绫波丽像冷暴力女友'; desc='岁己锐评绫波丽，说她像冷暴力。' }
    @{ idx=13; file='D:\files\videos\DDTV录播\25788785_岁己SUI\2026_06_07\own_stream_fun_clips\录制-25788785-20260607-194144-335-悠哉悠哉夜晚！_fun_13_031929.mp4'; title='【岁己】钢琴双人戏，弹幕嗑疯了'; desc='岁己和角色弹钢琴双人合奏，弹幕集体嗑CP。' }
    @{ idx=14; file='D:\files\videos\DDTV录播\25788785_岁己SUI\2026_06_07\own_stream_fun_clips\录制-25788785-20260607-194144-335-悠哉悠哉夜晚！_fun_14_034655.mp4'; title='【岁己】克隆人设定引爆弹幕'; desc='克隆人话题一出，弹幕瞬间炸了。' }
    @{ idx=15; file='D:\files\videos\DDTV录播\25788785_岁己SUI\2026_06_07\own_stream_fun_clips\录制-25788785-20260607-194144-335-悠哉悠哉夜晚！_fun_15_034848.mp4'; title='【岁己】没电了还在认真讲故事'; desc='岁己手机快没电了，但还是坚持认真讲故事。' }
    @{ idx=16; file='D:\files\videos\DDTV录播\25788785_岁己SUI\2026_06_07\own_stream_fun_clips\录制-25788785-20260607-194144-335-悠哉悠哉夜晚！_fun_16_035635.mp4'; title='【岁己】第四次冲击要来了！'; desc='岁己激动宣布第四次冲击要来了。' }
    @{ idx=17; file='D:\files\videos\DDTV录播\25788785_岁己SUI\2026_06_07\own_stream_fun_clips\录制-25788785-20260607-194144-335-悠哉悠哉夜晚！_fun_17_040149.mp4'; title='【岁己】你哭啥，全都怪你'; desc='岁己和角色互动，最后甩锅：你哭啥全都怪你。' }
    @{ idx=18; file='D:\files\videos\DDTV录播\25788785_岁己SUI\2026_06_07\own_stream_fun_clips\录制-25788785-20260607-194144-335-悠哉悠哉夜晚！_fun_18_043155.mp4'; title='【岁己】先一步成为大人了'; desc='岁己感慨成长话题，先一步成为大人了。' }
)

$results = @()

for ($i = 0; $i -lt $videos.Count; $i++) {
    $v = $videos[$i]
    Write-Host "`n========== [$($v.idx)] $($v.title) ==========" -ForegroundColor Cyan

    $outputFile = [System.IO.Path]::GetTempFileName()
    
    $retryCount = 0
    $maxRetries = 1
    $success = $false
    $bvid = ""
    $link = ""

    while ($retryCount -le $maxRetries -and -not $success) {
        if ($retryCount -gt 0) {
            Write-Host "[RETRY] 第 $retryCount 次重试..." -ForegroundColor Yellow
            Start-Sleep -Seconds 10
        }

        & python src\scripts\bilibili_upload.py $v.file --title $v.title --desc $v.desc --tags $tags --tid $tid --source-desc $sourceDesc 2>&1 | Tee-Object -FilePath $outputFile | Write-Host
        $exitCode = $LASTEXITCODE

        $allOutput = Get-Content $outputFile -Raw

        if ($allOutput -match '(BV[A-Za-z0-9]{10})') {
            $bvid = $matches[1]
            $link = "https://www.bilibili.com/video/$bvid"
            $success = $true
            Write-Host "✅ 成功: $bvid" -ForegroundColor Green
        } elseif ($exitCode -eq 0) {
            # Try to find bvid from output even if regex missed
            if ($allOutput -match 'bvid.*?(BV[A-Za-z0-9]+)') {
                $bvid = $matches[1]
                $link = "https://www.bilibili.com/video/$bvid"
                $success = $true
            } else {
                Write-Host "⚠️ exit code 0 但未找到BV号" -ForegroundColor Yellow
                $success = $true  # consider it success but no bvid
            }
        } else {
            Write-Host "❌ 失败 (exit=$exitCode)" -ForegroundColor Red
        }

        $retryCount++
    }

    Remove-Item $outputFile -ErrorAction SilentlyContinue

    $results += @{
        idx = $v.idx
        title = $v.title
        bvid = $bvid
        link = $link
        success = $success
    }

    # Wait 30 seconds between uploads (except after the last one)
    if ($i -lt $videos.Count - 1) {
        Write-Host "`n⏳ 等待 30 秒..." -ForegroundColor DarkGray
        Start-Sleep -Seconds 30
    }
}

Write-Host "`n`n========== 投稿汇总 ==========" -ForegroundColor Cyan
Write-Host "序号 | 标题 | BV号 | 链接" -ForegroundColor White
Write-Host "--------------------------------" -ForegroundColor DarkGray
foreach ($r in $results) {
    $status = if ($r.success) { "✅" } else { "❌" }
    $bv = if ($r.bvid) { $r.bvid } else { "失败" }
    $lk = if ($r.link) { $r.link } else { "-" }
    Write-Host "$status $($r.idx) | $($r.title) | $bv | $lk"
}
Write-Host "================================" -ForegroundColor Cyan
