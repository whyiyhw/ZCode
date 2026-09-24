const packageDirName = "zcode";

export function installScriptSource(baseUrl) {
  return `#!/usr/bin/env sh
set -eu

BASE_URL="\${ZCODE_DIST_BASE_URL:-${baseUrl}}"
INSTALL_DIR="\${ZCODE_DIST_HOME:-$HOME/.zcode/runtime}"
BIN_DIR="\${ZCODE_DIST_BIN_DIR:-$HOME/.local/bin}"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "zcode install requires $1" >&2
    exit 1
  fi
}

need_cmd node
need_cmd curl
need_cmd tar

LATEST_JSON="$(curl -fsSL "\${BASE_URL%/}/latest.json")"
VERSION="$(printf '%s' "$LATEST_JSON" | node -e "let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>process.stdout.write(JSON.parse(data).version))")"
TARBALL="$(printf '%s' "$LATEST_JSON" | node -e "let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>process.stdout.write(JSON.parse(data).tarball))")"

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

ARCHIVE="$TMP_DIR/$TARBALL"
curl -fL "\${BASE_URL%/}/releases/$VERSION/$TARBALL" -o "$ARCHIVE"

# 社区版供应链基线（PRIVACY-AUDIT.md E3）：解压前必须校验归档哈希，防止下载源劫持或
# 镜像不一致装入任意代码。期望值优先取 latest.json 的 sha256 字段，缺失时回落到
# releases/<version>/sha256.txt 中对应条目。
EXPECTED_SHA256="$(printf '%s' "$LATEST_JSON" | node -e "let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>{const v=JSON.parse(data).sha256;process.stdout.write(typeof v==='string'?v:'')})")"
if [ -z "$EXPECTED_SHA256" ]; then
  curl -fsSL "\${BASE_URL%/}/releases/$VERSION/sha256.txt" -o "$TMP_DIR/sha256.txt"
  EXPECTED_SHA256="$(grep "$TARBALL$" "$TMP_DIR/sha256.txt" | head -n 1 | awk '{print $1}')"
fi
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_SHA256="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
else
  need_cmd shasum
  ACTUAL_SHA256="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
fi
if [ -z "$EXPECTED_SHA256" ] || [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
  echo "sha256 mismatch for $TARBALL (expected \${EXPECTED_SHA256:-<none>}, got \${ACTUAL_SHA256:-<none>}); refusing to install" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR/releases" "$BIN_DIR"
TARGET="$INSTALL_DIR/releases/$VERSION"
rm -rf "$TARGET.new"
mkdir -p "$TARGET.new"
tar -xzf "$ARCHIVE" -C "$TARGET.new"
rm -rf "$TARGET"
mv "$TARGET.new/${packageDirName}" "$TARGET"
rm -rf "$TARGET.new"
ln -sfn "$TARGET" "$INSTALL_DIR/current"

cat > "$BIN_DIR/zcode" <<SH
#!/usr/bin/env sh
exec node "$INSTALL_DIR/current/bin/zcode.mjs" "\\$@"
SH
chmod +x "$BIN_DIR/zcode"

echo "ZCode $VERSION installed."
echo "Run: zcode (TUI) or zcode --web (Web)"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Note: $BIN_DIR is not in PATH." ;;
esac
`;
}
