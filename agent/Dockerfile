FROM node:22-alpine AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY *.ts prompt.md tsconfig.json ./
RUN npm run build && cp prompt.md dist/prompt.md

FROM node:22-alpine
RUN apk add --no-cache git
WORKDIR /agent
COPY --from=build /build/dist/ci-review.js /build/dist/gemini.js /build/dist/gitlab.js /build/dist/review-core.js /build/dist/prompt.md ./
ENTRYPOINT ["node", "ci-review.js"]
