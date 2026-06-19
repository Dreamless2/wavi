FROM node:26-alpine

RUN apk add --no-cache git ca-certificates

WORKDIR /app

RUN git clone https://github.com/Dreamless2/pocview .

RUN npm install

RUN npm approve-scripts --all

RUN mkdir -p downloads auth_info_android_bypass

EXPOSE 15000

CMD ["npm", "start"]
