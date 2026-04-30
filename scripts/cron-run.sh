#!/bin/bash
# Runs `npm run once` with a PID guard so concurrent cron invocations are skipped.
PIDFILE=/tmp/rss-feed-fetcher.pid

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "$(date -u +%FT%TZ) Already running (PID $(cat "$PIDFILE")), skipping."
  exit 0
fi

echo $$ > "$PIDFILE"
trap 'rm -f "$PIDFILE"' EXIT

export PATH=/opt/homebrew/bin:/usr/bin:/bin
cd /Users/daniel/Documents/rss_feed_fetcher
npm run once
