FROM node:24-alpine

WORKDIR /app
COPY package.json server.mjs ./
COPY public ./public

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.mjs"]
