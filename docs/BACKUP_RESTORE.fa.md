# Backup و Restore

## چه چیزهایی باید پشتیبان شوند

- PostgreSQL: customer/worker hash، policy، share aggregate، deposit، ledger، payout و audit.
- Bitcoin descriptor wallet و checksum backup.
- Monero seed/keys، restore height و subaddress mapping.
- فایل‌های `.env`، Caddy/Compose و secretها؛ هر کدام جدا از data backup و با دسترسی محدود.
- کلید خصوصی age که **نباید** روی همان سرور backup باقی بماند.

profile `backup` روزانه `pg_dump --format=custom` می‌گیرد، با recipient عمومی age رمز می‌کند، SHA256 می‌سازد و پیش‌فرض 30 روز نگه می‌دارد. ابتدا `BACKUP_AGE_RECIPIENT` را در `.env.infrastructure` تنظیم کنید.

```powershell
.\scripts\backup-now.ps1
```

## آزمون restore

هر ماه روی یک میزبان جدا انجام دهید:

1. checksum فایل رمز‌شده را بررسی کنید.
2. با کلید age آفلاین آن را decrypt کنید.
3. یک PostgreSQL خالی با همان major version بسازید و `pg_restore --exit-on-error --clean --if-exists` اجرا کنید.
4. `pnpm db:deploy`، query تراز دفترکل و audit-chain check را اجرا کنید.
5. walletها را فقط روی regtest/stagenet restore و آدرس/restore height و مشاهده deposit را بررسی کنید.
6. نتیجه، زمان بازیابی (RTO) و آخرین نقطه داده (RPO) را ثبت کنید.

Restore روی production عملی مخرب است: ابتدا outage را اعلام، snapshot قابل‌بازگشت بگیرید و مقصد database/volume را دو بار کنترل کنید. seed یا descriptor خصوصی را در ticket، log، shell history یا Loki چاپ نکنید.
