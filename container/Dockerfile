# Conversion image: LibreOffice (no Java), poppler, libvips with libheif, ffmpeg, metric-compatible
# fonts, and the Go job server. Contract and limits: container/README.md.
# Build context is this directory.

FROM golang:1.24-trixie@sha256:5835f052b784aa39f2fe9070def3568605c8bc3fcd810f10402066348b61e716 AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/bloopconv .

# `docker build --target test` runs the unit tests; the final image never contains them.
FROM build AS test
RUN go vet ./... && go test -race -count=1 ./...

FROM debian:trixie-slim@sha256:8aa5a7bf5a1955bddbe7d74fcdd0b91ab30e74362a8b73af672b0481b35b44a0

# No recommends: that is what keeps the Java runtime out. libheif-plugin-libde265 is the HEIC decoder.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      libreoffice-impress libreoffice-writer libreoffice-calc \
      poppler-utils libvips-tools libheif1 libheif-plugin-libde265 ffmpeg \
      fonts-crosextra-carlito fonts-crosextra-caladea fonts-liberation2 fonts-noto-core \
      fontconfig \
 && rm -rf /var/lib/apt/lists/* \
 && fc-cache -f \
 && find / -xdev -perm /6000 -type f -exec chmod a-s {} + \
 && useradd --uid 10001 --user-group --no-create-home --shell /usr/sbin/nologin conv \
 && install -d -o conv -g conv -m 0700 /work

COPY --from=build /out/bloopconv /usr/local/bin/bloopconv
COPY lo-registry.xcu /opt/bloop/lo-registry.xcu
RUN chmod 0755 /opt/bloop && chmod 0444 /opt/bloop/lo-registry.xcu

USER conv
WORKDIR /work
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/bloopconv"]
