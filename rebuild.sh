#!/bin/bash
set -e

echo "=== Rebuilding ISP Ticketing System ==="

# Navigate to project directory
cd "$(dirname "$0")"

# Stop backend
echo "Stopping backend..."
docker-compose stop backend

# Remove old backend container
echo "Removing old container..."
docker rm ticketing-backend 2>/dev/null || true

# Install dependencies in backend
echo "Installing npm dependencies..."
cd backend
npm install --production

# Build TypeScript
echo "Building TypeScript..."
npx tsc

# Return to root and restart
cd ..
echo "Starting backend..."
docker-compose up -d backend

# Wait for health check
echo "Waiting for backend to be ready..."
sleep 5

# Verify
echo ""
echo "=== Verification ==="
curl -s http://10.227.227.35:9001/health | jq . || curl -s http://10.227.227.35:9001/health
echo ""

echo "=== Done ==="
