#!/bin/bash
MAX_ATTEMPTS=8
attempt=1
interrupted=0

trap 'interrupted=1' SIGINT

while [ $attempt -le $MAX_ATTEMPTS ] && [ $interrupted -eq 0 ]; do
  echo "🔄 Versuch $attempt von $MAX_ATTEMPTS..."
  npx expo start --tunnel --clear
  exit_code=$?

  if [ $interrupted -eq 1 ] || [ $exit_code -eq 130 ]; then
    echo "✅ Beendet."
    break
  fi

  echo "⚠️  Abgebrochen (vermutlich ngrok-Fehler). Neuer Versuch in 2 Sekunden..."
  sleep 2
  attempt=$((attempt + 1))
done
