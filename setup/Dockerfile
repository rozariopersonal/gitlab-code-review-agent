FROM node:22-alpine
RUN apk add --no-cache git docker-cli

# Install dependencies to a non-volatile path (setup/ is mounted at runtime)
COPY package.json /opt/setup-deps/package.json
RUN cd /opt/setup-deps && npm install

WORKDIR /workspace
COPY entrypoint.sh /entrypoint.sh
CMD ["/bin/sh", "/entrypoint.sh"]
