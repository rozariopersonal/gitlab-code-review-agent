FROM node:22-alpine AS base
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .

FROM base AS development
RUN npm install
EXPOSE 3000
CMD ["npm", "run", "dev"]

FROM base AS production
RUN npm ci && npm run build
EXPOSE 3000
CMD ["node", "dist/index.js"]
