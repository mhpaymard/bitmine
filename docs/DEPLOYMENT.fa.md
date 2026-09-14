# استقرار Windows و Ubuntu

برای استقرار واقعی Ubuntu، تولید secretها، TLS/renewal، wallet backup، systemd، preflight، تست miner و معیار Go/No-Go از [راهنمای کامل Production](PRODUCTION_RUNBOOK.fa.md) استفاده کنید. این صفحه فقط خلاصه معماری deployment است.

## شبکه و ظرفیت

سرور پیشنهادی: 8 هسته، 16 GiB RAM، SSD با حداقل 250 GiB فضای آزاد و NIC پایدار. پورت‌های plaintext 3333/4444 فقط برای VLAN ماینرها باشند. برای ماینرهای راه دور، Bitcoin Stratum TLS روی 443 و پنل مدیریت HTTPS روی 8443/VPN قرار می‌گیرد. RPC/DB/Redis فقط برای loopback باز باشند.

در `.env`، مقدار `HTTP_HOST=127.0.0.1` بماند، `ADMIN_ORIGIN` را روی URL واقعی HTTPS پنل بگذارید و `TRUST_PROXY` را فقط به loopback و subnet شبکه‌ی Docker محدود کنید. مقدار پیش‌فرض تعداد اتصال‌های احرازنشده از هر IP را با `GATEWAY_MAX_UNAUTHENTICATED_PER_IP=10` محدود می‌کند.

## Windows

1. Node 24 LTS، pnpm 10 و Docker Desktop را نصب کنید.
2. `scripts/setup.ps1 -StartCore` را اجرا کنید.
3. `.env` و `.env.infrastructure` را بازبینی کنید؛ secretها را تغییر ندهید مگر با برنامه rotation.
4. `pnpm db:deploy` و سپس `pnpm bootstrap:admin` را اجرا کنید.
5. برای production: زیرساخت را با `docker compose -f compose.yaml -f compose.production.yaml --env-file .env.infrastructure --profile core up -d` اجرا کنید؛ این override همان certificate معتبر Stratum را برای HTTPS پنل نیز mount می‌کند. سپس `pnpm build` و `scripts/start-production.ps1` را اجرا کنید.
6. برای اجرای سرویس از Task Scheduler یا service wrapper سازمانی استفاده کنید: working directory ریشه پروژه، حساب اختصاصی بدون login تعاملی و restart on failure. دسترسی پوشه `secrets` فقط همان حساب باشد.
7. گواهی و کلید معتبر دامنه mining را در `secrets/stratum-tls-cert.pem` و `secrets/stratum-tls-key.pem` قرار دهید و `scripts/preflight-production.ps1` را اجرا کنید.

## Ubuntu

1. یک user سیستمی `mining-gateway` و مسیر `/opt/mining-gateway` بسازید.
2. Node 24 و pnpm را نصب و `sh scripts/setup.sh` را با همان user اجرا کنید.
3. profileهای موردنیاز Compose و migration را اجرا کنید.
4. `pnpm build`؛ سپس `deploy/systemd/mining-gateway.service` را در `/etc/systemd/system` کپی کنید. اگر مسیر pnpm متفاوت است `ExecStart` را اصلاح کنید.
5. `systemctl daemon-reload && systemctl enable --now mining-gateway`.

## Nodeهای رمزارزی

Bitcoin/Monero imageها هنگام build آرشیو رسمی را با GPG و SHA256 بررسی می‌کنند؛ build اول زمان می‌برد. پیش‌فرض BTC regtest و XMR stagenet است.

برای ساخت اولیه wallet استیج Monero، موقتاً `MONERO_BOOTSTRAP_WALLET=true` بگذارید و profile monero را بالا بیاورید. فایل `/wallet/INITIAL_WALLET_SEED.txt` را فوراً به رسانه آفلاین منتقل، صحت restore را آزمایش و فایل آنلاین را امن حذف کنید؛ سپس flag را false کنید. برای mainnet بهتر است wallet را آفلاین بسازید و volume را از backup کنترل‌شده restore کنید.

## Caddy

`infra/caddy/Caddyfile` فقط برای LAN و CA داخلی است؛ CA root Caddy را روی دستگاه مدیریت trust کنید. در production از `compose.production.yaml` و `infra/caddy/Caddyfile.production` استفاده کنید. گواهی معتبر دامنه را بیرون از Caddy صادر/تمدید و در `secrets/stratum-tls-cert.pem` و `secrets/stratum-tls-key.pem` قرار دهید؛ همان گواهی برای Stratum TLS روی host port 443 و پنل HTTPS روی host port 8443 استفاده می‌شود. چون 443 عمومی در اختیار Stratum است، ACME خودکار مبتنی بر TLS-ALPN روی همان IP قابل اتکا نیست. `ADMIN_ALLOWLIST` را به IP/VPN واقعی محدود کنید و endpointهای `/metrics`، Grafana و RPC را public proxy نکنید.
