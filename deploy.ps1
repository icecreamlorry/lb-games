param([string]$Message = "Update CHROMAGRID")

git config core.hooksPath .githooks
git add index.html deploy.ps1
git commit -m "$Message

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
git push origin main 2>&1 | Tee-Object -Variable out; $out
