# استقرار کامل Production با Nginx

این راهنما مسیر پیشنهادی production روی Ubuntu Server 24.04 LTS و معماری `amd64` است. اجرای فرمان‌ها به‌تنهایی مجوز ورود پول واقعی نیست؛ بخش «Go/No-Go» انتهای فایل باید کامل شود.

## ۱. معماری و تداخل پورت 443

روی یک IP عمومی، دو process نمی‌توانند هم‌زمان روی `0.0.0.0:443` گوش کنند. معماری پیش‌فرض این راهنما:

| سرویس                                 | آدرس نمونه          | پورت |
| ------------------------------------- | ------------------- | ---: |
| پرتال و پنل HTTPS از طریق Nginx       | `panel.example.com` |  443 |
| Bitcoin Stratum TLS مستقیم به Gateway | `mine.example.com`  | 3334 |
| Monero TLS مستقیم به Gateway          | `xmr.example.com`   | 4443 |
| API داخلی NestJS                      | `127.0.0.1`         | 3000 |

اگر BTC حتماً باید روی 443 باشد، یک IP عمومی دوم بگیرید: Nginx را با `WEB_BIND_IP` روی IP وب و Gateway را با `BITCOIN_BIND_IP` روی IP ماینینگ bind کنید و `BITCOIN_TLS_PORT=443` بگذارید. multiplex کردن HTTPS و Stratum با SNI برای همه ASICها قابل اتکا نیست و مسیر پیش‌فرض این راهنما نیست.

Nginx فقط `/portal`، `/assets/*` و دو API عمومی پرتال را برای همه باز می‌کند. سایر مسیرها، شامل پنل مدیریت و APIهای آن، فقط برای `ADMIN_CIDR` و loopback باز هستند.

## ۲. اطلاعاتی که قبل از شروع لازم است

این مقادیر را آماده کنید:

- IP عمومی ثابت سرور؛
- `PANEL_DOMAIN`، مثلاً `panel.yourdomain.com`؛
- `MINING_DOMAIN`، مثلاً `mine.yourdomain.com`؛
- `XMR_DOMAIN`، مثلاً `xmr.yourdomain.com`؛
- ایمیل عملیاتی برای Let's Encrypt؛
- IP ثابت مدیریت یا subnet یک VPN به‌عنوان `ADMIN_CIDR`؛
- repository URL و commit/tag بازبینی‌شده؛
- age public recipient برای backup؛ کلید خصوصی age نباید روی production باشد؛
- credential حساب‌های رسمی pool و receive address مختص هر حساب؛
- مقصدهای payout و سیاست fee/minimum که دو نفره بازبینی شده باشند.

هر سه رکورد DNS نوع `A` را به IP سرور اشاره دهید. رکورد `AAAA` را فقط اگر IPv6 واقعاً firewall و route شده است بسازید:

```bash
dig +short A panel.yourdomain.com
dig +short A mine.yourdomain.com
dig +short A xmr.yourdomain.com
```

برای deployment فعلی که هر سه کاربرد را روی `mob.partie.ir` و پورت‌های متفاوت می‌گذارد، یک رکورد `A` کافی است. template آماده آن در [mob.partie.ir.env.example](../deploy/mob.partie.ir.env.example) قرار دارد. تا وقتی `dig +short A mob.partie.ir` IP production را برنگرداند، Certbot را اجرا نکنید.

هیچ password، private key، wallet seed، access token یا age identity را در چت، Git، ticket یا shell history قرار ندهید.

## ۳. حداقل سرور و سیستم‌عامل

برای شروع کوچک: 8 vCPU، 16 GiB RAM و حداقل 250 GiB NVMe آزاد. برای هر دو chain و نگهداری بلندمدت، 500 GiB یا بیشتر حاشیه امن‌تری دارد. disk alert را پیش از mainnet فعال کنید.

```bash
sudo apt-get update
sudo apt-get dist-upgrade -y
sudo apt-get install -y ca-certificates curl gnupg git jq openssl age rsync ufw nginx
sudo timedatectl set-timezone Asia/Tehran
sudo systemctl enable --now systemd-timesyncd
timedatectl status
```

## ۴. نصب Docker رسمی و Node.js 24

Docker را از repository رسمی نصب کنید، نه convenience script:

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker run --rm hello-world
sudo docker compose version
```

Node.js 24 و pnpm pin‌شده پروژه:

```bash
curl -fsSLo /tmp/nodesource_setup_24.sh https://deb.nodesource.com/setup_24.x
less /tmp/nodesource_setup_24.sh
sudo -E bash /tmp/nodesource_setup_24.sh
sudo apt-get install -y nodejs
sudo npm install --global pnpm@10.32.1
node --version
pnpm --version
node -e 'if (+process.versions.node.split(".")[0] !== 24) process.exit(1)'
```

## ۵. کاربر سرویس و release

ابتدا تاریخچه remote شامل secret را طبق بخش امنیت این فایل پاک و همه credentialهای افشاشده را rotate کنید. سپس یک tag یا commit بازبینی‌شده را deploy کنید:

```bash
sudo useradd --system --home-dir /opt/mining-gateway --create-home --shell /usr/sbin/nologin mining-gateway
sudo install -d -o mining-gateway -g mining-gateway -m 0750 /opt/mining-gateway
sudo -u mining-gateway git clone YOUR_REPOSITORY_URL /opt/mining-gateway
cd /opt/mining-gateway
sudo -u mining-gateway git checkout YOUR_REVIEWED_TAG_OR_COMMIT
sudo -u mining-gateway git status --short
```

خروجی status باید خالی باشد. deploy مستقیم از یک working tree دست‌کاری‌شده ممنوع است.

## ۶. secretها و کلید backup

اسکریپت setup فایل موجود را overwrite و secretها را چاپ نمی‌کند:

```bash
cd /opt/mining-gateway
sudo -u mining-gateway sh scripts/setup.sh
sudo chown -R mining-gateway:mining-gateway secrets
sudo chmod 700 secrets
sudo find secrets -maxdepth 1 -type f ! -name .gitkeep -exec chmod 600 {} \;
```

روی یک سیستم آفلاین، نه روی production:

```bash
umask 077
age-keygen -o backup-age-identity.txt
age-keygen -y backup-age-identity.txt > backup-age-recipient.txt
chmod 600 backup-age-identity.txt
```

فقط مقدار عمومی `age1...` را به production ببرید. حداقل دو نسخه کنترل‌شده از identity خصوصی و wallet backupها در محل‌های جدا نگه دارید.

## ۷. فایل پارامترهای deployment

```bash
sudo install -d -o root -g root -m 0700 /etc/mining-gateway
sudo install -o root -g root -m 0600 deploy/mob.partie.ir.env.example /etc/mining-gateway/deploy.env
sudoedit /etc/mining-gateway/deploy.env
```

مقادیر لازم:

| متغیر                  | مقدار                                                      |
| ---------------------- | ---------------------------------------------------------- |
| `PANEL_DOMAIN`         | دامنه HTTPS پنل و پرتال                                    |
| `MINING_DOMAIN`        | hostname گواهی و اتصال BTC                                 |
| `XMR_DOMAIN`           | hostname اتصال XMR                                         |
| `LE_EMAIL`             | ایمیل Let's Encrypt                                        |
| `ADMIN_CIDR`           | یک IP به‌شکل `/32` یا subnet VPN؛ هرگز `0.0.0.0/0` نگذارید |
| `WEB_BIND_IP`          | روی تک-IP برابر `0.0.0.0`؛ روی دو-IP برابر IP وب           |
| `BITCOIN_BIND_IP`      | روی تک-IP برابر `0.0.0.0`؛ روی دو-IP برابر IP ماینینگ      |
| `BITCOIN_TLS_PORT`     | روی تک-IP `3334`؛ با IP دوم می‌تواند `443` باشد            |
| `MONERO_TLS_PORT`      | معمولاً `4443`                                             |
| `BACKUP_AGE_RECIPIENT` | فقط کلید عمومی `age1...`                                   |

فایل را load و envهای واقعی را به‌صورت atomic بسازید:

```bash
sudo -i
set -a
source /etc/mining-gateway/deploy.env
set +a
cd "$PROJECT_ROOT"
bash scripts/render-production-env.sh
grep -nE 'example\.com|replace_with|NODE_TLS_REJECT_UNAUTHORIZED=0' .env .env.infrastructure && exit 1 || true
exit
```

اسکریپت [render-production-env.sh](../scripts/render-production-env.sh) تمام متغیرهای برنامه را می‌نویسد. مقادیر امنیتی مهم آن:

- `HTTP_HOST=127.0.0.1`: API مستقیماً عمومی نیست؛
- `ADMIN_ORIGIN=https://PANEL_DOMAIN`: CORS و cookie فقط origin واقعی؛
- `TRUST_PROXY=127.0.0.1,::1`: فقط Nginx محلی trusted است؛
- listenerهای plaintext خاموش؛
- BTC TLS روی 3334 و XMR TLS روی 4443؛
- هر دو شبکه wallet روی mainnet، اما `ENABLE_MAINNET_PAYOUTS=false`؛
- auto limitهای BTC/XMR صفر؛ بنابراین پرداخت خودکار پول واقعی هنوز فعال نیست؛
- DB، Redis و همه RPCها فقط loopback؛
- backup هر 6 ساعت و retention سی روز.

مقادیر `BITCOIN_MIN_PAYOUT_ATOMIC=50000` و `MONERO_MIN_PAYOUT_ATOMIC=10000000000` نقطه شروع‌اند، نه عدد اقتصادی دائمی. آن‌ها و `maxFeeBps` را با شرایط واقعی شبکه و مدل کسب‌وکار بازبینی کنید. زمان تسویه در DB/Settings ذخیره می‌شود، نه env؛ برای شش ساعت `INTERVAL=360` و برای چهار ساعت `INTERVAL=240` بگذارید.

## ۸. firewall

در cloud firewall/security group:

- `22/tcp`: فقط IP مدیریت یا VPN؛
- `80/tcp`: عمومی برای ACME و redirect؛
- `443/tcp`: عمومی برای پرتال؛ پنل مدیریت در خود Nginx allowlist دارد؛
- `3334/tcp`: عمومی برای BTC Stratum TLS؛
- `4443/tcp`: فقط وقتی XMR ارائه می‌شود؛
- `3000`, `5432`, `6379`, `18443`, `38081`, `38088`, `3001`, `9090`, `9093`, `3100`: عمومی نباشند.

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from YOUR_ADMIN_IP to any port 22 proto tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 3334/tcp
sudo ufw allow 4443/tcp
sudo ufw enable
sudo ufw status verbose
```

Docker ممکن است ruleهای UFW را دور بزند؛ این پروژه پورت‌های DB/RPC/monitoring را فقط روی `127.0.0.1` publish می‌کند. خروجی `docker ps` و chain `DOCKER-USER` را نیز بازبینی کنید.

## ۹. Nginx و گواهی معتبر

Certbot را نصب کنید:

```bash
sudo snap install core
sudo snap refresh core
sudo snap install --classic certbot
sudo ln -sf /snap/bin/certbot /usr/local/bin/certbot
```

پس از انتشار DNS و باز بودن port 80:

```bash
sudo -i
set -a
source /etc/mining-gateway/deploy.env
set +a
cd "$PROJECT_ROOT"
bash scripts/configure-production-nginx.sh
certbot certificates
certbot renew --dry-run
nginx -t
systemctl status --no-pager nginx
exit
```

این اسکریپت:

1. یک vhost موقت HTTP برای ACME می‌سازد؛
2. یک certificate با SAN دامنه‌های panel/mining/XMR می‌گیرد؛
3. certificate را برای listenerهای Stratum با permission محدود کپی می‌کند؛
4. Nginx production را از template نصب می‌کند؛
5. deploy hook تمدید را نصب می‌کند؛
6. بعد از تمدید Nginx را reload و Gateway را restart می‌کند.

## ۱۰. build و اجرای زیرساخت Docker

overlay زیر Caddy را از deployment حذف می‌کند، چون Nginx میزبان جای آن را گرفته است:

```bash
cd /opt/mining-gateway
sudo docker compose -f compose.yaml -f compose.nginx.yaml --env-file .env.infrastructure \
  --profile core --profile bitcoin --profile monero --profile observability --profile backup config --quiet
sudo docker compose -f compose.yaml -f compose.nginx.yaml --env-file .env.infrastructure \
  --profile core --profile bitcoin --profile monero --profile observability --profile backup build --pull
sudo docker compose -f compose.yaml -f compose.nginx.yaml --env-file .env.infrastructure \
  --profile core --profile bitcoin --profile monero --profile observability --profile backup up -d
sudo docker compose -f compose.yaml -f compose.nginx.yaml --env-file .env.infrastructure \
  --profile core --profile bitcoin --profile monero --profile observability --profile backup ps
```

تا PostgreSQL، Redis و wallet/nodeهای مورد استفاده healthy و sync نشده‌اند ادامه ندهید. در rollout BTC-only می‌توانید فعلاً profile Monero را بالا نیاورید، اما قبل از start برنامه باید policy پایش wallet استفاده‌نشده را بازبینی کنید؛ برای انتشار کامل این راهنما هر دو profile را بالا می‌آورد.

## ۱۱. migration، build و Owner

```bash
cd /opt/mining-gateway
sudo -u mining-gateway pnpm db:deploy
sudo -u mining-gateway pnpm build
sudo -u mining-gateway openssl rand -hex -out secrets/bootstrap-admin-password.txt 36
read -rp 'Owner email: ' OWNER_EMAIL
sudo -u mining-gateway env \
  BOOTSTRAP_ADMIN_EMAIL="$OWNER_EMAIL" \
  BOOTSTRAP_ADMIN_PASSWORD_FILE='/opt/mining-gateway/secrets/bootstrap-admin-password.txt' \
  BOOTSTRAP_ADMIN_NAME='Owner' \
  pnpm bootstrap:admin
sudo rm -f secrets/bootstrap-admin-password.txt
unset OWNER_EMAIL
```

رمز را همان لحظه در password manager ذخیره کنید. بعد از اولین ورود، TOTP را فعال و recovery codeها را آفلاین نگه دارید.

## ۱۲. systemd برنامه

```bash
sudo install -o root -g root -m 0644 deploy/systemd/mining-gateway.service /etc/systemd/system/mining-gateway.service
sudo systemctl daemon-reload
sudo systemctl enable --now mining-gateway.service
sudo systemctl status --no-pager mining-gateway.service
sudo journalctl -u mining-gateway.service -n 100 --no-pager
curl -fsS http://127.0.0.1:3000/health/ready | jq
```

## ۱۳. تنظیم اولیه داخل پنل

از یک IP داخل `ADMIN_CIDR` وارد `https://PANEL_DOMAIN` شوید:

1. TOTP مالک را فعال کنید؛
2. upstream رسمی BTC/XMR و failoverهای واقعی را ثبت و Test کنید؛
3. receive address همان حساب pool را در pool ثبت کنید؛
4. customer و worker بسازید و token یک‌بارنمایش worker را امن تحویل دهید؛
5. portal access code جدا بسازید؛
6. مقصد payout مشتری را ثبت کنید و cooling بیست‌وچهارساعته را رعایت کنید؛
7. policy را ابتدا `INTERVAL=360`، `feePayer=OPERATOR` و `dailyAutoLimitAtomic=0` نگه دارید؛
8. alert receiver واقعی را تنظیم و یک هشدار آزمایشی دریافت کنید.

URLهای مشتری:

```text
Portal:   https://panel.yourdomain.com/portal
BTC Pool: stratum+ssl://mine.yourdomain.com:3334
Worker:   customer-slug.worker-slug
Password: one-time worker token
XMR Pool: stratum+ssl://xmr.yourdomain.com:4443
```

## ۱۴. تست کامل قبل از پول واقعی

### کنترل کد و schema

```bash
cd /opt/mining-gateway
sudo -u mining-gateway pnpm install --frozen-lockfile
sudo -u mining-gateway pnpm audit --prod --audit-level high
sudo -u mining-gateway pnpm format:check
sudo -u mining-gateway pnpm lint
sudo -u mining-gateway pnpm typecheck
sudo -u mining-gateway pnpm test
sudo -u mining-gateway pnpm test:coverage
sudo -u mining-gateway pnpm db:validate
sudo -u mining-gateway pnpm build
```

### تست isolated و ماینینگ محلی

```bash
sudo -u mining-gateway pnpm test:e2e:local-mining
sudo -u mining-gateway pnpm test:e2e:local-mining:bitcoin-cpu
sudo -u mining-gateway pnpm test:e2e:local-mining:bitcoin-public
```

تست public به upstream واقعی وصل می‌شود ولی share مالی ارسال نمی‌کند. نتیجه موفق آن درآمد واقعی را اثبات نمی‌کند؛ ارسال share و allocation باید با miner واقعی هم آزمایش شود.

### Nginx، TLS و دسترسی

```bash
sudo nginx -t
curl -fsSI "https://$PANEL_DOMAIN/portal"
curl -fsS "https://$PANEL_DOMAIN/portal" | grep -F '<div id="root"></div>'
openssl s_client -connect "$PANEL_DOMAIN:443" -servername "$PANEL_DOMAIN" -verify_hostname "$PANEL_DOMAIN" -verify_return_error </dev/null
openssl s_client -connect "$MINING_DOMAIN:$BITCOIN_TLS_PORT" -servername "$MINING_DOMAIN" -verify_hostname "$MINING_DOMAIN" -verify_return_error </dev/null
```

از اینترنت و IP خارج `ADMIN_CIDR` این نتایج لازم است:

- `/portal` برابر 200؛
- `/assets/...` برابر 200؛
- `/` و `/api/v1/settings` برابر 403؛
- credential اشتباه پرتال برابر 401؛
- portهای DB/RPC/monitoring بسته باشند.

### preflight عملیاتی

```bash
sudo -i
set -a
source /etc/mining-gateway/deploy.env
set +a
cd "$PROJECT_ROOT"
PREFLIGHT_APP_USER="$SERVICE_USER" \
BASE_URL="https://$PANEL_DOMAIN" \
STRATUM_HOST="$MINING_DOMAIN" \
STRATUM_PORT="$BITCOIN_TLS_PORT" \
COMPOSE_OVERLAY_FILE=compose.nginx.yaml \
bash scripts/preflight-production.sh
exit
```

### miner، failover و load

یک ASIC واقعی یا client آزمایشی را حداقل 24 ساعت متصل نگه دارید. accepted share، reject rate، hashrate، reconnect، failover، memory، file descriptor، disk و upstream latency را ثبت کنید.

```bash
export LOAD_CREDENTIALS_FILE='apps/server/test/load/credentials.json'
export LOAD_HOST='mine.yourdomain.com'
export LOAD_PORT='3334'
export LOAD_CONNECTIONS='100'
export LOAD_HOLD_MS='1800000'
pnpm test:load
export LOAD_CONNECTIONS='500'
export LOAD_HOLD_MS='60000'
pnpm test:load
```

### backup و restore

```bash
sudo docker compose -f compose.yaml -f compose.nginx.yaml --env-file .env.infrastructure \
  --profile core --profile backup run --rm -e BACKUP_INTERVAL_SECONDS=0 postgres-backup
sudo ls -lh backups
(cd backups && sha256sum -c postgres-*.dump.age.sha256)
```

checksum کافی نیست. جدیدترین backup را با [verify-backup-restore.sh](../scripts/verify-backup-restore.sh) روی DB موقت restore کنید و Bitcoin/Monero wallet backup را نیز روی میزبان جدا restore و آدرس‌ها را مقایسه کنید.

## ۱۵. فعال‌سازی mainnet payout

تا همه موارد [MAINNET_CHECKLIST.fa.md](MAINNET_CHECKLIST.fa.md) سبز نشده‌اند، `ENABLE_MAINNET_PAYOUTS=false` باقی بماند. ابتدا با مبلغ بسیار کم چرخه کامل زیر را تست کنید:

```text
pool deposit → confirmation → allocation → customer balance → batch
→ TOTP approval → signing → broadcast → confirmation → portal history
```

پس از بازبینی دو نفره:

```bash
sudo sed -i 's/^ENABLE_MAINNET_PAYOUTS=false$/ENABLE_MAINNET_PAYOUTS=true/' /opt/mining-gateway/.env
sudo systemctl restart mining-gateway.service
sudo systemctl status --no-pager mining-gateway.service
```

در شروع `dailyAutoLimitAtomic=0` بماند تا هر batch نیاز به approval داشته باشد. پس از چند پرداخت کوچک موفق و crash-recovery واقعی، سقف محدود و متناسب با hot-wallet float تعیین کنید. hot wallet نباید موجودی بلندمدت نگه دارد.

## ۱۶. اعمال هر release بعدی

فایل [production-update.sh](../scripts/production-update.sh) فرمان‌ها را پشت‌سرهم و بدون توضیح نگه می‌دارد. فقط وقتی working tree تمیز و backup/restore دوره‌ای سالم است اجرا کنید:

```bash
sudo bash /opt/mining-gateway/scripts/production-update.sh
```

اسکریپت pull فقط fast-forward، نصب frozen، تمام gateهای کیفیت، build، backup قبل از migration، pull/build/up زیرساخت، migration، restart برنامه، reload Nginx و preflight زنده را انجام می‌دهد. migration رو به جلو است؛ rollback کد بدون بررسی سازگاری schema انجام ندهید و هرگز `docker compose down -v` نزنید.

## ۱۷. پاک‌سازی تاریخچه Git

تا زمانی که تاریخ remote حاوی secret/seed/private key/log/backup قبلی است، production Go نیست. همه credentialهای موجود در تاریخ را ابتدا rotate، wallet آلوده را تعویض و certificate را reissue کنید؛ سپس در maintenance window با `git-filter-repo` تاریخ را پاک و force-push کنید. همه cloneهای قدیمی باید حذف و دوباره clone شوند.

## معیار Go/No-Go

Go فقط وقتی مجاز است که DNS و TLS معتبر، Nginx allowlist، chain sync، upstream رسمی با auth واقعی، miner/failover واقعی، 24h soak، restore DB و walletها، TOTP/recovery، alert receiver، payout کم‌مقدار end-to-end، کنترل حقوقی/مالیاتی/custody و preflight کامل همگی پاس شده باشند. تا قبل از آن `ENABLE_MAINNET_PAYOUTS=false` باقی می‌ماند.
