#!/bin/bash

SERVICE_NAME="sorobuild-flow"
APP_DIR="/home/tinkerpal/sorobuild-flow"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

if [ ! -d "$APP_DIR" ]; then
  echo "❌ Error: App directory $APP_DIR does not exist."
  exit 1
fi

echo "🔄 Pulling latest changes..."
cd "$APP_DIR"
git pull origin main || echo "⚠️ Git pull failed or not a git repo, continuing..."

echo "📦 Installing dependencies..."
npm install

echo "🔧 Creating systemd service file at $SERVICE_FILE..."

sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=$SERVICE_NAME

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStartPre=/usr/bin/npm install
ExecStart=/usr/bin/npx --no-install node server/server.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

echo "🔄 Reloading systemd and enabling service..."
sudo systemctl daemon-reload
sudo systemctl enable ${SERVICE_NAME}.service

echo "✅ Systemd service '$SERVICE_NAME' has been created and enabled."
read -p "🚀 Do you want to start the app now? (y/n): " choice

if [[ "$choice" =~ ^[Yy]$ ]]; then
  sudo systemctl start ${SERVICE_NAME}.service
  echo "✅ Service started. You can run: sudo systemctl status ${SERVICE_NAME}.service"
else
  echo "ℹ️ You can start it manually with: sudo systemctl start ${SERVICE_NAME}.service"
fi