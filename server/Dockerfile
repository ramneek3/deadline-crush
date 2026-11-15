FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ENV NODE_ENV=production
EXPOSE 4000
CMD ["npx", "tsx", "src/api/main.ts"]
