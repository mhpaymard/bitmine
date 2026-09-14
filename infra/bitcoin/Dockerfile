FROM debian:bookworm-slim AS verify

ARG BITCOIN_VERSION=31.1
ARG TARGETARCH

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git gnupg xz-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /verify
RUN set -eu; \
  case "$TARGETARCH" in \
    amd64) archive="bitcoin-${BITCOIN_VERSION}-x86_64-linux-gnu.tar.gz" ;; \
    arm64) archive="bitcoin-${BITCOIN_VERSION}-aarch64-linux-gnu.tar.gz" ;; \
    *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
  esac; \
  base="https://bitcoincore.org/bin/bitcoin-core-${BITCOIN_VERSION}"; \
  curl -fsSLO "$base/$archive"; \
  curl -fsSLO "$base/SHA256SUMS"; \
  curl -fsSLO "$base/SHA256SUMS.asc"; \
  git clone --depth 1 https://github.com/bitcoin-core/guix.sigs.git; \
  gpg --batch --import guix.sigs/builder-keys/*.gpg; \
  gpg --batch --verify SHA256SUMS.asc SHA256SUMS; \
  grep " $archive\$" SHA256SUMS | sha256sum -c -; \
  tar -xzf "$archive"; \
  mkdir /out; \
  cp "bitcoin-${BITCOIN_VERSION}/bin/bitcoind" "bitcoin-${BITCOIN_VERSION}/bin/bitcoin-cli" /out/

FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gosu openssl \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 10001 --home-dir /bitcoin --shell /usr/sbin/nologin bitcoin
COPY --from=verify /out/ /usr/local/bin/
COPY entrypoint.sh /usr/local/bin/bitcoin-entrypoint.sh
RUN chmod 0755 /usr/local/bin/bitcoin-entrypoint.sh
VOLUME ["/bitcoin"]
EXPOSE 18443
ENTRYPOINT ["/usr/local/bin/bitcoin-entrypoint.sh"]
