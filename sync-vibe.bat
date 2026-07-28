@echo off
setlocal

:: Usage: sync-vibe.bat [commit message]
if "%~1"=="" (
	for /f "tokens=1-5 delims=\/.,: " %%a in ("%date% %time%") do set TIMESTAMP=%%a-%%b-%%c_%%d:%%e
	set "MSG=sync: %TIMESTAMP%"
) else (
	set "MSG=%*"
)

echo [sync-vibe] Adding all changes...
git add -A

echo [sync-vibe] Checking for staged changes...
git diff --cached --quiet --exit-code
if errorlevel 1 (
	echo [sync-vibe] Committing with message: %MSG%
	git commit -m "%MSG%"
	if errorlevel 1 (
		echo [sync-vibe] Commit failed. Aborting.
		endlocal
		exit /b 1
	)
) else (
	echo [sync-vibe] No changes to commit.
)

echo [sync-vibe] Pulling latest from remote (rebase)...
git pull --rebase --autostash
if errorlevel 1 (
	echo [sync-vibe] Pull failed. You may need to resolve conflicts manually.
)

echo [sync-vibe] Pushing to remote...
git push
if errorlevel 1 (
	echo [sync-vibe] Push failed. Check remote permissions/branch.
	endlocal
	exit /b 1
)

echo [sync-vibe] Done.
endlocal