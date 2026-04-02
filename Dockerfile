FROM mcr.microsoft.com/playwright:v1.40.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci

RUN npx playwright install firefox

COPY . .

CMD ["npm", "start"]
