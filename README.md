# SoroBuild Flow

> Generate complete Soroban deployment and invocation workflows from a compiled WASM in seconds.

SoroBuild Flow is a developer productivity tool for Stellar Soroban that automatically generates production-ready deployment, initialization, and invocation workflows directly from a compiled smart contract.

Instead of manually writing dozens of deployment scripts every time a contract changes, developers simply upload their compiled WASM and SoroBuild Flow generates an editable workflow that can be downloaded and executed locally.

---

# Features

- Upload compiled Soroban WASM
- Automatic contract inspection
- Detect all exported contract functions
- Generate deployment workflow
- Generate initialization workflow
- Generate invocation scripts
- Generate editable `env.sh`
- Generate editable `arguments.sh`
- Generate executable shell scripts
- Visual workflow builder
- Drag & drop workflow ordering
- Built-in script editor
- Download complete workflow as ZIP
- Browser-local workspaces
- Automatic cleanup of stale workspaces
- MongoDB-powered platform statistics

---

# Why SoroBuild Flow?

Writing a smart contract is only a small part of the development lifecycle.

Developers repeatedly spend time on:

- Deploying contracts
- Initializing contracts
- Invoking methods
- Updating environment variables
- Managing deployment order
- Testing deployment flows
- Regenerating scripts after contract updates

SoroBuild Flow automates this repetitive work.

---

# Generated Structure

A generated workflow looks like:

```text
workflow/

├── flow.selected.sh
├── env.sh
├── arguments.sh
├── contracts.sh
├── README.md
├── socketfi_contract.wasm
│
└── scripts
    ├── build
    ├── deploy.sh
    └── invoke
        ├── initialize.sh
        ├── add_validator.sh
        ├── remove_validator.sh
        └── ...
```

Everything required to execute the workflow is included.

---

# Configuration

Developers only edit two files.

## env.sh

Contains global workflow configuration.

Example:

```bash
export NETWORK="testnet"
export SOURCE="alice"
export STELLAR_CLI="stellar"

export WASM_PATH="$FLOW_ROOT/socketfi_contract.wasm"
```

---

## arguments.sh

Contains all deploy and invocation arguments.

Example:

```bash
export DEPLOY_ADMIN="${SOURCE_ADDRESS}"

export ADD_MANAGER_MANAGER="G..."

export ADD_VALIDATOR_VALIDATOR="..."
```

No generated script needs to be modified.

---

# Running a Workflow

```bash
chmod +x flow.selected.sh

./flow.selected.sh
```

Or execute individual scripts manually.

```bash
./scripts/deploy.sh

./scripts/invoke/add_validator.sh
```

---

# Local First

SoroBuild Flow is intentionally designed as a **local-first** developer tool.

Generated workflows are downloaded and executed locally.

Secrets never need to be uploaded to the hosted service.

This makes the platform suitable for development while avoiding exposing deployment credentials.

---

# Platform

The hosted version provides:

- Workflow generation
- Visual editor
- Script editing
- Browser-local workspaces
- Downloadable workflows
- Usage analytics

Deployment is intentionally performed locally.

---

# Browser Workspaces

Each browser receives a unique anonymous browser ID.

Example:

```
sorobuild_flow_browser_9c3b1a12-fefa...
```

This ID is stored locally.

Workspaces are isolated per browser.

No login is required.

---

# Workspace Cleanup

Workspaces are stored temporarily on the server.

Inactive workspaces are automatically removed after the configured TTL.

Default:

```
24 hours
```

This keeps storage requirements small while allowing users to return shortly after generating a workflow.

---

# Statistics

The platform tracks anonymous usage metrics including:

- Total users
- Active users
- Workflows generated
- Downloads
- WASM uploads
- Generated scripts
- Functions detected

No secrets or deployment credentials are stored.

---

# Project Structure

```text
frontend/
    React
    Vite

server/
    Express API

bin/
    Workflow generator

models/
    MongoDB models

routes/
    API routes

db/
    MongoDB

.storage/
    Temporary generated workflows
```

---

# Requirements

- Node.js 20+
- Stellar CLI
- MongoDB (optional)
- Bash

---

# Development

Install dependencies

```bash
npm install
```

Frontend

```bash
npm run dev:web
```

Backend

```bash
npm run dev:api
```

Or

```bash
npm run dev
```

---

# Production Deployment

Recommended stack:

- Ubuntu 24.04
- Nginx
- Node.js 20
- PM2
- MongoDB Atlas
- Contabo VPS

SoroBuild Flow is designed to run efficiently on a single VPS.

---

# Security

The hosted platform never requires private keys.

Developers execute deployment workflows locally.

Environment variables remain under developer control.

---

# Roadmap

- Authentication
- Team workspaces
- Workflow sharing
- GitHub integration
- Project ZIP import
- Multi-contract dependency visualization
- Contract registry integration
- Workflow templates
- Deployment history
- Visual invocation builder
- Docker execution
- CI/CD export

---

# License

This project is licensed under the Apache License 2.0. See the `LICENSE` file for details.
