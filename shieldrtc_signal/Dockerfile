FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* tsconfig.json ./
RUN npm ci || npm install
COPY src ./src
EXPOSE 8081 8082
CMD ["npm", "run", "dev"]
