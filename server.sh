#!/bin/bash
# ── AppSphere — Server locale di sviluppo ────────────────────────────────────
# Avvia un server HTTP locale per testare le app senza build step.
# Necessario per i flussi OAuth (redirect_to deve essere un URL valido).
#
# Utilizzo:
#   bash server.sh          → porta 8080 (default)
#   bash server.sh 3000     → porta personalizzata
#
# Dopo l'avvio, aprire: http://localhost:<PORT>/app-launcher.html
# ─────────────────────────────────────────────────────────────────────────────

PORT=${1:-8080}
ROOT="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "  AppSphere Dev Server"
echo "  ───────────────────────────────────────────"
echo "  URL:   http://localhost:${PORT}/app-launcher.html"
echo "  Root:  ${ROOT}"
echo "  Env:   DEV (_IS_DEV = true)"
echo "  ───────────────────────────────────────────"
echo "  Premi Ctrl+C per fermare il server"
echo ""

cd "$ROOT"
python3 -m http.server "$PORT"
