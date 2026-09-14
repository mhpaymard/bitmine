# گزارش نهایی فنی

## این سامانه دقیقاً چیست؟

این پروژه یک **Mining Gateway/Proxy حسابدار** است. ماینر LAN به server وصل می‌شود؛ server به نمایندگی او به pool عمومی متصل می‌شود، share را ثبت و پاسخ واقعی pool را برمی‌گرداند. Bitcoin Core و Monero node در این معماری block template برای ماینر تولید نمی‌کنند؛ نقش آن‌ها wallet، مشاهده deposit، امضا و reconciliation پرداخت است.

یک **استخر مستقل** باید full node، block template، coinbase، vardiff، سهم دوره، روش PPLNS/PPS، ریسک orphan و پرداخت block reward را خودش اداره کند. این پروژه چنین ادعایی ندارد و درآمدی پیش از payout واقعی pool ایجاد نمی‌کند.

## تقسیم هش‌ریت با تقسیم پول فرق دارد

در روش hash switching ممکن است 80٪ زمان miner به حساب مشتری و 20٪ به حساب مالک در pool فرستاده شود. نتیجه‌ی مالی دقیق نیست: luck، difficulty، fee و زمان round متفاوت‌اند. این پروژه تمام work را به حساب سرویس در pool می‌فرستد و **deposit واقعی** را بر اساس normalized work پذیرفته‌شده تقسیم می‌کند.

مثال: pool برای یک upstream دقیقاً `1,000,001 sat` واریز کرده است. work پذیرفته‌شده‌ی Alice و Bob به نسبت 2:1 است. largest remainder مبلغ را دقیقاً به `666,667` و `333,334` تقسیم می‌کند. اگر policy هر دو 80/20 باشد:

- Alice: مشتری `533,333` و مالک `133,334 sat`
- Bob: مشتری `266,667` و مالک `66,667 sat`
- جمع مشتریان `800,000`، مالک `200,001` و کل دقیقاً `1,000,001 sat`

rounding هیچ sat/atomic unit را گم یا خلق نمی‌کند. policy ID هنگام share ثبت می‌شود؛ تغییر فردا سهم share دیروز را عوض نمی‌کند.

## Stratum V1 و V2

Bitcoin فاز اول Stratum V1 newline JSON-RPC است: subscribe/authorize/configure/job/difficulty/submit. V1 استاندارد امنیتی یکپارچه و job authentication مدرن ندارد، اما با poolهای عمومی امروز سازگار است. قرارداد adapter جداست تا Stratum V2 بعداً اضافه شود. V2 می‌تواند ارتباط رمز‌شده، negotiation/channel و proxy aggregation استانداردتری بدهد، ولی افزودن آن migration ساده‌ی پیام نیست و به session/channel accounting جدا نیاز دارد.

Monero از JSON-RPC رایج XMRig (`login/job/submit/keepalived`) استفاده می‌کند. target little-endian به difficulty دقیق تبدیل می‌شود. work BTC و XMR هرگز با هم جمع یا تبدیل ارزی نمی‌شوند.

## امانی و زمان پرداخت

وقتی payout استخر وارد hot wallet سرویس می‌شود، سامانه تا زمان پرداخت به مشتری عملاً متولی وجه است. «پرداخت روزانه» یعنی هر روز موجودی confirmed/unlocked پردازش شود؛ اگر pool هنوز وجه نداده باشد چیزی برای پرداخت وجود ندارد. موجودی pending pool فقط estimate است و وارد ledger confirmed نمی‌شود.

دفترکل double-entry این حساب‌ها را جدا می‌کند: treasury asset، allocation clearing، بدهی هر مشتری، درآمد مالک و network fee. BTC و XMR ledger و wallet مستقل دارند. سهم مالک پیش‌فرض در treasury می‌ماند و می‌تواند manual/daily/weekly برداشت شود.

## ایمنی پرداخت

state machine برابر `PLANNED → APPROVAL_REQUIRED/AUTO_APPROVED → SIGNED → BROADCAST → CONFIRMED/FAILED` است. سقف auto پیش‌فرض صفر و mainnet خاموش است. آدرس جدید 24 ساعت cooling دارد. payload امضاشده و txid مورد انتظار پیش از broadcast ذخیره می‌شوند؛ پس از crash، wallet lookup مانع broadcast دوباره می‌شود. fee واقعی با largest remainder متناسب با gross خروجی‌ها تخصیص و از net آن‌ها کم می‌شود.

## مسیر افزودن coin یا protocol

1. `AssetCode` و migrationهای ledger/wallet را اضافه کنید؛ از reuse حساب BTC/XMR خودداری کنید.
2. `PoolAdapter` برای framing، auth/job/share و normalized work بسازید.
3. `WalletAdapter` برای network address، receipt، confirmation/unlock، fee، signing، broadcast و tx lookup بسازید.
4. fake pool و شبکه regtest/stagenet، malformed/timeout/failover و crash points را اضافه کنید.
5. قواعد dust/minimum/reorg و واحد atomic را مستند کنید.
6. panel، metrics، alert و runbook backup/restore را تکمیل کنید.
7. تا عبور از mainnet checklist، gate ارز جدید باید خاموش بماند.

## نتیجه

معماری برای 100 اتصال پایدار طراحی و harness برای 500 اتصال burst فراهم شده است. معیار 25ms/15s یک **هدف پذیرش محیط واقعی** است و باید روی سخت‌افزار، pool و مسیر شبکه‌ی نهایی اندازه‌گیری شود؛ وجود harness به‌تنهایی اثبات SLA نیست. پیش از نگهداری وجه mainnet، آزمون 24ساعته، restore، failover و بازبینی امنیت/حقوقی الزامی است.
