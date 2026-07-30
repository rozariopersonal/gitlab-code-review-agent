FROM node:22-alpine
RUN apk add --no-cache git
WORKDIR /agent
COPY ci-review.mjs review-core.js prompt.md ./
ENTRYPOINT ["node", "ci-review.mjs"]
