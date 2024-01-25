FROM node:20.11.0-alpine AS installer
WORKDIR /app
COPY . .
RUN npm install

FROM installer AS builder
WORKDIR /app
RUN npm run build
ENTRYPOINT [ "npm", "run", "serve" ]
