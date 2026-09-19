# راهنمای کامل استقرار Production

این راهنما برای Ubuntu Server 24.04 LTS روی معماری `amd64/x86_64` نوشته شده است. ایمیج فعلی Monero فقط `amd64` را می‌پذیرد. فرمان‌ها را ابتدا روی یک سرور staging اجرا کنید و فقط بعد از تست عملی miner و restore به mainnet بروید.

اگر reverse proxy مورد نظر Nginx است، به‌جای مراحل Caddy همین فایل از [راهنمای Production با Nginx](PRODUCTION_NGINX.fa.md) استفاده کنید؛ آن راهنما تداخل HTTPS و BTC Stratum روی 443، صدور/تمدید certificate، envها و اسکریپت update را پوشش می‌دهد.

در مثال‌ها دامنه `mine.example.com` و ایمیل `ops@example.com` است؛ هر دو را با مقدار واقعی عوض کنید. رمز، seed، recovery code یا کلید خصوصی را در چت، ticket، Git، shell history یا Loki قرار ندهید.

## ۱. خروجی‌ای که به مشتری می‌دهیم

آدرس‌های pool عمومی فقط در پنل به‌عنوان **upstream** ثبت می‌شوند. دستگاه مشتری هرگز credential حساب ViaBTC یا pool اصلی را نمی‌گیرد؛ دستگاه به gateway ما وصل می‌شود:

```text
URL:      stratum+ssl://mine.example.com:443
Username: customer-slug.worker-slug
Password: <one-time worker token>
```

در بعضی firmwareها URL به‌شکل `stratum+tcp://mine.example.com:443` وارد می‌شود و یک گزینه جدا به نام SSL/TLS باید روشن شود. ملاک، handshake واقعی TLS است، نه متن URL یا شماره پورت. پورت 443 ترافیک را رمز می‌کند، اما آن را HTTPS یا نامرئی نمی‌کند؛ IP، SNI/نام دامنه، certificate و الگوی ترافیک همچنان قابل مشاهده‌اند.

BTC TLS روی 443 است. XMR TLS به‌طور پیش‌فرض روی 4443 قرار می‌گیرد، چون دو listener نمی‌توانند روی یک IP و یک port باشند. برای XMR روی 443 باید IP عمومی دوم یا proxy لایه 4 مبتنی بر SNI با دامنه جدا داشته باشید.

سه URL که همگی به همان IP/ماشین ختم می‌شوند high availability واقعی نیستند. برای Pool1/2/3 واقعی، حداقل دو سرور، health check و مسیر شبکه مستقل لازم است.

## ۲. معماری و پورت‌ها

| پورت میزبان                    | مصرف             | دسترسی مجاز                                |
| ------------------------------ | ---------------- | ------------------------------------------ |
| `22/tcp`                       | SSH              | فقط IP مدیریت یا VPN                       |
| `80/tcp`                       | ACME HTTP-01     | عمومی، فقط برای صدور/تمدید certificate     |
| `443/tcp`                      | BTC Stratum TLS  | minerها                                    |
| `4443/tcp`                     | XMR TLS          | فقط اگر XMR ارائه می‌شود                   |
| `8443/tcp+udp`                 | HTTPS Caddy      | `/portal` عمومی؛ پنل/API مدیریت فقط VPN/IP |
| `3000`                         | API داخلی        | فقط loopback                               |
| `5432`, `6379`                 | PostgreSQL/Redis | فقط loopback                               |
| `18443`, `38081`, `38088`      | wallet/node RPC  | فقط loopback                               |
| `3001`, `9090`, `9093`, `3100` | monitoring       | فقط loopback/VPN                           |

حداقل پیشنهادی: 8 vCPU، 16 GiB RAM و 250 GiB SSD آزاد. برای رشد chain، log و backup حاشیه ظرفیت جدا در نظر بگیرید. ساعت سرور باید با NTP همگام باشد.

## ۳. DNS، سیستم‌عامل و firewall

یک رکورد `A` برای `mine.example.com` به IP سرور بسازید. رکورد `AAAA` را فقط وقتی بسازید که IPv6 واقعاً route و firewall شده باشد. قبل از ادامه:

```bash
export MG_DOMAIN='mine.example.com'
export MG_EMAIL='ops@example.com'
getent ahosts "$MG_DOMAIN"
timedatectl status
```

سرور را patch و ابزارهای پایه را نصب کنید:

```bash
sudo apt-get update
sudo apt-get dist-upgrade -y
sudo apt-get install -y ca-certificates curl gnupg git jq openssl age rsync ufw
sudo timedatectl set-timezone Asia/Tehran
sudo systemctl enable --now systemd-timesyncd
```

قواعد cloud firewall/security group را قبل از قواعد سیستم‌عامل تنظیم کنید: 443 و در صورت نیاز 4443 عمومی؛ 22 فقط IP/VPN مدیریت؛ هیچ RPC/DB/Redis/monitoring عمومی نباشد. اگر پرتال مشتری را از همین Caddy ارائه می‌کنید، 8443 را عمومی باز کنید؛ Caddy فقط `/portal`، assetهای رابط و `/api/v1/public/portal/*` را عمومی می‌کند و سایر مسیرها همچنان با `ADMIN_ALLOWLIST` محافظت می‌شوند. برای URL استاندارد HTTPS، یک IP یا web edge جدا روی 443 بهتر است، چون 443 این میزبان در اختیار BTC Stratum است. سپس نمونه UFW:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from YOUR_ADMIN_PUBLIC_IP to any port 22 proto tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 4443/tcp
sudo ufw allow 8443/tcp
sudo ufw enable
sudo ufw status verbose
```

`YOUR_ADMIN_PUBLIC_IP` را دقیق جایگزین کنید. Docker ممکن است قواعد UFW را دور بزند؛ به همین دلیل `ADMIN_BIND_IP` در این راهنما loopback است. اگر 8443 را روی IP VPN bind می‌کنید، علاوه بر cloud firewall قواعد `DOCKER-USER` را نیز بررسی کنید.

اگر پرتال روی همین 8443 عمومی است، `ADMIN_BIND_IP=0.0.0.0` لازم می‌شود؛ در این حالت allowlist خود Caddy و قواعد `DOCKER-USER` را برای مسیرهای مدیریت با یک IP خارج از allowlist نیز آزمایش کنید. صفحه `/portal` باید 200 و `/` باید 403 برگرداند.

## ۴. نصب Docker رسمی و Node 24

Docker را از repository رسمی نصب کنید:

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

Node.js 24 را نصب و major version را کنترل کنید. setup script دانلودشده را پیش از اجرای root بازبینی کنید:

```bash
curl -fsSLo /tmp/nodesource_setup_24.sh https://deb.nodesource.com/setup_24.x
less /tmp/nodesource_setup_24.sh
sudo -E bash /tmp/nodesource_setup_24.sh
sudo apt-get install -y nodejs
sudo npm install --global pnpm@10.32.1
node --version
pnpm --version
node -e 'if (+process.versions.node.split(".")[0] < 24) process.exit(1)'
```

## ۵. حساب سرویس و کپی release

روی production از یک commit/tag بازبینی‌شده استفاده کنید، نه شاخه در حال تغییر:

```bash
sudo useradd --system --home-dir /opt/mining-gateway --create-home --shell /usr/sbin/nologin mining-gateway
sudo install -d -o mining-gateway -g mining-gateway -m 0750 /opt/mining-gateway
sudo rsync -a --delete --exclude .git --exclude node_modules --exclude .env --exclude .env.infrastructure --exclude secrets/ --exclude backups/ ./ /opt/mining-gateway/
sudo chown -R mining-gateway:mining-gateway /opt/mining-gateway
cd /opt/mining-gateway
```

اگر از Git مستقیم روی سرور استفاده می‌کنید، hash مورد انتظار را جداگانه ثبت و کنترل کنید:

```bash
git rev-parse HEAD
git status --short
```

خروجی `git status --short` برای release باید خالی باشد.

## ۶. ساخت secretها

اسکریپت setup هر secret را فقط در صورت نبودن می‌سازد، آن‌ها را چاپ نمی‌کند و فایل موجود را overwrite نمی‌کند:

```bash
sudo -u mining-gateway sh scripts/setup.sh
sudo chown -R mining-gateway:mining-gateway secrets
sudo chmod 700 secrets
sudo find secrets -maxdepth 1 -type f ! -name .gitkeep -exec chmod 600 {} \;
```

فایل‌های زیر ساخته می‌شوند:

- `app-encryption.key`: رمزکردن credentialهای upstream و payloadهای payout با AES-GCM؛
- `cookie-secret.txt`: امضای session؛
- رمز PostgreSQL و Redis؛
- رمز RPC و passphrase walletهای Bitcoin/Monero؛
- رمز admin اولیه Grafana.

برای تولید دستی یک secret جدید از 48 بایت تصادفی:

```bash
umask 077
openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n' > secret.new
test "$(wc -c < secret.new)" -ge 64
```

rotation را با جایگزینی ناگهانی انجام ندهید: `app-encryption.key` بدون re-encrypt کردن داده قبلی credentialها را غیرقابل خواندن می‌کند؛ تغییر passphrase wallet بدون اجرای RPC مربوطه wallet را تغییر نمی‌دهد؛ تغییر DB/Redis باید هم‌زمان در سرویس و URL برنامه اعمال شود.

## ۷. کلید backup را خارج از سرور بسازید

این فرمان‌ها را روی لپ‌تاپ امن/سیستم آفلاین اجرا کنید، نه production:

```bash
umask 077
age-keygen -o backup-age-identity.txt
age-keygen -y backup-age-identity.txt > backup-age-recipient.txt
chmod 600 backup-age-identity.txt
```

`backup-age-identity.txt` کلید خصوصی restore است و نباید روی production قرار بگیرد. فقط خط عمومی `age1...` از `backup-age-recipient.txt` را به سرور منتقل کنید و در مرحله بعد به‌عنوان `BACKUP_AGE_RECIPIENT` بگذارید. حداقل دو کپی آفلاین کنترل‌شده داشته باشید و restore را آزمایش کنید.

## ۸. تنظیم `.env`

در این مثال plaintext خاموش، BTC TLS روی 443 و XMR TLS روی 4443 است. رمزهای URL به‌علت خروجی base64url اسکریپت نیاز به URL-encode ندارند:

```bash
sudo -u mining-gateway bash <<'SCRIPT'
set -euo pipefail
umask 077
pg_password="$(<secrets/postgres-password.txt)"
redis_password="$(<secrets/redis-password.txt)"
cat > .env <<EOF
NODE_ENV=production
HTTP_HOST=127.0.0.1
HTTP_PORT=3000
ADMIN_ORIGIN=https://mine.example.com:8443
TRUST_PROXY=127.0.0.1,::1,172.16.0.0/12
ALLOW_PUBLIC_HTTP_API_IN_PRODUCTION=false
DATABASE_URL=postgresql://mining:${pg_password}@127.0.0.1:5432/mining_gateway?schema=public
REDIS_URL=redis://:${redis_password}@127.0.0.1:6379/0
APP_ENCRYPTION_KEY_FILE=../../secrets/app-encryption.key
COOKIE_SECRET_FILE=../../secrets/cookie-secret.txt
GATEWAY_ENABLED=true
ALLOW_PLAINTEXT_GATEWAY_IN_PRODUCTION=false
BITCOIN_GATEWAY_TCP_ENABLED=false
BITCOIN_GATEWAY_HOST=0.0.0.0
BITCOIN_GATEWAY_PORT=3333
BITCOIN_GATEWAY_TLS_ENABLED=true
BITCOIN_GATEWAY_TLS_HOST=0.0.0.0
BITCOIN_GATEWAY_TLS_PORT=443
BITCOIN_GATEWAY_TLS_CERT_FILE=../../secrets/stratum-tls-cert.pem
BITCOIN_GATEWAY_TLS_KEY_FILE=../../secrets/stratum-tls-key.pem
MONERO_GATEWAY_TCP_ENABLED=false
MONERO_GATEWAY_HOST=0.0.0.0
MONERO_GATEWAY_PORT=4444
MONERO_GATEWAY_TLS_ENABLED=true
MONERO_GATEWAY_TLS_HOST=0.0.0.0
MONERO_GATEWAY_TLS_PORT=4443
MONERO_GATEWAY_TLS_CERT_FILE=../../secrets/stratum-tls-cert.pem
MONERO_GATEWAY_TLS_KEY_FILE=../../secrets/stratum-tls-key.pem
GATEWAY_MAX_CONNECTIONS=500
GATEWAY_MAX_CONNECTIONS_PER_IP=100
GATEWAY_MAX_UNAUTHENTICATED_PER_IP=10
GATEWAY_AUTH_TIMEOUT_MS=15000
GATEWAY_MAX_LINE_BYTES=65536
GATEWAY_IDLE_TIMEOUT_MS=180000
RAW_SHARE_RETENTION_DAYS=14
PAYOUT_TIMEZONE=Asia/Tehran
ENABLE_MAINNET_PAYOUTS=false
BITCOIN_NETWORK=mainnet
BITCOIN_RPC_URL=http://127.0.0.1:18443
BITCOIN_RPC_USER=miningrpc
BITCOIN_RPC_PASSWORD_FILE=../../secrets/bitcoin-rpc-password.txt
BITCOIN_WALLET_NAME=mining-gateway
BITCOIN_WALLET_PASSPHRASE_FILE=../../secrets/bitcoin-wallet-passphrase.txt
BITCOIN_CONFIRMATIONS=6
BITCOIN_MIN_PAYOUT_ATOMIC=50000
BITCOIN_DAILY_AUTO_LIMIT_ATOMIC=0
MONERO_NETWORK=mainnet
MONERO_WALLET_RPC_URL=http://127.0.0.1:38088/json_rpc
MONERO_WALLET_RPC_USER=miningrpc
MONERO_WALLET_RPC_PASSWORD_FILE=../../secrets/monero-rpc-password.txt
MONERO_WALLET_PASSPHRASE_FILE=../../secrets/monero-wallet-passphrase.txt
MONERO_CONFIRMATIONS=10
MONERO_MIN_PAYOUT_ATOMIC=10000000000
MONERO_DAILY_AUTO_LIMIT_ATOMIC=0
LOG_LEVEL=info
SERVE_ADMIN_STATIC=true
EOF
SCRIPT
sudo sed -i 's/mine\.example\.com/YOUR_REAL_DOMAIN/g' .env
sudo chown mining-gateway:mining-gateway .env
sudo chmod 600 .env
```

به‌جای فرمان `sed` می‌توانید با editor دامنه را عوض کنید. سپس مطمئن شوید placeholder باقی نمانده است:

```bash
sudo grep -nE 'example\.com|password|NODE_TLS_REJECT_UNAUTHORIZED=0' .env || true
```

وجود واژه `PASSWORD_FILE` طبیعی است؛ مقدار `NODE_TLS_REJECT_UNAUTHORIZED=0` ممنوع است.

## ۹. تنظیم زیرساخت Compose

مقدار public recipient واقعی age را جایگزین کنید:

```bash
sudo -u mining-gateway bash <<'SCRIPT'
umask 077
cat > .env.infrastructure <<'EOF'
GATEWAY_DOMAIN=YOUR_REAL_DOMAIN
ADMIN_UPSTREAM=host.docker.internal:3000
ADMIN_ALLOWLIST=private_ranges
ADMIN_BIND_IP=127.0.0.1
ADMIN_HTTP_PORT=8080
ADMIN_HTTPS_PORT=8443
POSTGRES_HOST_PORT=5432
BITCOIN_CHAIN=mainnet
BITCOIN_RPC_PORT=18443
BITCOIN_PRUNE_MIB=100000
MONERO_NETWORK=mainnet
MONERO_BOOTSTRAP_WALLET=false
BACKUP_AGE_RECIPIENT=age1_REPLACE_WITH_PUBLIC_RECIPIENT
BACKUP_INTERVAL_SECONDS=86400
BACKUP_RETENTION_DAYS=30
EOF
SCRIPT
sudo sed -i "s/YOUR_REAL_DOMAIN/$MG_DOMAIN/" .env.infrastructure
read -rp 'Paste the public age recipient (age1...): ' BACKUP_RECIPIENT
sudo sed -i "s|age1_REPLACE_WITH_PUBLIC_RECIPIENT|$BACKUP_RECIPIENT|" .env.infrastructure
unset BACKUP_RECIPIENT
sudo chmod 600 .env.infrastructure
sudo grep -nE 'YOUR_REAL_DOMAIN|REPLACE_WITH' .env .env.infrastructure && echo 'PLACEHOLDER FOUND: fix it before continuing'
```

برای دسترسی امن به پنل loopback از SSH tunnel استفاده کنید:

```bash
ssh -L 8443:127.0.0.1:8443 YOUR_SSH_USER@YOUR_SERVER_IP
```

روی کامپیوتر مدیریت، موقتاً `mine.example.com` را به `127.0.0.1` در hosts نگاشت کنید و `https://mine.example.com:8443` را باز کنید تا hostname certificate درست بماند. روش بهتر، WireGuard و bind کردن `ADMIN_BIND_IP` به IP همان VPN است.

## ۱۰. صدور TLS معتبر برای Stratum و پنل

چون 443 برای Stratum است، Caddy نباید روی همان IP از TLS-ALPN برای ACME استفاده کند. از Certbot standalone روی port 80 یا DNS-01 استفاده کنید:

```bash
sudo snap install core
sudo snap refresh core
sudo snap install --classic certbot
sudo ln -sf /snap/bin/certbot /usr/local/bin/certbot
sudo certbot certonly --standalone --preferred-challenges http \
  --domain "$MG_DOMAIN" --email "$MG_EMAIL" --agree-tos --no-eff-email
sudo install -o mining-gateway -g mining-gateway -m 0640 "/etc/letsencrypt/live/$MG_DOMAIN/fullchain.pem" secrets/stratum-tls-cert.pem
sudo install -o mining-gateway -g mining-gateway -m 0600 "/etc/letsencrypt/live/$MG_DOMAIN/privkey.pem" secrets/stratum-tls-key.pem
openssl x509 -in secrets/stratum-tls-cert.pem -noout -subject -issuer -dates -ext subjectAltName
```

اگر port 80 ممکن نیست، از plugin رسمی DNS ارائه‌دهنده استفاده کنید؛ credential محدود DNS را با mode 600 نگه دارید. certificate self-signed برای ASICهای واقعی مناسب production نیست.

hook تمدید را بسازید و دامنه را در آن جایگزین کنید:

```bash
sudo tee /usr/local/sbin/deploy-mining-certificate >/dev/null <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
domain='YOUR_REAL_DOMAIN'
root='/opt/mining-gateway'
install -o mining-gateway -g mining-gateway -m 0640 "/etc/letsencrypt/live/$domain/fullchain.pem" "$root/secrets/stratum-tls-cert.pem"
install -o mining-gateway -g mining-gateway -m 0600 "/etc/letsencrypt/live/$domain/privkey.pem" "$root/secrets/stratum-tls-key.pem"
systemctl try-restart mining-gateway.service
docker compose -f "$root/compose.yaml" -f "$root/compose.production.yaml" --env-file "$root/.env.infrastructure" --profile core restart caddy
SCRIPT
sudo sed -i "s/YOUR_REAL_DOMAIN/$MG_DOMAIN/" /usr/local/sbin/deploy-mining-certificate
sudo chmod 750 /usr/local/sbin/deploy-mining-certificate
sudo certbot renew --dry-run --deploy-hook /usr/local/sbin/deploy-mining-certificate
```

## ۱۱. build ایمیج‌ها و بالا آوردن زیرساخت

Dockerfileهای Bitcoin و Monero هنگام build امضای GPG و SHA256 آرشیو رسمی را بررسی می‌کنند. build اول طولانی است:

```bash
cd /opt/mining-gateway
sudo docker compose -f compose.yaml -f compose.production.yaml --env-file .env.infrastructure \
  --profile core --profile bitcoin --profile monero --profile observability --profile backup config --quiet
sudo docker compose -f compose.yaml -f compose.production.yaml --env-file .env.infrastructure \
  --profile core --profile bitcoin --profile monero --profile observability --profile backup build --pull
sudo docker compose -f compose.yaml -f compose.production.yaml --env-file .env.infrastructure \
  --profile core --profile bitcoin --profile monero --profile observability --profile backup up -d
sudo docker compose --env-file .env.infrastructure \
  --profile core --profile bitcoin --profile monero --profile observability --profile backup ps
```

تا `postgres`, `redis`, `caddy`, `bitcoin-core`, `monerod` و `monero-wallet-rpc` healthy نشده‌اند ادامه ندهید. Sync mainnet ممکن است ساعت‌ها یا روزها طول بکشد.

## ۱۲. ساخت و backup اولیه walletها

Bitcoin wallet رمز‌شده در اولین start ساخته می‌شود. بعد از ساخته‌شدن، backup را به رسانه آفلاین منتقل کنید:

```bash
sudo docker exec mining-gateway-bitcoin-core-1 bitcoin-cli -datadir=/bitcoin -rpcport=18443 \
  -rpcwallet=mining-gateway backupwallet /bitcoin/mining-gateway-wallet-backup.dat
sudo docker cp mining-gateway-bitcoin-core-1:/bitcoin/mining-gateway-wallet-backup.dat ./bitcoin-wallet-backup.dat
sudo chmod 600 bitcoin-wallet-backup.dat
# پس از انتقال و تست restore روی میزبان جدا:
sudo docker exec mining-gateway-bitcoin-core-1 rm -f /bitcoin/mining-gateway-wallet-backup.dat
```

فایل خروجی و passphrase مربوطه را جدا از هم، آفلاین و چندنسخه نگه دارید.

برای ساخت یک‌باره Monero wallet، ابتدا flag را موقتاً true کنید:

```bash
sudo sed -i 's/^MONERO_BOOTSTRAP_WALLET=false$/MONERO_BOOTSTRAP_WALLET=true/' .env.infrastructure
sudo docker compose --env-file .env.infrastructure --profile monero up -d --force-recreate monero-wallet-rpc
sudo docker cp mining-gateway-monero-wallet-rpc-1:/wallet/INITIAL_WALLET_SEED.txt ./INITIAL_WALLET_SEED.txt
sudo chmod 600 INITIAL_WALLET_SEED.txt
```

seed را فوراً به رسانه آفلاین منتقل، restore و آدرس را روی یک میزبان جدا تست کنید. حذف فایل روی SSD/volume تضمین cryptographic erase نیست؛ روش با ریسک کمتر، تولید و restore در محیط ایزوله و انتقال wallet رمز‌شده است. پس از ثبت seed:

```bash
sudo docker exec mining-gateway-monero-wallet-rpc-1 rm -f /wallet/INITIAL_WALLET_SEED.txt
sudo rm -f ./INITIAL_WALLET_SEED.txt
sudo sed -i 's/^MONERO_BOOTSTRAP_WALLET=true$/MONERO_BOOTSTRAP_WALLET=false/' .env.infrastructure
sudo docker compose --env-file .env.infrastructure --profile monero up -d --force-recreate monero-wallet-rpc
```

وضعیت sync را بررسی کنید:

```bash
sudo docker exec mining-gateway-bitcoin-core-1 bitcoin-cli -datadir=/bitcoin -rpcport=18443 getblockchaininfo | jq '{initialblockdownload,verificationprogress,blocks,headers}'
curl -fsS http://127.0.0.1:38081/get_info | jq '{synchronized,height,target_height,nettype}'
```

قبل از payout واقعی، Bitcoin باید `initialblockdownload=false` و Monero باید `synchronized=true` باشد.

## ۱۳. migration، build و Owner اولیه

رمز Owner را بدون قرار دادن در history بسازید و فقط در password manager ذخیره کنید:

```bash
sudo -u mining-gateway pnpm db:deploy
sudo -u mining-gateway pnpm build
sudo -u mining-gateway openssl rand -hex -out secrets/bootstrap-admin-password.txt 36
read -rp 'Owner email: ' OWNER_EMAIL
printf 'Owner password (copy it into the password manager now): '
sudo -u mining-gateway cat secrets/bootstrap-admin-password.txt
echo
read -rp 'After saving it, press Enter to continue: ' _unused
sudo -u mining-gateway env \
  BOOTSTRAP_ADMIN_EMAIL="$OWNER_EMAIL" \
  BOOTSTRAP_ADMIN_PASSWORD_FILE='/opt/mining-gateway/secrets/bootstrap-admin-password.txt' \
  BOOTSTRAP_ADMIN_NAME='Owner' \
  pnpm bootstrap:admin
sudo rm -f secrets/bootstrap-admin-password.txt
unset OWNER_EMAIL _unused
```

`shred` روی همه filesystemها تضمین حذف ندارد؛ فایل موقت فقط برای جلوگیری از ثبت رمز در history است. رمز را در password manager نگه دارید. در اولین ورود TOTP را فعال، recovery codeها را چاپ/آفلاین و یک login با recovery code را در staging آزمایش کنید.

## ۱۴. نصب service برنامه

```bash
sudo install -o root -g root -m 0644 deploy/systemd/mining-gateway.service /etc/systemd/system/mining-gateway.service
sudo systemctl daemon-reload
sudo systemctl enable --now mining-gateway.service
sudo systemctl status --no-pager mining-gateway.service
sudo journalctl -u mining-gateway.service -n 100 --no-pager
curl -fsS http://127.0.0.1:3000/health/ready | jq
```

service با user بدون login، filesystem سخت‌گیری‌شده، `NoNewPrivileges` و فقط capability لازم برای bind کردن 443 اجرا می‌شود.

## ۱۵. ثبت upstream واقعی

در پنل، برای هر حساب pool:

1. از wallet سرویس یک receive address بسازید و همان را در حساب pool به‌عنوان payout address ثبت کنید.
2. endpoint رسمی pool را فقط از سایت رسمی همان pool بگیرید؛ دامنه مشابه یا URL ارسالی در پیام‌رسان را بدون اثبات مالکیت استفاده نکنید.
3. `host`, `port`, protocol و TLS را مطابق مستند رسمی ثبت کنید. port 443 لزوماً TLS نیست.
4. username/password حساب pool را وارد کنید؛ این‌ها با کلید برنامه در DB رمز می‌شوند.
5. endpointهای failover همان حساب باید `accountKey`، credential و receive address یکسان داشته باشند.
6. دکمه Test باید subscribe/authorize واقعی BTC یا login واقعی XMR را موفق برگرداند.

برای ViaBTC BTC، upstream رسمی فعلی از ساختار `btc.viabtc.io:3333` یا `:443` و worker به‌شکل `userID.workerID` استفاده می‌کند. SSL رسمی provider را فقط از فهرست فعلی خودش انتخاب کنید. دامنه‌های شخص ثالث مانند `Bpool.io`، `vbcloud.ir` یا `powhashing` را صرفاً به‌خاطر شباهت نام trusted نکنید.

تا هر دو asset مورد استفاده endpoint سالم و receive address معتبر ندارند، self-test عملیاتی پاس نمی‌شود. اگر XMR ارائه نمی‌دهید، پیش از حذف الزام آن از محصول باید دامنه محصول و کد self-test را آگاهانه تغییر دهید؛ endpoint ساختگی وارد نکنید.

## ۱۶. preflight اجباری

ابتدا admin URL و Stratum host واقعی را بدهید:

```bash
cd /opt/mining-gateway
sudo env \
  PREFLIGHT_APP_USER=mining-gateway \
  BASE_URL="https://$MG_DOMAIN:8443" \
  STRATUM_HOST="$MG_DOMAIN" \
  STRATUM_PORT=443 \
  bash scripts/preflight-production.sh
```

این preflight موارد زیر را fail-closed کنترل می‌کند: Node 24، نبودن TLS bypass، وجود و permission secretها، age recipient، policy production، تطابق key/certificate و حداقل 14 روز اعتبار، Docker/Compose، install frozen، audit dependency، format/lint/typecheck، coverage/test/build، wallet RPC، receive address، احراز هویت واقعی تمام upstreamها، readiness و hostname verification واقعی Stratum TLS.

`SKIP_QUALITY=true` یا `SKIP_LIVE=true` فقط برای عیب‌یابی است و نتیجه آن مجوز release نیست.

## ۱۷. تست miner و soak قبل از پول واقعی

در پنل customer و worker بسازید. token فقط یک‌بار نشان داده می‌شود. روی دستگاه staging:

```text
Pool1 URL = stratum+ssl://mine.example.com:443
Worker    = customer-slug.worker-slug
Password  = token یک‌بارنمایش
```

کنترل کنید: اتصال TLS، authorize، job، accepted share، rejected share، reconnect، failover، قطع Redis/DB، restart برنامه و سقف اتصال/IP. سپس load harness:

```bash
export LOAD_CREDENTIALS_FILE='apps/server/test/load/credentials.json'
export LOAD_CONNECTIONS=100
export LOAD_HOLD_MS=1800000
pnpm test:load

export LOAD_CONNECTIONS=500
export LOAD_HOLD_MS=60000
pnpm test:load
```

بعد از آن soak حداقل 24 ساعت با miner واقعی انجام دهید و نمودار accepted/rejected، memory، file descriptors، reconnect، disk، upstream latency و log errors را ثبت کنید. وجود harness به‌تنهایی SLA را ثابت نمی‌کند.

## ۱۸. backup و restore واقعی

پس از start پروفایل backup، اولین فایل باید در `backups/` ایجاد شود:

```bash
sudo ls -lh backups/
(cd backups && sha256sum -c postgres-*.dump.age.sha256)
```

وجود فایل و checksum به‌تنهایی کافی نیست؛ پیش از هر انتشار و سپس به‌صورت دوره‌ای باید restore واقعی روی دیتابیس موقت انجام شود. اسکریپت زیر روی دیتابیس از قبل موجود overwrite نمی‌کند و دیتابیس موقت خودش را در پایان حذف می‌کند (نام آخرین فایل را جایگزین کنید):

```bash
docker run --rm \
  --network mining-gateway_backend \
  -v "$PWD/backups:/backups:ro" \
  -v "$PWD/secrets:/keys:ro" \
  -v "$PWD/scripts:/project-scripts:ro" \
  -e BACKUP_FILE=postgres-YYYYMMDDTHHMMSSZ.dump.age \
  --entrypoint /bin/sh \
  mining-gateway-postgres-backup \
  /project-scripts/verify-backup-restore.sh
```

نام network و image را در صورت تفاوت deployment اصلاح کنید. کلید خصوصی `age` را فقط برای مدت تست از محل امن و read-only در دسترس کانتینر قرار دهید و سپس از سرور حذف کنید.

ماهانه روی میزبان جدا:

```bash
age --decrypt -i backup-age-identity.txt -o postgres.dump postgres-YYYYMMDDTHHMMSSZ.dump.age
createdb mining_gateway_restore_check
pg_restore --exit-on-error --no-owner --no-acl --dbname mining_gateway_restore_check postgres.dump
psql mining_gateway_restore_check -c 'select migration_name, finished_at from "_prisma_migrations" order by finished_at;'
dropdb mining_gateway_restore_check
```

نام DB مقصد را قبل از restore/drop دوبار بررسی کنید. wallet backupهای BTC/XMR نیز باید روی ماشین جدا restore و آدرس‌های دریافت تطبیق داده شوند.

## ۱۹. فعال‌کردن payout mainnet

`ENABLE_MAINNET_PAYOUTS=false` را تا تکمیل `docs/MAINNET_CHECKLIST.fa.md` تغییر ندهید. ابتدا deposit کوچک واقعی، allocation، approval با TOTP، signing، broadcast، confirmation و crash recovery را با مبلغ ناچیز end-to-end آزمایش کنید. سقف خودکار پیش‌فرض صفر است و بهتر است در شروع صفر بماند. hot wallet فقط float محدود عملیات را نگه دارد.

در پنل Settings، policy مشتری را ابتدا روی `DAILY` نگه دارید. `INTERVAL=60` فقط فاصله تلاش برای ساخت batch را ساعتی می‌کند و نباید با محاسبه سود قطعی اشتباه شود: تا پول upstream واقعاً دریافت و تأیید نشده، pending work بدهی قابل برداشت نیست. `dailyAutoLimitAtomic` سقف تجمعی روز محلی است. برای برداشت رایگان مشتری `feePayer=OPERATOR`، حداقل‌های معقول، `maxFeeBps` و `maxBatchItems` را بر اساس float و شرایط شبکه تعیین کنید. تغییر policy روی batchهای از قبل ساخته‌شده اثر ندارد، چون snapshot policy همراه batch ذخیره می‌شود.

پس از soak می‌توانید برای چرخه ۴ یا ۶ ساعته، حالت `INTERVAL` را روی `240` یا `360` بگذارید. این چرخه فقط تلاش برای ساخت batch است؛ minimum، موجودی تأییدشده، cooling مقصد، سقف خودکار و کنترل fee همچنان اعمال می‌شوند. پیش از عمومی‌کردن پرتال، برای هر customer از صفحه Customers یک access code یک‌بارنمایش بسازید، ورود و تغییر مقصد را از یک IP خارج شبکه مدیریت تست کنید و مطمئن شوید `/` و `/api/v1/settings` از همان IP پاسخ 403 می‌دهند.

پس از تأیید دو نفره checklist:

```bash
sudo sed -i 's/^ENABLE_MAINNET_PAYOUTS=false$/ENABLE_MAINNET_PAYOUTS=true/' .env
sudo systemctl restart mining-gateway.service
sudo systemctl status --no-pager mining-gateway.service
```

## ۲۰. پایش، به‌روزرسانی و rollback

- Grafana فقط روی `127.0.0.1:3001` است؛ user برابر `admin` و رمز در `secrets/grafana-admin-password.txt` است.
- receiver واقعی Alertmanager را پیش از mainnet تنظیم و یک هشدار آزمایشی دریافت کنید.
- disk، unhealthy container، upstream failure، reject rate، hashrate anomaly، wallet scan و payout failure باید alert داشته باشند.
- برای update ابتدا backup و restore check، سپس release جدید در staging، preflight و در نهایت maintenance window انجام دهید.
- migration رو به جلو است؛ rollback کد بدون بررسی سازگاری schema ممنوع است. snapshot و dump قبل از migration بگیرید.
- هرگز `docker compose down -v` روی production اجرا نکنید؛ `-v` wallet، chain، DB و monitoring volumes را حذف می‌کند.

## ۲۱. اگر secret قبلاً وارد Git شده است

حذف فایل در commit جدید کافی نیست؛ همهٔ passwordها، seedها، TLS private key، age identity و backupهایی که در تاریخ repository بوده‌اند compromised محسوب می‌شوند. ابتدا سرویس‌های درگیر را با credential تازه rotate کنید، wallet دارای ارزش را به wallet/seed کاملاً جدید منتقل کنید، certificate را revoke/reissue کنید و sessionها را invalidate کنید. سپس در یک clone آینه‌ای و maintenance window تاریخ را با `git-filter-repo` پاک کنید:

```bash
git clone --mirror YOUR_REPOSITORY_URL mining-gateway-clean.git
cd mining-gateway-clean.git
git filter-repo --invert-paths \
  --path .env \
  --path .env.infrastructure \
  --path secrets \
  --path backups \
  --path logs
git fsck --full
git push --force --mirror
```

قبل از force-push از remote backup مدیریتی بگیرید و با همهٔ توسعه‌دهندگان هماهنگ کنید؛ همه cloneهای قدیمی باید حذف و از نو clone شوند. secret rotation باید **قبل** از rewrite انجام شود، چون clone، fork، CI cache و artifact قبلی ممکن است باقی بماند. در تنظیمات hosting نیز cached artifacts، Actions logs و forkها را بررسی و access tokenهای مرتبط را revoke کنید. preflight این پروژه هر فایل حساس trackedشده را fail می‌کند.

فرمان‌های روزمره:

```bash
sudo systemctl status mining-gateway
sudo journalctl -u mining-gateway -f
sudo docker compose --env-file .env.infrastructure --profile core --profile bitcoin --profile monero --profile observability --profile backup ps
curl -fsS http://127.0.0.1:3000/health/ready | jq
openssl s_client -connect "$MG_DOMAIN:443" -servername "$MG_DOMAIN" -verify_hostname "$MG_DOMAIN" -verify_return_error </dev/null
```

## معیار نهایی Go/No-Go

Go فقط وقتی مجاز است که preflight کامل سبز، chainها sync، upstreamهای رسمی با auth واقعی سالم، miner واقعی و failover آزمایش‌شده، restore DB و هر دو wallet موفق، TLS عمومی معتبر، TOTP/recovery آفلاین، alert receiver واقعی، 24h soak بدون خطای حل‌نشده و بررسی حقوقی/custody کامل باشد. در غیر این صورت سامانه release candidate است، نه production فعال با پول واقعی.
