# عیب‌یابی

## ماینر authorize نمی‌شود

فرمت username باید دقیقاً `customer.worker` باشد. status مشتری/worker، token جاری یا grace credential، max connections و IP allowlist را بررسی کنید. token قابل بازیابی نیست؛ rotate کنید.

## share ثبت می‌شود ولی پذیرفته نمی‌شود

پیام reject pool، difficulty، job ID و latency را ببینید. receive address روی authorization اثر ندارد. credential upstream و username template را با مستند pool تطبیق دهید. reject همگانی معمولاً شبکه/credential/job و reject یک worker معمولاً تنظیم miner است.

## همه upstreamها قطع‌اند

Test TCP/TLS، DNS، ساعت سیستم و CA را بررسی کنید. cooldown اجازه‌ی hammer کردن pool خراب را نمی‌دهد. gateway در این حالت share جعلی قبول نمی‌کند؛ miner reconnect خواهد کرد.

## deposit تخصیص نمی‌یابد

confirmation/unlocked، تطبیق receive address با upstream و وجود accepted work تخصیص‌نیافته همان upstream را بررسی کنید. pool estimate به‌تنهایی deposit نیست. reorg تخصیص‌یافته تمام payoutها را متوقف و alert بحرانی ایجاد می‌کند.

## payout در FAILED است

قبل از retry، txid را در Bitcoin Core `gettransaction` یا Monero `get_transfers` بررسی کنید. سرویس در execute همین reconciliation را انجام می‌دهد. کمبود موجودی، fee بیش از خروجی، wallet lock، network mismatch و mainnet gate علت‌های رایج‌اند.

## readiness degraded

`/health/ready` فقط PostgreSQL و Redis را می‌سنجد. برای nodeها صفحه Wallets، `docker compose ps` و log محدودشده همان container را ببینید. password/token را داخل فرمان یا screenshot منتشر نکنید.

## رشد دیسک

PostgreSQL raw share retention، Loki/Prometheus retention، node pruning و backup retention را بررسی کنید. accepted share تخصیص‌نیافته عمداً حذف نمی‌شود؛ انباشته‌شدن آن معمولاً نشان‌دهنده‌ی deposit allocation ناقص است.
