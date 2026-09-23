#!/bin/bash
set -e

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║   ISP Ticketing System - Deployment Script                    ║"
echo "║   Target: n8n host (10.227.227.35)                            ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

TARGET_HOST="10.227.227.35"
DEPLOY_DIR="/home/user/ticketing-system"
SSH_USER="user"
SSH_KEY="${HOME}/.ssh/id_rsa"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}[1/6] Checking SSH connectivity...${NC}"
if ! ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no ${SSH_USER}@${TARGET_HOST} "echo CONNECTED" 2>/dev/null; then
    echo -e "${RED}✗ Cannot reach ${TARGET_HOST}${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Connected to ${TARGET_HOST}${NC}"

echo -e "${YELLOW}[2/6] Creating deployment directory...${NC}"
ssh ${SSH_USER}@${TARGET_HOST} "mkdir -p ${DEPLOY_DIR}"

echo -e "${YELLOW}[3/6] Uploading files...${NC}"
scp -r /home/user/.hermes/deploy/ticketing-system/* ${SSH_USER}@${TARGET_HOST}:${DEPLOY_DIR}/

echo -e "${YELLOW}[4/6] Installing dependencies and starting services...${NC}"
ssh ${SSH_USER}@${TARGET_HOST} "cd ${DEPLOY_DIR} && docker compose up -d"

echo -e "${YELLOW}[5/6] Waiting for services to start...${NC}"
sleep 10

echo -e "${YELLOW}[6/6] Verifying deployment...${NC}"
ssh ${SSH_USER}@${TARGET_HOST} "docker compose ps"

echo ""
echo -e "${GREEN}✓ Deployment complete!${NC}"
echo ""
echo "Access points:"
echo "  Frontend: http://${TARGET_HOST}:9000"
echo "  Backend API: http://${TARGET_HOST}:9001"
echo "  Health check: http://${TARGET_HOST}:9001/health"
echo ""
echo "First login: Register at http://${TARGET_HOST}:9000"
echo ""
echo "Secrets stored in: ${DEPLOY_DIR}/SECRETS.txt"
