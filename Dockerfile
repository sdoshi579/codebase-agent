FROM node:20-bookworm-slim

# System deps this app shells out to at runtime (lib/git.ts, lib/git.ts's
# runGraphify): git for cloning, python3/pip for graphifyy. node:*-slim
# images are Debian-based, so apt-get works directly -- a plain node:*-alpine
# image would need a different package manager and doesn't ship python3 by
# default either.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# --break-system-packages: Debian 12's pip refuses global installs by default
# (PEP 668). There's no venv to activate at runtime since graphify is invoked
# via execFile as a bare CLI command (see lib/git.ts), so a global install is
# what's actually needed here, not a workaround to avoid.
RUN pip3 install --no-cache-dir --break-system-packages graphifyy

WORKDIR /app

# Install deps first so this layer only rebuilds when package files change,
# not on every source edit.
COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build

# Render sets $PORT and expects the container to bind to it -- see the
# updated "start" script in package.json (next start -p ${PORT:-3000}).
ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]