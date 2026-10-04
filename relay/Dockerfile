# The AlmaStudio relay: one static binary, no state.
FROM rust:1-alpine AS build
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM alpine:3
RUN adduser -D -H relay
COPY --from=build /src/target/release/almastudio-relay /usr/local/bin/almastudio-relay
USER relay
ENV RELAY_ADDR=0.0.0.0:8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["almastudio-relay"]
