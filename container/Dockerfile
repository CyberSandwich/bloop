# Conversion image: LibreOffice (no Java), poppler, libvips with libheif, ffmpeg, metric-compatible
# fonts, and the Go job server. Contract and limits: container/README.md.
# Build context is this directory.

FROM golang:1.26-trixie@sha256:e38b9d87c900de416a12351135e18daa9e477a79faa60fcb108f9b8279b85f8c AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/bloopconv .

# `docker build --target test` runs the unit tests; the final image never contains them.
FROM build AS test
RUN go vet ./... && go test -race -count=1 ./...

FROM debian:trixie-slim@sha256:ab3b3c8c5159eebfca4376430132d53c4d425f869c765ecbe47177a030da575d

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
