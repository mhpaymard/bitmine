# افزودن استخر عمومی

1. حساب استخر را شخصاً بسازید و قوانین کشور/پرداخت آن را بررسی کنید؛ سامانه حساب خارجی ایجاد نمی‌کند.
2. برای هر upstream یک receive address مستقل بسازید. در BTC یک آدرس descriptor wallet و در XMR ترجیحاً subaddress مستقل استفاده شود.
3. آدرس را در تنظیم payout حساب استخر وارد کنید و همان مقدار را در فیلد `receiveAddress` پنل ثبت کنید.
4. host، port، TLS، priority، timeout، الگوی username و password را وارد کنید. نمونه template: `{username}` یا `account.{customer}{worker}`. قالب نهایی باید دقیقاً با محدودیت worker استخر مقصد سازگار باشد.
5. برای تمام host/portهای جایگزین یک حساب pool، مقدار `accountKey` یکسان وارد کنید. receive address، username template و password آن‌ها نیز باید یکسان باشد؛ برنامه این invariant را کنترل می‌کند.
6. Test connection یک handshake واقعی پروتکل انجام می‌دهد: برای Bitcoin پیام‌های `mining.subscribe` و `mining.authorize` و برای Monero پیام `login` ارسال و پاسخ authorization بررسی می‌شود. این تست share یا payout ایجاد نمی‌کند.
7. ابتدا upstream ثانویه را با priority بزرگ‌تر اضافه و failback cooldown را تنظیم کنید.
8. با fake pool یا حساب تست، accepted/rejected/timeout/malformed/disconnect را اجرا کنید. هیچ share در زمان قطع DB نباید به upstream برسد.

BTC gateway پیام‌های `subscribe`، `configure`، `authorize`، `extranonce.subscribe`، `suggest_difficulty` و `submit` را عبور می‌دهد. درخواست `client.reconnect` upstream به miner منتقل نمی‌شود تا pool نتواند LAN miner را دور بزند.

XMR gateway پیام‌های `login`، `submit` و `keepalived` را پشتیبانی می‌کند و difficulty را از target little-endian job استخراج می‌کند.

در صورت تغییر pool، incompatibility job/extranonce با reconnect کنترل‌شده حل می‌شود. هم‌زمانی یک worker را بیش از نیاز بالا نبرید و برای load test workerهای جدا بسازید.
