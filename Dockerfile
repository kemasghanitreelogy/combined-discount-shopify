FROM node:20-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY package.json package-lock.json* ./
COPY prisma ./prisma

RUN npm ci --omit=dev && npm cache clean --force
RUN npx prisma generate

COPY . .

RUN npm run build

CMD ["npm", "run", "docker-start"]
