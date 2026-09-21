# فعال‌سازی Monero بعداً (روی partie.ir)

این سند برای زمانی است که در رول‌اوت اولیه production فقط Bitcoin را فعال کرده‌اید (طبق تصمیم عملیاتی) و بعداً می‌خواهید Monero را هم اضافه کنید. وضعیت فعلی سرور:

- `MONERO_GATEWAY_TLS_ENABLED=false` در `.env` — listener مونرو (پورت 4443) اصلاً باز نیست.
- profile `monero` در Docker بالا نیست (نه `monerod`، نه `monero-wallet-rpc`).
- پورت `4443/tcp` در UFW بسته است.
- هیچ کیف‌پول Monero‌ای هنوز ساخته نشده.

## ۱. پیش‌نیاز: فضای دیسک

Monero mainnet pruned امروز چیزی حدود ۷۰ تا ۱۱۰+ گیگابایت است و دائم رشد می‌کند. قبل از شروع:

```bash
df -h /var/lib/docker
docker exec mining-gateway-bitcoin-core-1 du -sh /bitcoin
```

اگر Bitcoin هنوز کامل sync نشده، فضای اشغال‌شده‌اش رشد می‌کند تا به سقف `BITCOIN_PRUNE_MIB` برسد (فعلاً ۴۰۰۰۰ MiB ≈ ۴۲GB). قانون سرانگشتی: قبل از فعال کردن Monero حداقل ۱۰۰GB آزاد روی `/var/lib/docker` لازم دارید. اگر کم بود، یک block storage دیگر اضافه و mount کنید (یا دیسک فعلی را از پنل provider بزرگ‌تر کنید).

همچنین RAM سرور فعلاً 3.8GB است. sync هم‌زمان Bitcoin (اگر هنوز تمام نشده) و Monero روی این RAM بسیار کند و پرفشار خواهد بود؛ ترجیحاً صبر کنید تا Bitcoin کامل sync شود، یا RAM را قبلش افزایش دهید.

## ۲. باز کردن listener و فایروال

```bash
sed -i 's/^MONERO_GATEWAY_TLS_ENABLED=false$/MONERO_GATEWAY_TLS_ENABLED=true/' /opt/mining-gateway/.env
ufw allow 4443/tcp
```

## ۳. بالا آوردن profile مونرو و ساخت کیف‌پول mainnet

چون هنوز کیف‌پولی وجود ندارد، یک‌بار با `MONERO_BOOTSTRAP_WALLET=true` بالا می‌آوریم تا کیف‌پول جدید ساخته شود:

```bash
cd /opt/mining-gateway
sed -i 's/^MONERO_BOOTSTRAP_WALLET=false$/MONERO_BOOTSTRAP_WALLET=true/' .env.infrastructure
docker compose -f compose.yaml -f compose.nginx.yaml --env-file .env.infrastructure \
  --profile core --profile bitcoin --profile monero --profile observability --profile backup up -d
docker compose -f compose.yaml -f compose.nginx.yaml --env-file .env.infrastructure logs -f monero-wallet-rpc
```

منتظر خط `A wallet was created` در لاگ بمانید. سپس **فوری**:

```bash
docker exec mining-gateway-monero-wallet-rpc-1 cat /wallet/INITIAL_WALLET_SEED.txt
```

این seed را همان لحظه در یک password manager یا کاغذ آفلاین امن ذخیره کنید — این تنها فرصت شماست. بعد فایل را از داخل volume پاک کنید:

```bash
docker exec mining-gateway-monero-wallet-rpc-1 rm -f /wallet/INITIAL_WALLET_SEED.txt
```

و برای جلوگیری از تلاش دوباره برای ساخت کیف‌پول در راه‌اندازی‌های بعدی:

```bash
sed -i 's/^MONERO_BOOTSTRAP_WALLET=true$/MONERO_BOOTSTRAP_WALLET=false/' /opt/mining-gateway/.env.infrastructure
docker compose -f compose.yaml -f compose.nginx.yaml --env-file .env.infrastructure --profile monero restart monero-wallet-rpc
```

## ۴. صبر برای sync کامل

```bash
docker exec mining-gateway-monerod-1 monerod --data-dir=/monero status
```

بسته به پهنای‌باند و CPU، sync کامل مونرو می‌تواند از چند ساعت تا چند روز طول بکشد. تا `height` برابر ارتفاع واقعی شبکه نشود ادامه ندهید.

## ۵. تأیید نهایی

```bash
cd /opt/mining-gateway
sudo -u mining-gateway pnpm --filter @mitm/server self-test:operational
```

باید هم چک BTC و هم چک XMR پاس شود. سپس طبق [PRODUCTION_NGINX.fa.md](PRODUCTION_NGINX.fa.md) بخش «تنظیم اولیه داخل پنل»، upstream واقعی XMR را در پنل ثبت و Test کنید و receive address را در حساب pool واقعی XMR وارد کنید.
