#!/bin/bash
# Run once with sudo to persist network settings across reboots.
# These settings prevent TCP ephemeral port exhaustion when fetching 2400+ feeds.
set -e

PLIST=/Library/LaunchDaemons/com.rss-feed-fetcher.network.plist

cat > "$PLIST" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.rss-feed-fetcher.network</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>sysctl -w net.inet.tcp.msl=2500 &amp;&amp; sysctl -w net.inet.ip.portrange.first=10000</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
EOF

chmod 644 "$PLIST"
launchctl load "$PLIST"
echo "Network settings applied and will persist across reboots."
echo "  net.inet.tcp.msl=2500         (TIME_WAIT reduced from 30s to 5s)"
echo "  net.inet.ip.portrange.first=10000  (ephemeral port pool expanded to ~55k)"
