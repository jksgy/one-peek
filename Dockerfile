FROM node:20-alpine
WORKDIR /app
COPY server.js .
COPY public ./public
ENV PORT=3456
EXPOSE 3456
VOLUME ["/app/data"]
CMD ["node", "server.js"]
