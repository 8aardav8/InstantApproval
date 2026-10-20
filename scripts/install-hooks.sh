#!/bin/bash
# Installs the pre-commit guard (lessons L51): every commit is checked for
# Dropbox links and credentials before it can exist. Run once per clone.
set -euo pipefail
cd "$(dirname "$0")/.."
cat > .git/hooks/pre-commit <<'HOOK'
#!/bin/bash
exec python3 scripts/check_no_private_links.py --staged
HOOK
chmod +x .git/hooks/pre-commit
echo "pre-commit guard installed"
