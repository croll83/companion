#!/bin/bash
# Fix ownership of mounted volumes (they may have been created as root)
chown -R companion:companion /home/companion/.claude 2>/dev/null || true
chown -R companion:companion /workspace 2>/dev/null || true

# Drop privileges and exec the main process as 'companion' user
exec gosu companion "$@"
