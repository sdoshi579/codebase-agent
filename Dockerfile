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

# Fail the BUILD, loudly, if graphify isn't actually reachable on PATH --
# rather than discovering that per-user at runtime as a silent, empty-stderr
# failure that looks identical to "graphify ran and rejected this repo."
# `which` finds it; `graphify --version` confirms it actually runs. If this
# step fails, the fix belongs in this Dockerfile (the console script may be
# landing somewhere other than /usr/local/bin depending on the base image's
# pip config), not in application code.
RUN which graphify && graphify --version

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