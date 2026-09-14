FROM postgres:18.4-bookworm
RUN apt-get update \
  && apt-get install -y --no-install-recommends age ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY entrypoint.sh /usr/local/bin/backup-entrypoint.sh
RUN chmod 0755 /usr/local/bin/backup-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/backup-entrypoint.sh"]
