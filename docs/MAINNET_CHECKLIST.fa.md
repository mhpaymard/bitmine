# چک‌لیست فعال‌سازی Mainnet

- [ ] بررسی مستقل حقوقی، مالیاتی، custody و محدودیت جغرافیایی poolها انجام شده است.
- [ ] restore رمز‌شده PostgreSQL و هر دو wallet روی میزبان جدا موفق بوده است.
- [ ] seed/descriptor و کلید age آفلاین، چندنسخه و با کنترل دسترسی نگهداری می‌شوند.
- [ ] حساب سرویس، ACL پوشه secrets، firewall/VLAN/VPN و patching سیستم‌عامل بازبینی شده‌اند.
- [ ] reverse proxy انتخابی (Nginx یا Caddy) فقط مسیر پرتال را عمومی و پنل مدیریت را فقط برای admin IP/VPN باز می‌کند؛ RPC/DB/Redis/metrics عمومی نیستند.
- [ ] متغیر ناامن `NODE_TLS_REJECT_UNAUTHORIZED=0` در service account/environment وجود ندارد.
- [ ] testnet/regtest چرخه کامل deposit → allocation → approval → batch → confirmation را گذرانده است.
- [ ] crash در PREPARE/SIGNED/BROADCAST و reconciliation بدون پرداخت تکراری آزمایش شده است.
- [ ] load پایدار 100 و burst 500، soak 30 دقیقه و آزمون 24 ساعته ثبت شده‌اند.
- [ ] minimum، confirmation، daily auto limit و حداکثر hot-wallet float مستند و دو نفره تأیید شده‌اند.
- [ ] TOTP و recovery code Owner فعال و recovery codeها آفلاین‌اند.
- [ ] alert receiver واقعی و هشدار disk/node/upstream/reject/hashrate/payout آزموده شده است.
- [ ] آدرس‌های مشتری و مالک با یک پرداخت کوچک end-to-end تأیید شده‌اند.
- [ ] فقط پس از موارد بالا `ENABLE_MAINNET_PAYOUTS=true` تنظیم و سرویس کنترل‌شده restart شده است.
