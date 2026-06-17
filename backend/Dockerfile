# syntax=docker/dockerfile:1

# --- Builder ---
FROM golang:1.25-alpine AS builder

WORKDIR /src

# Cache module downloads.
COPY go.mod go.sum* ./
RUN go mod download

# Build the statically linked binary.
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/app ./cmd/api

# --- Runtime ---
FROM alpine:3.20

RUN apk add --no-cache ca-certificates wget && \
    addgroup -S app && adduser -S app -G app

WORKDIR /app
COPY --from=builder /out/app /app/app

ENV APP_PORT=3001
EXPOSE 3001

USER app

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O - http://127.0.0.1:3001/health || exit 1

ENTRYPOINT ["/app/app"]
