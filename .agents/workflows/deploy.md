---
description: How to deploy and run AtomicQ
---

# 🚀 Deployment Workflow

Follow these steps to deploy the engine in a production or development environment.

## 1. Local Development Setup
Run the system locally for testing.
```bash
# Install dependencies
npm install

# Build the project
npm run build

# Start the stack using Docker Compose
docker-compose up -d
```

## 2. Production Deployment
// turbo
Deploy to a production server using Docker.
```bash
# Ensure .env is configured correctly
cp .env.example .env

# Build and start services in detached mode
docker-compose up -d --build
```

## 3. Post-Deployment Verification
Check if the system is healthy.
```bash
# Check container status
docker ps

# Verify dashboard health
curl http://localhost:3002/api/health
```

## 4. Scaling Workers
// turbo
Add more workers to handle higher load.
```bash
# Scale to 5 worker replicas
docker-compose up -d --scale worker=5
```
