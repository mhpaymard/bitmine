# پروکسی و VPN شبکه (SOCKS5 / HTTP / OpenVPN / WireGuard)

این قابلیت به شما اجازه می‌دهد وقتی اتصال مستقیم اینترنت سرور مشکل پیدا کرد، اتصال gateway به استخرهای BTC/XMR یا کل ترافیک خروجی سرور را از یک پروکسی/VPN رد کنید. همه‌چیز از پنل `تنظیمات` قابل کنترل است، بدون نیاز به SSH یا ری‌استارت دستی.

## دو محدوده مستقل

| محدوده          | چه چیزی را عوض می‌کند                                                                      | نیازمندی                                  |
| --------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------- |
| **Gateway**     | فقط اتصالات TCP/TLS خود gateway به استخرهای BTC/XMR (و دکمه‌ی «آزمایش اتصال» در Upstreams) | یک endpoint SOCKS5 یا HTTP proxy          |
| **System-wide** | کل ترافیک خروجی سرور (شامل Bitcoin Core P2P، Monero P2P، backup، git pull و ...)           | یک پیکربندی OpenVPN یا WireGuard آپلودشده |

این دو محدوده را می‌توان همزمان یا جداگانه فعال کرد.

## دو حالت فعال‌سازی

- **`ALWAYS_ON`**: همیشه از پروکسی/VPN استفاده می‌شود.
- **`FAILOVER`** (پیش‌فرض): اتصال مستقیم اولویت دارد؛ فقط وقتی بررسی سلامت دوره‌ای (`healthCheckHost`/`healthCheckPort`) چند بار پیاپی (`healthCheckFailureThreshold`) شکست بخورد، سیستم به پروکسی سوییچ می‌کند و با اولین موفقیت بعدی فوراً به مسیر مستقیم برمی‌گردد.

## معماری Gateway-scope

`apps/server/src/gateway/socket-connect.ts` نقطه‌ی واحد اتصال به همه‌ی upstreamهاست. وقتی پروکسی فعال است، یک تونل SOCKS5 (با پکیج `socks`) یا HTTP CONNECT (پیاده‌سازی دستی) به upstream باز می‌شود؛ اگر upstream نیاز به TLS داشته باشد، TLS روی همان تونل انجام می‌شود. این مسیر کاملاً داخل پردازش هاردن‌شده‌ی برنامه (`mining-gateway.service`) اجرا می‌شود و نیاز به دسترسی root ندارد.

## معماری System-wide

چون تغییر route سیستم‌عامل نیاز به دسترسی root دارد و پردازش اصلی برنامه عمداً هاردن شده (`ProtectSystem=strict`، بدون root)، یک سرویس جدا و مجزا اضافه شده:

- `mining-gateway.service` (بدون تغییر در سطح دسترسی) فقط یک فایل وضعیت کوچک در `/opt/mining-gateway/.local/netproxy/state.json` می‌نویسد.
- `mining-gateway-netproxy.service` (root، جدا، با کپسوله‌سازی خودش) هر ۵ ثانیه این فایل را می‌خواند و بر اساس آن `wg-quick`/`openvpn` را بالا یا پایین می‌آورد. این سرویس هیچ‌وقت مستقیم به دیتابیس یا برنامه‌ی اصلی دسترسی ندارد.

### نصب سرویس netproxy (یک‌بار، روی سرور)

```bash
sudo apt-get install -y openvpn wireguard-tools
sudo install -o root -g root -m 0644 deploy/systemd/mining-gateway-netproxy.service /etc/systemd/system/mining-gateway-netproxy.service
sudo systemctl daemon-reload
sudo systemctl enable --now mining-gateway-netproxy.service
sudo systemctl status --no-pager mining-gateway-netproxy.service
```

همچنین واحد systemd خود برنامه باید بازنصب شود چون یک `ReadWritePaths` جدید اضافه شده:

```bash
sudo install -o root -g root -m 0644 deploy/systemd/mining-gateway.service /etc/systemd/system/mining-gateway.service
sudo systemctl daemon-reload
sudo systemctl restart mining-gateway.service
```

### الزام مهم برای فایل OpenVPN آپلودی

فایل `.ovpn` باید خودش `redirect-gateway def1` (یا معادل) را داشته باشد تا واقعاً default route را عوض کند. OpenVPN به‌صورت استاندارد و ایمن یک route اختصاصی به سرور VPN از طریق gateway اصلی نگه می‌دارد تا خودِ تونل قطع نشود؛ این رفتار پیش‌فرض خود OpenVPN است، نه چیزی که این پروژه اضافه کند.

### هشدار امنیتی درباره‌ی System-wide

فعال کردن این حالت روی یک سرور production که با آن SSH می‌زنید ریسک قطعی موقت دارد اگر پیکربندی VPN دچار مشکل شود. `mining-gateway-netproxy.service` تلاش تازه برای بالا آوردن تونل را حداکثر هر ۳۰ ثانیه یک‌بار انجام می‌دهد و اگر پیکربندی نامعتبر باشد، هیچ تغییری در routing اعمال نمی‌شود (fail closed). با این حال، **اولین فعال‌سازی هر VPN جدید را در یک پنجره‌ی نگهداری و با دسترسی کنسول/out-of-band (نه فقط SSH) امتحان کنید**، نه در یک تغییر بی‌برنامه.

## استفاده از پنل

در `تنظیمات → پروکسی و VPN شبکه`:

1. `فعال‌سازی پروکسی` را بزنید.
2. `حالت فعال‌سازی` را انتخاب کنید (پیشنهاد اولیه: «فقط هنگام قطعی اتصال مستقیم»).
3. برای gateway: نوع (SOCKS5/HTTP)، host، port و در صورت نیاز username/password را وارد کنید.
   - اگر از v2ray استفاده می‌کنید، کافی است v2ray را به‌صورت local روی سرور اجرا کنید (خودتان یا با راهنمایی من) و همان پورت SOCKS محلی آن (مثلاً `127.0.0.1:10808`) را اینجا به‌عنوان SOCKS5 وارد کنید.
4. برای system-wide: چک‌باکس مربوطه را بزنید، نوع VPN (OpenVPN/WireGuard) را انتخاب و محتوای فایل پیکربندی را در کادر متنی paste کنید.
5. ذخیره کنید. وضعیت فعلی (مستقیم/پروکسی) بالای فرم نمایش داده می‌شود.

هیچ‌کدام از این تغییرات نیاز به ری‌استارت دستی سرویس ندارد؛ فقط برای فعال‌سازی اولیه‌ی خود سرویس `mining-gateway-netproxy.service` (یک‌بار) نیاز به دستورات بالا روی سرور دارید.
