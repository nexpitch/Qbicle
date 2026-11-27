# Qbicle scanner en API als container. Draait lokaal en later op EU-hosting.
# Bouwen:  docker build -t qbicle-scanner .
# Scannen: docker run --rm qbicle-scanner voorbeeld.nl
# API:     zie de service 'api' in docker-compose.yml
FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/scanner/package.json packages/scanner/
COPY packages/score/package.json packages/score/
# De scanner gebruikt de kwetsbaarheidsdatabase uit packages/devices (en die packages/inventory).
COPY packages/devices/package.json packages/devices/
COPY packages/inventory/package.json packages/inventory/
COPY packages/platform/package.json packages/platform/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/cockpit/package.json apps/cockpit/
# tsx draait de TypeScript direct; een aparte build-stap volgt bij de web-app.
RUN npm ci --ignore-scripts && npm cache clean --force

COPY tsconfig.json ./
COPY config ./config
COPY packages ./packages
COPY apps ./apps
RUN rm -rf packages/*/test apps/*/test

# Niet als root draaien.
USER node
ENV NODE_ENV=production
ENTRYPOINT ["npx", "--no-install", "tsx", "packages/scanner/src/cli.ts"]
CMD ["--help"]
