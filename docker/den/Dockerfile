FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

ARG DEN_VERSION=0.0.6
ARG TARGETARCH=amd64
RUN curl -fsSL "https://github.com/us/den/releases/download/v${DEN_VERSION}/den_${DEN_VERSION}_linux_${TARGETARCH}.tar.gz" \
  | tar -xz -C /usr/local/bin

WORKDIR /etc/den
ENTRYPOINT ["den", "serve", "--config", "/etc/den/den.yaml"]
