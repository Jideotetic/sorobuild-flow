#!/bin/bash

# --- CONFIGURATION ---
SERVICE_NAME="sorobuild-flow-api"
APP_DIR="/home/tinkerpal/sorobuild-flow-api"
DOCKER_COMPOSE_BIN="/usr/bin/docker compose"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

# --- VALIDATION ---
if [ ! -d "$APP_DIR" ]; then
  echo "❌ Error: Directory $APP_DIR does not exist on this VPS."
  exit 1
fi

# Ensure script is run with root privileges to write to /etc/systemd
if [ "$EUID" -ne 0 ]; then
  echo "❌ Error: Please run this script with sudo: sudo ./vps-setup.sh"
  exit 1
fi

echo "🔄 Navigating to project directory..."
cd "$APP_DIR" || exit 1

# Optional: Uncomment if your VPS uses Git deployment workflow
# echo "📥 Pulling latest code updates..."
# git pull origin main

echo "🔧 Creating/Updating systemd service file..."
tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=Stellar Sorobuild Flow App
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=true
WorkingDirectory=$APP_DIR
ExecStart=$DOCKER_COMPOSE_BIN up -d --build
ExecStop=$DOCKER_COMPOSE_BIN down
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
EOF

echo "🔄 Reloading systemd configurations..."
systemctl daemon-reload
systemctl enable ${SERVICE_NAME}.service
echo "✅ Systemd service '${SERVICE_NAME}' is registered and enabled to start on boot."

# --- START & CLEANUP ---
read -p "🚀 Do you want to build and start the app on port 4307 now? (y/n): " choice
if [[ "$choice" =~ ^[Yy]$ ]]; then
  echo "⏳ Building Docker image and booting containers (this might take a minute)..."
  systemctl start ${SERVICE_NAME}.service
  
  echo "🧼 Cleaning up dangling, leftover build images..."
  docker image prune -f
  
  echo "🎉 Success! App status:"
  systemctl status ${SERVICE_NAME}.service --no-pager -l
else
  echo "ℹ️ Setup finished. Start later using: sudo systemctl start ${SERVICE_NAME}"
fi
