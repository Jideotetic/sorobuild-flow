FROM node:20-bookworm

WORKDIR /app

# Added libdbus-1-3 to satisfy the Stellar CLI shared library dependency
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    tar \
    gzip \
    bash \
    build-essential \
    libdbus-1-3 \
  && rm -rf /var/lib/apt/lists/*

# Install Stellar CLI
RUN curl -L https://github.com/stellar/stellar-cli/releases/download/v27.0.0/stellar-cli-27.0.0-x86_64-unknown-linux-gnu.tar.gz \
  -o /tmp/stellar.tar.gz \
  && tar -xzf /tmp/stellar.tar.gz -C /tmp \
  && find /tmp -type f -name stellar -exec mv {} /usr/local/bin/stellar \; \
  && chmod +x /usr/local/bin/stellar \
  && stellar --version

COPY package*.json ./
RUN npm install

COPY . .

# RUN npm run build

ENV NODE_ENV=production
ENV PORT=4307
ENV STELLAR_CLI=/usr/local/bin/stellar

EXPOSE 4307

CMD ["node", "server/server.mjs"]
