# راهنمای عملیات روزانه

## شروع شیفت

- Dashboard، alertها، health کیف‌پول/node، sync height و فضای دیسک را بررسی کنید.
- reject rate، hashrate پنجره‌های 1/5/15 دقیقه و upstream فعال هر worker را با روز قبل مقایسه کنید.
- shareهای `UNKNOWN` را بررسی کنید؛ این shareها خودکار تسویه نمی‌شوند.
- depositهای جدید باید txid/outputRef یکتا، confirmation کافی و وضعیت `ALLOCATED` داشته باشند.

## تسویه

Scheduler در ساعت تنظیم‌شده پنل (پیش‌فرض 00:15 Asia/Tehran) walletها را scan و موجودی تأییدشده را batch می‌کند. مبلغ زیر minimum یا وجهی که pool هنوز نفرستاده به دوره بعد منتقل می‌شود. سقف auto پیش‌فرض صفر است؛ batch در `APPROVAL_REQUIRED` می‌ماند تا Owner با TOTP تأیید کند.

پیش از approval آدرس‌ها، gross/net، fee، موجودی wallet و عدم وجود alert reorg را بررسی کنید. پس از `SIGNED` قطع برنامه امن است؛ restart ابتدا txid را در wallet جست‌وجو می‌کند. هرگز برای خطای مبهم یک payout دستی موازی نسازید.

حالت سهم مالک:

- `RETAIN`: درآمد مالک در treasury باقی می‌ماند.
- `MANUAL`: دکمه برداشت مالک batch می‌سازد.
- `DAILY`: در اجرای روزانه batch می‌سازد.
- `WEEKLY`: فقط weekday تنظیمی (Luxon: دوشنبه=1 تا یکشنبه=7) batch می‌سازد.

تغییر آدرس 24 ساعت pending است. مقادیر بالاتر از سقف به approval اجباری می‌روند.

## خاموش‌کردن

ابتدا اتصال ورودی miner را در firewall ببندید، منتظر resolution درخواست‌های جاری بمانید، Nest را stop و سپس node/Compose را خاموش کنید. PostgreSQL را قبل از backup اجباری kill نکنید. پس از restart، readiness، payoutهای `SIGNED/BROADCAST/FAILED` و shareهای `UNKNOWN` را بررسی کنید.
