# Dockerfile — untuk Fly.io (fly launch) atau jalan di mana saja.
# Build: docker build -t muse-team-server .
# Run:   docker run -p 3000:3000 -e MAS_API_KEY=... -e MBAK_API_KEY=... -e ELL_API_KEY=... muse-team-server
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
