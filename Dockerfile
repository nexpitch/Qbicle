# Qbicle scanner als container. Draait lokaal en later op EU-hosting.
# Bouwen:  docker build -t qbicle-scanner .
# Scannen: docker run --rm qbicle-scanner voorbeeld.nl
FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/scanner/package.json packages/scanner/
COPY packages/score/package.json packages/score/
# tsx draait de TypeScript direct; een aparte build-stap volgt bij de web-app.
RUN npm ci --ignore-scripts && npm cache clean --force

COPY tsconfig.json ./
COPY packages ./packages
RUN rm -rf packages/*/test

# Niet als root draaien.
USER node
ENV NODE_ENV=production
ENTRYPOINT ["npx", "--no-install", "tsx", "packages/scanner/src/cli.ts"]
CMD ["--help"]
