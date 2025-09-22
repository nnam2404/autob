# Sử dụng Node.js LTS
FROM node:20-alpine

# Tạo thư mục làm việc
WORKDIR /app

# Copy package.json và package-lock.json trước để tối ưu cache
COPY package*.json ./

# Cài dependencies
RUN npm install --production

# Copy toàn bộ source code
COPY . .

# Mặc định chạy app
CMD ["npm", "start"]
