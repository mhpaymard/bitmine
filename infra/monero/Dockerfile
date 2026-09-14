FROM debian:bookworm-slim AS verify

ARG MONERO_VERSION=0.18.5.0
ARG TARGETARCH

RUN apt-get update \
  && apt-get install -y --no-install-recommends bzip2 ca-certificates curl gnupg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /verify
RUN set -eu; \
  case "$TARGETARCH" in \
    amd64) archive="monero-linux-x64-v${MONERO_VERSION}.tar.bz2" ;; \
    *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
  esac; \
  curl -fsSLo "$archive" "https://downloads.getmonero.org/cli/$archive"; \
  curl -fsSLo hashes.txt https://www.getmonero.org/downloads/hashes.txt; \
  curl -fsSLo binaryfate.asc https://raw.githubusercontent.com/monero-project/monero/master/utils/gpg_keys/binaryfate.asc; \
  gpg --batch --import binaryfate.asc; \
  gpg --batch --decrypt hashes.txt > hashes.verified; \
  grep " $archive\$" hashes.verified | sha256sum -c -; \
  tar -xjf "$archive"; \
  mkdir /out; \
  find . -type f \( -name monerod -o -name monero-wallet-rpc -o -name monero-wallet-cli \) -exec cp '{}' /out/ \;

FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gosu \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 10002 --home-dir /monero --shell /usr/sbin/nologin monero
COPY --from=verify /out/ /usr/local/bin/
COPY monero-entrypoint.sh wallet-entrypoint.sh /usr/local/bin/
RUN chmod 0755 /usr/local/bin/monero-entrypoint.sh /usr/local/bin/wallet-entrypoint.sh
VOLUME ["/monero", "/wallet"]
EXPOSE 38080 38081 38088
ENTRYPOINT ["/usr/local/bin/monero-entrypoint.sh"]
CMD ["monerod", "--help"]
