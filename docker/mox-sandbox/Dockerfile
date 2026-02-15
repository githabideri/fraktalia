# Mox Sandbox - Custom image with dev tools
# Built from Clawdbot's base sandbox image

FROM clawdbot-sandbox:bookworm-slim

# Install system packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Network tools
    curl \
    wget \
    ca-certificates \
    # Version control
    git \
    # SSH client (for Tailscale endpoints, restricted via TS ACLs)
    openssh-client \
    # Python
    python3 \
    python3-pip \
    python3-venv \
    # Node.js
    nodejs \
    npm \
    # Media processing
    ffmpeg \
    # Manim dependencies (texlive omitted — OOMs during format build; install at runtime if needed)
    libpango1.0-dev \
    pkg-config \
    libcairo2-dev \
    # CLI utilities
    jq \
    ripgrep \
    sqlite3 \
    pandoc \
    # Useful extras
    file \
    unzip \
    sudo \
    && rm -rf /var/lib/apt/lists/*

# Create mox user (UID 996, GID 1100) for docker.user compatibility
# SSH requires a passwd entry for the running UID
RUN groupadd -g 1100 openclaw-agents && \
    useradd -u 996 -g 1100 -d /workspace -s /bin/bash -M mox && \
    echo "mox ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/mox

# Install uv (fast Python package manager)
RUN curl -LsSf https://astral.sh/uv/install.sh | sh

# Add uv to PATH for all users
ENV PATH="/root/.local/bin:/home/mox/.local/bin:$PATH"

# Verify installations
RUN curl --version | head -1 && \
    python3 --version && \
    node --version && \
    uv --version && \
    ffmpeg -version | head -1

# Default workdir
WORKDIR /workspace
