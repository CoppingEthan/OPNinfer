# OPNinfer agent image — the Claude Code CLI on top of the sandbox toolchain.
# The Agent SDK harness runs in the app; only this CLI process runs in here,
# attached over stdio through sandboxd (the guard hut stays the only
# Docker-socket holder).
#
#   docker build -t opninfer-agent docker/agent
#
# Build opninfer-sandbox first (docker/sandbox) — this extends it, so the
# agent has the same Python/Node/media/document toolchain the old sandbox
# offered, plus git and ripgrep, which Claude Code leans on.
#
# THE VERSION PIN IS LOAD-BEARING: the SDK and the CLI ship in lockstep
# (@anthropic-ai/claude-agent-sdk 0.3.241 ↔ claude-code 2.1.241) and drift
# between them is undefined behaviour. Bump BOTH together: package.json's SDK
# version and this ARG. The autoupdater is disabled at runtime (env) so a
# running container can never drift from what the image pinned.
ARG CLAUDE_CODE_VERSION=2.1.241

FROM opninfer-sandbox

ARG CLAUDE_CODE_VERSION
USER root
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
    && claude --version
# The ~/.claude mount point must exist IN THE IMAGE owned by uid 1000: docker
# initialises a fresh named volume from the image's directory at the mount
# path, so without this the volume comes up root-owned and the CLI (running
# as sandbox) can never write its login there — sign-in would "succeed" and
# then vanish.
RUN mkdir -p /home/sandbox/.claude && chown -R sandbox:sandbox /home/sandbox

# Back to the sandbox's non-root uid-1000 user. Two reasons it must not be
# root: pool files must stay owned by the app's uid, and the CLI refuses
# permission-skipping modes as root.
USER sandbox

# ~/.claude is a persistent named volume at runtime (mounted by sandboxd over
# the tmpfs home) — the operator's subscription /login lives there and
# survives container recycling. CLAUDE_CONFIG_DIR makes every part of the CLI
# agree on that path.
ENV CLAUDE_CONFIG_DIR=/home/sandbox/.claude \
    DISABLE_AUTOUPDATER=1

WORKDIR /workspace
CMD ["sleep", "infinity"]
